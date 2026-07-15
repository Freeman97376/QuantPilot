from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from quantpilot_market_data.api import create_app
from quantpilot_market_data.data_profiles import get_strategy_data_profile
from quantpilot_market_data.models import FetchMetadata, KlineBar, KlineResponse
from quantpilot_market_data.providers.tushare import TushareClient
from quantpilot_market_data.scheduler import calendar_says_closed, is_cn_market_session
from quantpilot_market_data.services import strategy_refresh

CN_TZ = ZoneInfo("Asia/Shanghai")


def _minute_response(*, cache_status: str = "redis-hit") -> KlineResponse:
    bars = [
        KlineBar(
            date=f"2026-07-14 09:{31 + index:02d}:00",
            open=Decimal("10") + Decimal(index) / 100,
            high=Decimal("10.2") + Decimal(index) / 100,
            low=Decimal("9.9") + Decimal(index) / 100,
            close=Decimal("10.1") + Decimal(index) / 100,
            volume=1000 + index,
            amount=Decimal("1000000") + index,
        )
        for index in range(20)
    ]
    return KlineResponse(
        symbol="600519",
        secid="1.600519",
        market="SH",
        source="eastmoney",
        period="minute1",
        adjustment="none",
        bars=bars,
        fetched_at=datetime.now(UTC),
        fetch=FetchMetadata(
            cache_status=cache_status,  # type: ignore[arg-type]
            cached_at=datetime.now(UTC),
        ),
    )


def test_strategy_profiles_use_expected_windows_and_storage() -> None:
    assert get_strategy_data_profile("minute1_entry").window_bars == 241
    assert get_strategy_data_profile("minute1_momentum").window_bars == 480
    assert get_strategy_data_profile("minute1_pattern").window_bars == 1000
    assert get_strategy_data_profile("minute5_confirm").window_bars == 240
    backtest = get_strategy_data_profile("minute_backtest")
    assert backtest.window_bars == 4800
    assert backtest.storage == "timescaledb-minute"
    assert backtest.paid_only is True


def test_strategy_profile_registry_endpoint() -> None:
    response = TestClient(create_app()).get("/api/v1/ingestion/strategy-profiles")
    assert response.status_code == 200
    profiles = {item["id"]: item for item in response.json()}
    assert profiles["daily_live_5m"]["max_staleness_seconds"] == 420
    assert profiles["minute1_entry"]["storage"] == "redis"
    assert profiles["minute_backtest"]["paid_only"] is True


def test_expected_latest_daily_date_skips_weekend_before_close() -> None:
    monday_morning = datetime(2026, 7, 13, 10, 0, tzinfo=CN_TZ)
    assert strategy_refresh.expected_latest_daily_date(monday_morning).isoformat() == "2026-07-10"
    monday_after_close = datetime(2026, 7, 13, 15, 21, tzinfo=CN_TZ)
    assert (
        strategy_refresh.expected_latest_daily_date(monday_after_close).isoformat()
        == "2026-07-13"
    )


def test_cn_market_session_excludes_lunch_and_weekend() -> None:
    assert is_cn_market_session(datetime(2026, 7, 14, 10, 0, tzinfo=CN_TZ)) is True
    assert is_cn_market_session(datetime(2026, 7, 14, 12, 0, tzinfo=CN_TZ)) is False
    assert is_cn_market_session(datetime(2026, 7, 12, 10, 0, tzinfo=CN_TZ)) is False


def test_explicit_market_calendar_holiday_is_skipped() -> None:
    payload = {
        "days": [
            {
                "trade_date": "2026-10-01",
                "is_open": False,
                "source": "exchange-calendar",
            }
        ]
    }
    assert calendar_says_closed(payload, date(2026, 10, 1)) is True
    assert calendar_says_closed(payload, date(2026, 10, 2)) is False


def test_fresh_intraday_cache_does_not_force_external_refresh(monkeypatch) -> None:
    calls: list[bool] = []

    async def fake_get_history_quote(*args, **kwargs):
        del args
        calls.append(bool(kwargs["refresh"]))
        return _minute_response()

    monkeypatch.setattr(strategy_refresh, "get_history_quote", fake_get_history_quote)
    result = asyncio.run(
        strategy_refresh._refresh_intraday_symbol(
            profile=get_strategy_data_profile("minute1_entry"),
            symbol="600519.SH",
            force=False,
            client=object(),  # type: ignore[arg-type]
            cache=object(),  # type: ignore[arg-type]
            redis_cache=object(),  # type: ignore[arg-type]
            tushare_client=TushareClient(token=""),
            kline_cache_ttl_seconds=1800,
        )
    )
    assert calls == [False]
    assert result.status == "ready"
    assert result.cache_status == "redis-hit"
    assert result.returned_bars == 20


def test_intraday_failure_is_explicitly_unavailable(monkeypatch) -> None:
    async def fake_get_history_quote(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("provider rate limited")

    monkeypatch.setattr(strategy_refresh, "get_history_quote", fake_get_history_quote)
    result = asyncio.run(
        strategy_refresh._refresh_intraday_symbol(
            profile=get_strategy_data_profile("minute5_confirm"),
            symbol="600519.SH",
            force=False,
            client=object(),  # type: ignore[arg-type]
            cache=object(),  # type: ignore[arg-type]
            redis_cache=object(),  # type: ignore[arg-type]
            tushare_client=TushareClient(token=""),
            kline_cache_ttl_seconds=1800,
        )
    )
    assert result.status == "unavailable"
    assert result.period == "minute5"
    assert "动态日K" not in (result.error or "")


def test_paid_realtime_minute_is_only_used_as_enabled_fallback(monkeypatch) -> None:
    async def fake_get_history_quote(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("free provider rate limited")

    class FakeTushareClient:
        configured = True

        async def get_realtime_minutes(self, *args, **kwargs):
            del args, kwargs
            return _minute_response(cache_status="miss").model_copy(
                update={"source": "tushare-realtime"}
            )

    class FakeRedisCache:
        def __init__(self) -> None:
            self.writes = 0

        async def write(self, *args, **kwargs):
            del args, kwargs
            self.writes += 1
            return True

    monkeypatch.setenv("QUANTPILOT_TUSHARE_REALTIME_MINUTE_ENABLED", "1")
    monkeypatch.setattr(strategy_refresh, "get_history_quote", fake_get_history_quote)
    redis_cache = FakeRedisCache()
    result = asyncio.run(
        strategy_refresh._refresh_intraday_symbol(
            profile=get_strategy_data_profile("minute1_entry"),
            symbol="600519.SH",
            force=False,
            client=object(),  # type: ignore[arg-type]
            cache=object(),  # type: ignore[arg-type]
            redis_cache=redis_cache,  # type: ignore[arg-type]
            tushare_client=FakeTushareClient(),  # type: ignore[arg-type]
            kline_cache_ttl_seconds=1800,
        )
    )
    assert result.status == "refreshed"
    assert result.source == "tushare-realtime"
    assert result.cache_status == "miss"
    assert redis_cache.writes == 1
