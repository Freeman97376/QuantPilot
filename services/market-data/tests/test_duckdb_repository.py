from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient

from quantpilot_market_data.api import create_app
from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.repositories.duckdb_repository import (
    DuckDBMarketRepository,
    _minimum_expected_sessions,
)
from quantpilot_market_data.repositories.factory import get_duckdb_repository
from quantpilot_market_data.repositories.protocols import (
    BacktestRepository,
    CoverageRepository,
    IngestionRepository,
    MarketRepository,
    UniverseRepository,
)


def daily_fixture() -> KlineResponse:
    start = date(2026, 1, 2)
    bars = [
        KlineBar(
            date=(start + timedelta(days=index)).isoformat(),
            open=Decimal("10") + Decimal(index) / 10,
            high=Decimal("10.5") + Decimal(index) / 10,
            low=Decimal("9.5") + Decimal(index) / 10,
            close=Decimal("10.2") + Decimal(index) / 10,
            previous_close=Decimal("10.1") + Decimal(index) / 10,
            volume=Decimal(10_000 + index),
            amount=Decimal(1_000_000 + index),
            turnover=Decimal("2.1"),
        )
        for index in range(70)
    ]
    return KlineResponse(
        symbol="600519",
        name="fixture",
        secid="1.600519",
        market="SH",
        source="fixture",
        period="daily",
        adjustment="qfq",
        bars=bars,
        fetched_at=datetime.now(UTC),
    )


def test_minimum_expected_sessions_counts_weekdays_without_daily_iteration() -> None:
    assert _minimum_expected_sessions(date(2026, 7, 18), date(2026, 7, 19)) == 0
    assert _minimum_expected_sessions(date(2026, 7, 17), date(2026, 7, 20)) == 2
    assert _minimum_expected_sessions(date(2024, 1, 1), date(2024, 12, 31)) == 223


def test_duckdb_repository_contracts_and_round_trip(tmp_path) -> None:
    repository = DuckDBMarketRepository(tmp_path / "market.duckdb")
    assert isinstance(repository, MarketRepository)
    assert isinstance(repository, CoverageRepository)
    assert isinstance(repository, UniverseRepository)
    assert isinstance(repository, IngestionRepository)
    assert isinstance(repository, BacktestRepository)

    async def run() -> None:
        await repository.initialize()
        health = await repository.health()
        assert health["status"] == "ok"
        assert health["runtime_mode"] == "desktop"
        assert health["engine"] == "duckdb"
        assert health["schema_version"] == 2
        assert health["database_file"] == "market.duckdb"
        assert health["writable"] is True
        initial_universes = await repository.universe_summaries()
        assert initial_universes[0]["id"] == "a-share-sample-research-pool"
        assert initial_universes[0]["member_count"] == 0
        symbol, written, _, _ = await repository.upsert_kline(
            daily_fixture(),
            universe_id="fixture-universe",
            lookback_years=None,
        )
        assert symbol == "600519.SH"
        assert written == 70
        response = await repository.local_kline_response(
            symbol=symbol,
            timeframe="daily",
            adjustment="qfq",
            provider=None,
            limit=70,
        )
        assert response.summary.row_count == 70
        assert len(response.bars) == 70
        fallback_fixture = daily_fixture().model_copy(
            update={
                "source": "fallback",
                "bars": [
                    bar.model_copy(update={"amount": None})
                    for bar in daily_fixture().bars
                ],
            }
        )
        _, fallback_written, _, _ = await repository.upsert_kline(
            fallback_fixture,
            universe_id="fixture-universe",
            lookback_years=None,
        )
        assert fallback_written == 70
        merged_response = await repository.local_kline_response(
            symbol=symbol,
            timeframe="daily",
            adjustment="qfq",
            provider=None,
            limit=70,
        )
        assert merged_response.bars[0].amount is not None
        assert merged_response.bars[0].metadata["field_sources"]["amount"] == "fixture"
        assert merged_response.bars[0].metadata["field_sources"]["close"] == "fallback"
        assert await repository.universe_symbols("fixture-universe") == [symbol]
        coverage = await repository.coverage(universe_id="fixture-universe")
        assert coverage[0]["row_count"] == 70
        coverage_rows = await repository.coverage_rows(
            universe_id="fixture-universe",
        )
        assert coverage_rows[0]["symbol"] == symbol
        assert coverage_rows[0]["row_count"] == 70
        assert coverage_rows[0]["data_status"] == "partial"
        assert coverage_rows[0]["expected_row_count"] > 70

        summaries = await repository.universe_summaries()
        fixture_summary = next(item for item in summaries if item["id"] == "fixture-universe")
        assert fixture_summary["member_count"] == 1
        assert fixture_summary["ready_count"] == 0
        assert fixture_summary["metadata"]["coverage_counts"]["partial"] == 1

        members, total, total_pages, current_page = await repository.universe_member_rows(
            universe_id="fixture-universe",
            page=1,
            page_size=20,
            keyword="fixture",
            include_inactive=False,
        )
        assert (total, total_pages, current_page) == (1, 1, 1)
        assert members[0]["symbol"] == symbol
        assert members[0]["row_count"] == 70
        assert members[0]["data_status"] == "partial"

        resolved_date, screener_rows = await repository.technical_screener_rows(
            universe_id="fixture-universe",
            trade_date=None,
            timeframe="daily",
            adjustment="qfq",
            min_sample_count=60,
            exclude_st=False,
            exclude_limit_up=False,
        )
        assert resolved_date is not None
        assert len(screener_rows) == 1
        assert screener_rows[0]["sample_count"] == 70

        preflight = await repository.ingestion_preflight(
            symbols=[symbol],
            timeframe="daily",
            adjustment="qfq",
            cutoff=datetime(2026, 1, 1, tzinfo=UTC),
            end_cutoff=None,
            require_fields=["amount", "turnover"],
        )
        assert preflight[symbol]["row_count"] == 70
        assert preflight[symbol]["complete_rows_since_cutoff"] == 70
        assert preflight[symbol]["expected_rows_since_cutoff"] > 70

        await repository.record_provider_attempt(
            provider="baostock",
            capability="history",
            success=False,
            error="fixture failure",
            metadata={"symbol": symbol},
        )
        await repository.record_provider_attempt(
            provider="akshare",
            capability="history-fallback",
            success=True,
            metadata={"symbol": symbol, "bars": 70},
        )
        provider_states = await repository.provider_states()
        baostock_state = next(
            item for item in provider_states if item["provider"] == "baostock"
        )
        akshare_state = next(
            item for item in provider_states if item["provider"] == "akshare"
        )
        assert baostock_state["status"] == "error"
        assert baostock_state["last_error"] == "fixture failure"
        assert akshare_state["status"] == "ready"

        await repository.create_ingestion_job(
            job_id="fixture-job",
            universe_id="fixture-universe",
            provider="baostock-autofill",
            timeframe="daily",
            adjustment="qfq",
            total_symbols=1,
            metadata={"control": "run", "auto_resume": True},
        )
        controlled = await repository.control_ingestion_job(
            job_id="fixture-job",
            control="pause",
            reason="test",
        )
        assert controlled is not None
        assert controlled["metadata"]["control"] == "pause"
        jobs = await repository.list_ingestion_jobs(
            universe_id="fixture-universe",
            limit=10,
        )
        assert jobs[0]["id"] == "fixture-job"
        assert jobs[0]["metadata"]["auto_resume"] is True

    asyncio.run(run())


def test_desktop_readiness_endpoint_reports_duckdb_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_RUNTIME_MODE", "desktop")
    monkeypatch.setenv("QUANTPILOT_STARTUP_TOKEN", "readiness-test-token")
    monkeypatch.setenv("QUANTPILOT_MARKET_DB_PATH", str(tmp_path / "market.duckdb"))
    get_duckdb_repository.cache_clear()
    try:
        with TestClient(create_app()) as client:
            response = client.get(
                "/api/v1/market-data/readiness",
                headers={"X-QuantPilot-Startup-Token": "readiness-test-token"},
            )
        assert response.status_code == 200
        payload = response.json()
        assert payload["runtime_mode"] == "desktop"
        assert payload["engine"] == "duckdb"
        assert payload["storage"]["schema_version"] == 2
        assert payload["storage"]["writable"] is True
        assert payload["coverage"] == {
            "total": 0,
            "missing": 0,
            "partial": 0,
            "stale": 0,
            "ready": 0,
            "row_count": 0,
            "lookback_years": 5,
            "latest_ts": None,
        }
        assert payload["source_policy"]["history_primary"] == "baostock"
        assert payload["source_policy"]["history_fallback"] == "akshare"
    finally:
        get_duckdb_repository.cache_clear()
