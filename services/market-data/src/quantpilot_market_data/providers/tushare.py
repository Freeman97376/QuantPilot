from __future__ import annotations

import asyncio
import math
import os
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from quantpilot_market_data.models import (
    Adjustment,
    DataQuality,
    KlineBar,
    KlinePeriod,
    KlineResponse,
)

CN_TZ = ZoneInfo("Asia/Shanghai")


class TushareError(RuntimeError):
    """Tushare SDK、权限或上游数据错误。"""


class TushareClient:
    """Optional paid Tushare adapter, imported only when a token is configured."""

    id = "tushare"
    name = "Tushare"

    def __init__(self, token: str | None = None) -> None:
        self.token = token if token is not None else os.getenv("TUSHARE_TOKEN", "").strip()

    @property
    def configured(self) -> bool:
        return bool(self.token)

    async def get_kline(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
        allow_fallback: bool = True,
    ) -> KlineResponse:
        del allow_fallback
        if not self.configured:
            raise TushareError("TUSHARE_TOKEN 未配置。")
        return await asyncio.to_thread(
            self._get_kline_sync,
            symbol_or_secid,
            period,
            adjustment,
            limit,
            end,
        )

    async def get_realtime_minutes(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod = "minute1",
        limit: int = 241,
    ) -> KlineResponse:
        if not self.configured:
            raise TushareError("TUSHARE_TOKEN 未配置。")
        if period not in {"minute1", "minute5", "minute15", "minute30", "minute60"}:
            raise TushareError(f"Tushare rt_min 不支持周期：{period}")
        return await asyncio.to_thread(
            self._get_realtime_minutes_sync,
            symbol_or_secid,
            period,
            limit,
        )

    def _get_realtime_minutes_sync(
        self,
        symbol_or_secid: str,
        period: KlinePeriod,
        limit: int,
    ) -> KlineResponse:
        try:
            import tushare as ts
        except ImportError as error:
            raise TushareError(
                "Tushare 适配器未安装；启用前请运行 uv sync --frozen --extra tushare。"
            ) from error

        ts_code = _normalize_ts_code(symbol_or_secid)
        try:
            ts.set_token(self.token)
            pro = ts.pro_api(self.token)
            frame = pro.rt_min(
                ts_code=ts_code,
                freq=_period_to_tushare_frequency(period).upper(),
            )
        except Exception as error:
            raise TushareError(f"Tushare 实时分钟请求失败：{error}") from error
        if frame is None or getattr(frame, "empty", True):
            raise TushareError(f"Tushare rt_min 未返回 {ts_code} 的 {period} 数据。")

        records = frame.to_dict(orient="records")
        records.sort(key=lambda item: str(item.get("time") or ""))
        bars = [_bar_from_record(record, date_field="time") for record in records[-limit:]]
        bars = [bar for bar in bars if bar.open is not None and bar.close is not None]
        if not bars:
            raise TushareError(f"Tushare rt_min 返回了 {ts_code}，但没有可用 OHLC 数据。")
        market = ts_code.rsplit(".", 1)[-1]
        code = ts_code.split(".", 1)[0]
        return KlineResponse(
            symbol=code,
            secid=f"{1 if market == 'SH' else 0}.{code}",
            market=market if market in {"SH", "SZ", "BJ"} else "UNKNOWN",
            source="tushare-realtime",
            period=period,
            adjustment="none",
            bars=bars,
            fetched_at=datetime.now(CN_TZ),
            metadata={
                "ts_code": ts_code,
                "paid_provider": True,
                "provider_mode": "realtime-minute",
                "sdk_api": "rt_min",
            },
            data_quality=DataQuality(
                status="warning",
                missing_fields=["turnover"],
                warnings=["Tushare 实时分钟数据不提供换手率；相关条件必须跳过空值。"],
            ),
        )

    def _get_kline_sync(
        self,
        symbol_or_secid: str,
        period: KlinePeriod,
        adjustment: Adjustment,
        limit: int,
        end: str,
    ) -> KlineResponse:
        try:
            import tushare as ts
        except ImportError as error:
            raise TushareError(
                "Tushare 适配器未安装；启用前请运行 uv sync --frozen --extra tushare。"
            ) from error

        ts_code = _normalize_ts_code(symbol_or_secid)
        now = datetime.now(CN_TZ)
        requested_limit = max(1, min(limit, 8_000))
        is_minute = period.startswith("minute")
        end_at = _parse_end(end, now)
        if is_minute:
            calendar_days = max(7, math.ceil(requested_limit / 240) * 3 + 5)
            start_at = end_at - timedelta(days=calendar_days)
            start_value = start_at.strftime("%Y-%m-%d 09:00:00")
            end_value = end_at.strftime("%Y-%m-%d 17:00:00")
        else:
            calendar_days = max(30, math.ceil(requested_limit * 1.7) + 20)
            start_at = end_at - timedelta(days=calendar_days)
            start_value = start_at.strftime("%Y%m%d")
            end_value = end_at.strftime("%Y%m%d")

        try:
            ts.set_token(self.token)
            frame = ts.pro_bar(
                ts_code=ts_code,
                asset="E",
                adj=None if adjustment == "none" else adjustment,
                freq=_period_to_tushare_frequency(period),
                start_date=start_value,
                end_date=end_value,
            )
        except Exception as error:  # SDK surfaces provider and permission errors generically.
            raise TushareError(f"Tushare K线请求失败：{error}") from error

        if frame is None or getattr(frame, "empty", True):
            raise TushareError(f"Tushare 未返回 {ts_code} 的 {period} 数据。")

        date_field = "trade_time" if is_minute else "trade_date"
        records = frame.to_dict(orient="records")
        records.sort(key=lambda item: str(item.get(date_field) or item.get("time") or ""))
        selected = records[-requested_limit:]
        bars = [_bar_from_record(record, date_field=date_field) for record in selected]
        bars = [bar for bar in bars if bar.open is not None and bar.close is not None]
        if not bars:
            raise TushareError(f"Tushare 返回了 {ts_code}，但没有可用 OHLC 数据。")

        market = ts_code.rsplit(".", 1)[-1]
        code = ts_code.split(".", 1)[0]
        secid = f"{1 if market == 'SH' else 0}.{code}"
        missing_fields = ["turnover"] if is_minute else []
        return KlineResponse(
            symbol=code,
            secid=secid,
            market=market if market in {"SH", "SZ", "BJ"} else "UNKNOWN",
            source="tushare",
            period=period,
            adjustment=adjustment,
            bars=bars,
            fetched_at=datetime.now(CN_TZ),
            metadata={
                "ts_code": ts_code,
                "paid_provider": True,
                "provider_mode": "historical-minute" if is_minute else "daily",
            },
            data_quality=DataQuality(
                status="warning" if missing_fields else "ok",
                missing_fields=missing_fields,
                warnings=(
                    ["Tushare 历史分钟数据不提供换手率；相关条件必须跳过空值。"]
                    if is_minute
                    else []
                ),
            ),
        )


def _normalize_ts_code(value: str) -> str:
    normalized = value.strip().upper()
    if normalized.startswith(("0.", "1.")) and normalized[2:].isdigit():
        code = normalized[2:]
        return f"{code}.{'SH' if normalized.startswith('1.') else 'SZ'}"
    if len(normalized) == 9 and normalized[:6].isdigit() and normalized[6] == ".":
        return normalized
    if normalized.isdigit() and len(normalized) == 6:
        if normalized.startswith(("5", "6", "9")):
            suffix = "SH"
        elif normalized.startswith(("4", "8")):
            suffix = "BJ"
        else:
            suffix = "SZ"
        return f"{normalized}.{suffix}"
    raise TushareError(f"无法规范化 Tushare 股票代码：{value}")


def _period_to_tushare_frequency(period: KlinePeriod) -> str:
    return {
        "daily": "D",
        "weekly": "W",
        "monthly": "M",
        "minute1": "1min",
        "minute5": "5min",
        "minute15": "15min",
        "minute30": "30min",
        "minute60": "60min",
    }[period]


def _parse_end(value: str, fallback: datetime) -> datetime:
    normalized = value.strip()
    if normalized in {"", "20500101"}:
        return fallback
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(normalized, fmt).replace(tzinfo=CN_TZ)
        except ValueError:
            continue
    return fallback


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _integer(value: Any) -> int | None:
    decimal = _decimal(value)
    return int(decimal) if decimal is not None else None


def _bar_from_record(record: dict[str, Any], *, date_field: str) -> KlineBar:
    raw_date = record.get(date_field) or record.get("time")
    if isinstance(raw_date, datetime):
        date_value = raw_date.strftime("%Y-%m-%d %H:%M:%S")
    else:
        date_value = str(raw_date)
        if len(date_value) == 8 and date_value.isdigit():
            date_value = f"{date_value[:4]}-{date_value[4:6]}-{date_value[6:]}"
    return KlineBar(
        date=date_value,
        open=_decimal(record.get("open")),
        close=_decimal(record.get("close")),
        high=_decimal(record.get("high")),
        low=_decimal(record.get("low")),
        previous_close=_decimal(record.get("pre_close")),
        volume=_integer(record.get("vol") or record.get("volume")),
        amount=_decimal(record.get("amount")),
        change_percent=_decimal(record.get("pct_chg")),
        change_amount=_decimal(record.get("change")),
        metadata={"source": "tushare"},
    )
