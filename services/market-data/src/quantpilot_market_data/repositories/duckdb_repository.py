from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import threading
from collections import defaultdict
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from functools import wraps
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb

from quantpilot_market_data.database_core import (
    DatabaseError,
    canonical_symbol,
    date_cutoff_datetime,
    lookback_cutoff_datetime,
    parse_bar_datetime,
)
from quantpilot_market_data.indicators import build_technical_feature_rows
from quantpilot_market_data.models import LocalKlineBar, LocalKlineResponse, LocalKlineSummary

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
DESKTOP_COVERAGE_LOOKBACK_YEARS = 5
DESKTOP_COVERAGE_MIN_RATIO = 0.85
DESKTOP_COVERAGE_MAX_LAG_DAYS = 4


def _serialized_duckdb_method(method: Any) -> Any:
    """Run synchronous DuckDB work on the repository's single worker."""

    @wraps(method)
    async def wrapped(
        self: DuckDBMarketRepository,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        if self._closed:
            raise RuntimeError("DuckDB repository is closed.")
        if threading.get_ident() == self._worker_thread_id:
            return await method(self, *args, **kwargs)

        async with self._worker_lock:
            if self._closed:
                raise RuntimeError("DuckDB repository is closed.")
            loop = asyncio.get_running_loop()

            def invoke() -> Any:
                self._worker_thread_id = threading.get_ident()
                return asyncio.run(method(self, *args, **kwargs))

            return await loop.run_in_executor(self._worker_executor, invoke)

    return wrapped


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _json_array(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _dict_rows(cursor: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]


def _aware_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _catalog_listing_date(metadata: Any) -> date | None:
    payload = _json_object(metadata)
    raw = payload.get("listing_date")
    if raw is None and isinstance(payload.get("raw"), dict):
        raw = payload["raw"].get("f26")
    text = str(raw or "").strip().replace("-", "")
    if len(text) != 8 or not text.isdigit() or text == "00000000":
        return None
    try:
        return date(int(text[:4]), int(text[4:6]), int(text[6:8]))
    except ValueError:
        return None


def _expected_latest_daily_date(now: datetime | None = None) -> date:
    current = (now or datetime.now(SHANGHAI_TZ)).astimezone(SHANGHAI_TZ)
    candidate = current.date()
    if current.weekday() < 5 and (current.hour, current.minute) < (15, 20):
        candidate -= timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def _lookback_start_date(target_date: date, years: int) -> date:
    try:
        return target_date.replace(year=target_date.year - years)
    except ValueError:
        return target_date.replace(year=target_date.year - years, day=28)


def _minimum_expected_sessions(start_date: date, end_date: date) -> int:
    if start_date > end_date:
        return 0
    total_days = (end_date - start_date).days + 1
    full_weeks, remaining_days = divmod(total_days, 7)
    weekdays = full_weeks * 5
    weekdays += sum(
        1
        for offset in range(remaining_days)
        if (start_date.weekday() + offset) % 7 < 5
    )
    return math.ceil(weekdays * DESKTOP_COVERAGE_MIN_RATIO)


def _desktop_coverage_status(row: dict[str, Any]) -> str:
    row_count = int(row.get("row_count") or 0)
    if row_count <= 0 or row.get("last_ts") is None:
        row["expected_row_count"] = int(row.get("expected_row_count") or 0)
        row["coverage_ratio"] = 0.0
        return "missing"

    target_date = _expected_latest_daily_date()
    start_date = _lookback_start_date(target_date, DESKTOP_COVERAGE_LOOKBACK_YEARS)
    listing_date = _catalog_listing_date(row.get("security_metadata"))
    if listing_date and listing_date > start_date:
        start_date = listing_date
    expected_rows = _minimum_expected_sessions(start_date, target_date)
    row["expected_row_count"] = expected_rows
    row["coverage_ratio"] = round(min(1.0, row_count / max(1, expected_rows)), 4)
    if row_count < expected_rows:
        return "partial"

    last_ts = _aware_datetime(row.get("last_ts"))
    if last_ts is None:
        return "missing"
    last_date = last_ts.astimezone(SHANGHAI_TZ).date()
    if (target_date - last_date).days > DESKTOP_COVERAGE_MAX_LAG_DAYS:
        return "stale"
    return "ready"


class DuckDBMarketRepository:
    """Desktop implementation for durable market data and job state."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self._lock = threading.RLock()
        self._worker_lock = asyncio.Lock()
        self._worker_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="quantpilot-duckdb",
        )
        self._worker_thread_id: int | None = None
        self._closed = False
        self._initialized = False

    @classmethod
    def from_environment(cls) -> DuckDBMarketRepository:
        raw = os.getenv("QUANTPILOT_MARKET_DB_PATH", "").strip()
        if not raw:
            raise RuntimeError("QUANTPILOT_MARKET_DB_PATH is required in desktop mode.")
        return cls(Path(raw).expanduser().resolve())

    def _connect(self) -> duckdb.DuckDBPyConnection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        return duckdb.connect(str(self.database_path))

    @_serialized_duckdb_method
    async def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return
            connection = self._connect()
            try:
                connection.execute("CREATE SCHEMA IF NOT EXISTS quant")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS quant.market_schema_version (
                      version INTEGER PRIMARY KEY,
                      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS quant.securities (
                      symbol VARCHAR PRIMARY KEY, code VARCHAR NOT NULL, name VARCHAR,
                      exchange VARCHAR, asset_type VARCHAR NOT NULL DEFAULT 'stock',
                      currency VARCHAR, timezone VARCHAR, secid VARCHAR, provider VARCHAR,
                      status VARCHAR NOT NULL DEFAULT 'active', metadata JSON NOT NULL DEFAULT '{}',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS quant.stock_bars (
                      symbol VARCHAR NOT NULL, ts TIMESTAMPTZ NOT NULL, timeframe VARCHAR NOT NULL,
                      adjustment VARCHAR NOT NULL, open DECIMAL(24,8), high DECIMAL(24,8),
                      low DECIMAL(24,8), close DECIMAL(24,8), previous_close DECIMAL(24,8),
                      volume DECIMAL(30,4), amount DECIMAL(30,4), amplitude DECIMAL(18,8),
                      change_percent DECIMAL(18,8), change_amount DECIMAL(24,8),
                      turnover DECIMAL(18,8), trade_status VARCHAR, is_st BOOLEAN,
                      limit_up BOOLEAN, limit_down BOOLEAN, provider VARCHAR NOT NULL,
                      metadata JSON NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      PRIMARY KEY(symbol, timeframe, adjustment, ts)
                    );
                    CREATE TABLE IF NOT EXISTS quant.security_universes (
                      id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, description VARCHAR,
                      status VARCHAR NOT NULL DEFAULT 'active', tags JSON NOT NULL DEFAULT '[]',
                      metadata JSON NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS quant.security_universe_members (
                      universe_id VARCHAR NOT NULL, symbol VARCHAR NOT NULL,
                      role VARCHAR NOT NULL DEFAULT 'member', metadata JSON NOT NULL DEFAULT '{}',
                      added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(universe_id, symbol)
                    );
                    CREATE TABLE IF NOT EXISTS quant.market_data_sync_state (
                      symbol VARCHAR NOT NULL, timeframe VARCHAR NOT NULL, adjustment VARCHAR NOT NULL,
                      provider VARCHAR NOT NULL, first_ts TIMESTAMPTZ, last_ts TIMESTAMPTZ,
                      row_count INTEGER NOT NULL DEFAULT 0, last_success_at TIMESTAMPTZ,
                      last_error VARCHAR, metadata JSON NOT NULL DEFAULT '{}',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      PRIMARY KEY(symbol, timeframe, adjustment, provider)
                    );
                    CREATE TABLE IF NOT EXISTS quant.market_data_provider_state (
                      provider VARCHAR NOT NULL, capability VARCHAR NOT NULL,
                      status VARCHAR NOT NULL DEFAULT 'unknown',
                      success_count BIGINT NOT NULL DEFAULT 0,
                      failure_count BIGINT NOT NULL DEFAULT 0,
                      last_success_at TIMESTAMPTZ, last_failure_at TIMESTAMPTZ,
                      last_error VARCHAR, metadata JSON NOT NULL DEFAULT '{}',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      PRIMARY KEY(provider, capability)
                    );
                    CREATE TABLE IF NOT EXISTS quant.market_data_ingestion_jobs (
                      id VARCHAR PRIMARY KEY, universe_id VARCHAR, provider VARCHAR, timeframe VARCHAR,
                      adjustment VARCHAR, status VARCHAR NOT NULL, total_symbols INTEGER NOT NULL DEFAULT 0,
                      completed_symbols INTEGER NOT NULL DEFAULT 0, failed_symbols INTEGER NOT NULL DEFAULT 0,
                      rows_received BIGINT NOT NULL DEFAULT 0, rows_upserted BIGINT NOT NULL DEFAULT 0,
                      error VARCHAR, metadata JSON NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ,
                      completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS quant.backtest_runs (
                      id VARCHAR PRIMARY KEY, strategy_id VARCHAR, status VARCHAR NOT NULL,
                      parameters JSON NOT NULL DEFAULT '{}', metrics JSON NOT NULL DEFAULT '{}',
                      metadata JSON NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ,
                      completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS quant.backtest_orders (
                      id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL, symbol VARCHAR NOT NULL,
                      ts TIMESTAMPTZ NOT NULL, side VARCHAR NOT NULL, quantity DECIMAL(30,8),
                      price DECIMAL(24,8), fee DECIMAL(24,8), metadata JSON NOT NULL DEFAULT '{}',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    """
                )
                connection.execute(
                    "INSERT INTO quant.market_schema_version VALUES (1, now()), (2, now()) ON CONFLICT DO NOTHING"
                )
                connection.execute(
                    """
                    INSERT INTO quant.security_universes
                      (id, name, description, tags, metadata)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    [
                        "a-share-sample-research-pool",
                        "全 A 股股票池",
                        "桌面端真实 A 股标的目录；首次进入智能策略页后从东方财富导入。",
                        json.dumps(["a-share", "desktop", "full-market"], ensure_ascii=False),
                        json.dumps(
                            {
                                "provider": "baostock",
                                "source": "eastmoney",
                                "default_timeframe": "daily",
                                "default_adjustment": "qfq",
                                "catalog_status": "empty",
                            },
                            ensure_ascii=False,
                        ),
                    ],
                )
            finally:
                connection.close()
            self._initialized = True

    @_serialized_duckdb_method
    async def record_provider_attempt(
        self,
        *,
        provider: str,
        capability: str,
        success: bool,
        error: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                connection.execute(
                    """
                    INSERT INTO quant.market_data_provider_state
                      (provider, capability, status, success_count, failure_count,
                       last_success_at, last_failure_at, last_error, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(provider, capability) DO UPDATE SET
                      status=excluded.status,
                      success_count=quant.market_data_provider_state.success_count
                        + excluded.success_count,
                      failure_count=quant.market_data_provider_state.failure_count
                        + excluded.failure_count,
                      last_success_at=coalesce(
                        excluded.last_success_at,
                        quant.market_data_provider_state.last_success_at
                      ),
                      last_failure_at=coalesce(
                        excluded.last_failure_at,
                        quant.market_data_provider_state.last_failure_at
                      ),
                      last_error=CASE
                        WHEN excluded.last_success_at IS NOT NULL THEN NULL
                        ELSE excluded.last_error
                      END,
                      metadata=excluded.metadata,
                      updated_at=now()
                    """,
                    [
                        provider,
                        capability,
                        "ready" if success else "error",
                        1 if success else 0,
                        0 if success else 1,
                        datetime.now(UTC) if success else None,
                        None if success else datetime.now(UTC),
                        None if success else error,
                        json.dumps(metadata or {}, ensure_ascii=False, default=str),
                    ],
                )
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def provider_states(self) -> list[dict[str, Any]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                rows = _dict_rows(
                    connection.execute(
                        """
                        WITH bar_stats AS (
                          SELECT provider, count(*) AS row_count,
                            count(DISTINCT symbol) AS symbol_count,
                            min(ts) AS first_ts, max(ts) AS last_ts
                          FROM quant.stock_bars
                          GROUP BY provider
                        )
                        SELECT COALESCE(state.provider, stats.provider) AS provider,
                          COALESCE(state.capability, 'history') AS capability,
                          COALESCE(
                            state.status,
                            CASE WHEN stats.row_count > 0 THEN 'ready' ELSE 'unknown' END
                          ) AS status,
                          COALESCE(state.success_count, 0) AS success_count,
                          COALESCE(state.failure_count, 0) AS failure_count,
                          state.last_success_at, state.last_failure_at, state.last_error,
                          COALESCE(state.metadata, '{}') AS metadata,
                          state.created_at, state.updated_at,
                          COALESCE(stats.row_count, 0) AS row_count,
                          COALESCE(stats.symbol_count, 0) AS symbol_count,
                          stats.first_ts, stats.last_ts
                        FROM quant.market_data_provider_state state
                        FULL OUTER JOIN bar_stats stats USING(provider)
                        ORDER BY provider, capability
                        """
                    )
                )
            finally:
                connection.close()
        for row in rows:
            row["metadata"] = _json_object(row.get("metadata"))
        return rows

    @_serialized_duckdb_method
    async def health(self) -> dict[str, Any]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                version = connection.execute(
                    "SELECT max(version) FROM quant.market_schema_version"
                ).fetchone()[0]
            finally:
                connection.close()
        disk = shutil.disk_usage(self.database_path.parent)
        return {
            "status": "ok",
            "runtime_mode": "desktop",
            "engine": "duckdb",
            "schema_version": int(version or 0),
            "database_file": self.database_path.name,
            "database_size_bytes": (
                self.database_path.stat().st_size if self.database_path.exists() else 0
            ),
            "free_disk_bytes": disk.free,
            "writable": os.access(self.database_path.parent, os.W_OK),
        }

    @_serialized_duckdb_method
    async def upsert_kline(
        self,
        kline: Any,
        *,
        universe_id: str | None,
        lookback_years: int | None = 5,
        start: str | None = None,
        end: str | None = None,
    ) -> tuple[str, int, str | None, str | None]:
        await self.initialize()
        symbol = canonical_symbol(kline.symbol, kline.market)
        cutoff = date_cutoff_datetime(start) or lookback_cutoff_datetime(lookback_years)
        end_cutoff = date_cutoff_datetime(end)
        rows: list[tuple[Any, ...]] = []
        first_date: str | None = None
        last_date: str | None = None
        for bar in kline.bars:
            if None in (bar.open, bar.high, bar.low, bar.close):
                continue
            ts = parse_bar_datetime(bar.date)
            if (cutoff and ts < cutoff) or (end_cutoff and ts > end_cutoff):
                continue
            first_date = first_date or bar.date
            last_date = bar.date
            metadata = {
                "secid": kline.secid, "name": kline.name, "market": kline.market,
                "asset_type": kline.asset_type, "source": kline.source,
                "source_bar": bar.metadata, "response_metadata": kline.metadata,
                "field_sources": {
                    field: kline.source
                    for field in (
                        "open", "high", "low", "close", "previous_close", "volume",
                        "amount", "amplitude", "change_percent", "change_amount",
                        "turnover", "trade_status", "is_st", "limit_up", "limit_down",
                    )
                    if getattr(bar, field) is not None
                },
                "universe_id": universe_id,
            }
            rows.append((
                symbol, ts, kline.period, kline.adjustment, bar.open, bar.high, bar.low,
                bar.close, bar.previous_close, bar.volume or 0, bar.amount, bar.amplitude,
                bar.change_percent, bar.change_amount, bar.turnover, bar.trade_status,
                bar.is_st, bar.limit_up, bar.limit_down, kline.source,
                json.dumps(metadata, ensure_ascii=False, default=str),
            ))
        if not rows:
            return symbol, 0, first_date, last_date
        await self.ensure_disk_capacity(len(rows) * 512)
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN TRANSACTION")
                connection.execute(
                    """
                    INSERT INTO quant.securities
                      (symbol, code, name, exchange, asset_type, currency, timezone, secid, provider, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, exchange=excluded.exchange,
                      provider=excluded.provider,
                      metadata=json_merge_patch(quant.securities.metadata, excluded.metadata),
                      updated_at=now()
                    """,
                    [symbol, kline.symbol, kline.name, kline.market, kline.asset_type,
                     kline.currency, kline.timezone, kline.secid, kline.source,
                     json.dumps({"source": kline.source}, ensure_ascii=False)],
                )
                connection.executemany(
                    """
                    INSERT INTO quant.stock_bars VALUES
                      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
                    ON CONFLICT(symbol, timeframe, adjustment, ts) DO UPDATE SET
                      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                      previous_close=coalesce(excluded.previous_close, quant.stock_bars.previous_close),
                      volume=excluded.volume, amount=coalesce(excluded.amount, quant.stock_bars.amount),
                      amplitude=coalesce(excluded.amplitude, quant.stock_bars.amplitude),
                      change_percent=coalesce(excluded.change_percent, quant.stock_bars.change_percent),
                      change_amount=coalesce(excluded.change_amount, quant.stock_bars.change_amount),
                      turnover=coalesce(excluded.turnover, quant.stock_bars.turnover),
                      trade_status=coalesce(excluded.trade_status, quant.stock_bars.trade_status),
                      is_st=coalesce(excluded.is_st, quant.stock_bars.is_st),
                      limit_up=coalesce(excluded.limit_up, quant.stock_bars.limit_up),
                      limit_down=coalesce(excluded.limit_down, quant.stock_bars.limit_down),
                      provider=excluded.provider,
                      metadata=json_merge_patch(quant.stock_bars.metadata, excluded.metadata)
                    """,
                    rows,
                )
                if universe_id:
                    connection.execute(
                        "INSERT INTO quant.security_universes (id, name, metadata) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                        [
                            universe_id,
                            universe_id,
                            json.dumps(
                                {
                                    "default_timeframe": "daily",
                                    "default_adjustment": "qfq",
                                    "provider": "baostock",
                                    "source": "local-market-data",
                                }
                            ),
                        ],
                    )
                    connection.execute(
                        "INSERT INTO quant.security_universe_members (universe_id, symbol) VALUES (?, ?) ON CONFLICT DO NOTHING",
                        [universe_id, symbol],
                    )
                connection.execute(
                    """
                    INSERT INTO quant.market_data_sync_state
                    SELECT ?, ?, ?, ?, min(ts), max(ts), count(*), now(), NULL, ?, now(), now()
                    FROM quant.stock_bars WHERE symbol=? AND timeframe=? AND adjustment=? AND provider=?
                    ON CONFLICT(symbol, timeframe, adjustment, provider) DO UPDATE SET
                      first_ts=excluded.first_ts, last_ts=excluded.last_ts, row_count=excluded.row_count,
                      last_success_at=now(), last_error=NULL, metadata=excluded.metadata, updated_at=now()
                    """,
                    [symbol, kline.period, kline.adjustment, kline.source,
                     json.dumps({"name": kline.name, "universe_id": universe_id}),
                     symbol, kline.period, kline.adjustment, kline.source],
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()
        return symbol, len(rows), first_date, last_date

    @_serialized_duckdb_method
    async def local_kline_rows(
        self, *, symbol: str, timeframe: str, adjustment: str, provider: str | None, limit: int
    ) -> list[dict[str, Any]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                cursor = connection.execute(
                    """
                    SELECT bars.*, bars.provider AS data_provider, bars.metadata AS bar_metadata,
                      count(*) OVER () AS coverage_row_count, min(ts) OVER () AS coverage_first_ts,
                      max(ts) OVER () AS coverage_last_ts, securities.code, securities.name,
                      securities.exchange, securities.asset_type, securities.currency,
                      securities.timezone, securities.secid, securities.provider
                    FROM quant.stock_bars bars LEFT JOIN quant.securities securities USING(symbol)
                    WHERE bars.symbol=? AND bars.timeframe=? AND bars.adjustment=?
                      AND (? IS NULL OR bars.provider=?) ORDER BY bars.ts DESC LIMIT ?
                    """,
                    [symbol, timeframe, adjustment, provider, provider, limit],
                )
                columns = [item[0] for item in cursor.description]
                rows = [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
                rows.reverse()
                return rows
            finally:
                connection.close()

    async def local_kline_response(
        self, *, symbol: str, timeframe: str, adjustment: str, provider: str | None, limit: int
    ) -> LocalKlineResponse:
        rows = await self.local_kline_rows(
            symbol=symbol,
            timeframe=timeframe,
            adjustment=adjustment,
            provider=provider,
            limit=limit,
        )
        if not rows:
            return LocalKlineResponse(
                symbol=symbol,
                timeframe=timeframe,
                adjustment=adjustment,
                bars=[],
                summary=LocalKlineSummary(),
            )
        bars: list[LocalKlineBar] = []
        for row in rows:
            metadata = row.get("bar_metadata")
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except json.JSONDecodeError:
                    metadata = {}
            bars.append(LocalKlineBar(
                ts=row["ts"], open=row["open"], high=row["high"], low=row["low"],
                close=row["close"], previous_close=row.get("previous_close"),
                volume=row["volume"], amount=row.get("amount"), amplitude=row.get("amplitude"),
                change_percent=row.get("change_percent"), change_amount=row.get("change_amount"),
                turnover=row.get("turnover"), trade_status=row.get("trade_status"),
                is_st=row.get("is_st"), limit_up=row.get("limit_up"), limit_down=row.get("limit_down"),
                provider=row.get("data_provider") or row.get("provider") or "duckdb",
                metadata=metadata if isinstance(metadata, dict) else {},
            ))
        amounts = [bar.amount for bar in bars if bar.amount is not None]
        first_close = bars[0].previous_close or bars[0].close
        latest_close = bars[-1].close
        return_pct = ((latest_close / first_close) - Decimal("1")) * Decimal("100") if first_close else None
        return LocalKlineResponse(
            symbol=str(rows[0]["symbol"]),
            code=rows[0].get("code"),
            name=rows[0].get("name"),
            exchange=rows[0].get("exchange") or "UNKNOWN",
            asset_type=rows[0].get("asset_type") or "stock",
            currency=rows[0].get("currency") or "CNY",
            timezone=rows[0].get("timezone") or "Asia/Shanghai",
            secid=rows[0].get("secid"),
            provider=bars[-1].provider,
            timeframe=timeframe,
            adjustment=adjustment,
            bars=bars,
            summary=LocalKlineSummary(
                row_count=int(rows[0].get("coverage_row_count") or len(bars)),
                first_ts=rows[0].get("coverage_first_ts") or bars[0].ts,
                last_ts=rows[0].get("coverage_last_ts") or bars[-1].ts,
                latest_close=latest_close,
                previous_close=bars[-1].previous_close,
                return_pct=return_pct,
                high=max(bar.high for bar in bars),
                low=min(bar.low for bar in bars),
                total_volume=sum((bar.volume for bar in bars), Decimal("0")),
                total_amount=sum(amounts, Decimal("0")) if amounts else None,
            ),
        )

    @_serialized_duckdb_method
    async def coverage(self, *, universe_id: str | None = None) -> list[dict[str, Any]]:
        await self.initialize()
        query = "SELECT * FROM quant.market_data_sync_state"
        params: list[Any] = []
        if universe_id:
            query += " WHERE symbol IN (SELECT symbol FROM quant.security_universe_members WHERE universe_id=?)"
            params.append(universe_id)
        with self._lock:
            connection = self._connect()
            try:
                cursor = connection.execute(query, params)
                columns = [item[0] for item in cursor.description]
                return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def coverage_rows(
        self,
        *,
        universe_id: str | None,
        include_inactive: bool = False,
    ) -> list[dict[str, Any]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                if universe_id:
                    cursor = connection.execute(
                        """
                        WITH targets AS (
                          SELECT
                            members.symbol,
                            securities.name,
                            securities.metadata AS security_metadata,
                            COALESCE(
                              json_extract_string(universes.metadata, '$.default_timeframe'),
                              'daily'
                            ) AS timeframe,
                            COALESCE(
                              json_extract_string(universes.metadata, '$.default_adjustment'),
                              'qfq'
                            ) AS adjustment,
                            COALESCE(
                              json_extract_string(universes.metadata, '$.provider'),
                              'baostock'
                            ) AS default_provider
                          FROM quant.security_universe_members members
                          JOIN quant.security_universes universes
                            ON universes.id=members.universe_id
                          JOIN quant.securities securities
                            ON securities.symbol=members.symbol
                          WHERE members.universe_id=?
                            AND (
                              ?
                              OR (
                                members.role <> 'inactive'
                                AND securities.status NOT IN ('inactive', 'delisted')
                              )
                            )
                        ),
                        bar_coverage AS (
                          SELECT
                            bars.symbol, bars.timeframe, bars.adjustment,
                            count(*) AS row_count, min(bars.ts) AS first_ts,
                            max(bars.ts) AS last_ts, arg_max(bars.provider, bars.ts) AS provider
                          FROM quant.stock_bars bars
                          JOIN targets
                            ON targets.symbol=bars.symbol
                           AND targets.timeframe=bars.timeframe
                           AND targets.adjustment=bars.adjustment
                          GROUP BY bars.symbol, bars.timeframe, bars.adjustment
                        ),
                        sync_coverage AS (
                          SELECT sync_state.symbol, sync_state.timeframe,
                            sync_state.adjustment, max(sync_state.last_success_at) AS last_success_at
                          FROM quant.market_data_sync_state sync_state
                          JOIN targets
                            ON targets.symbol=sync_state.symbol
                           AND targets.timeframe=sync_state.timeframe
                           AND targets.adjustment=sync_state.adjustment
                          GROUP BY sync_state.symbol, sync_state.timeframe, sync_state.adjustment
                        )
                        SELECT targets.symbol, targets.name, targets.security_metadata,
                          targets.timeframe, targets.adjustment,
                          COALESCE(bar_coverage.provider, targets.default_provider) AS provider,
                          bar_coverage.first_ts, bar_coverage.last_ts,
                          COALESCE(bar_coverage.row_count, 0) AS row_count,
                          sync_coverage.last_success_at
                        FROM targets
                        LEFT JOIN bar_coverage
                          ON bar_coverage.symbol=targets.symbol
                         AND bar_coverage.timeframe=targets.timeframe
                         AND bar_coverage.adjustment=targets.adjustment
                        LEFT JOIN sync_coverage
                          ON sync_coverage.symbol=targets.symbol
                         AND sync_coverage.timeframe=targets.timeframe
                         AND sync_coverage.adjustment=targets.adjustment
                        ORDER BY targets.symbol
                        """,
                        [universe_id, include_inactive],
                    )
                else:
                    cursor = connection.execute(
                        """
                        SELECT bars.symbol, securities.name,
                          securities.metadata AS security_metadata,
                          bars.timeframe, bars.adjustment,
                          arg_max(bars.provider, bars.ts) AS provider,
                          min(bars.ts) AS first_ts, max(bars.ts) AS last_ts,
                          count(*) AS row_count,
                          max(sync_state.last_success_at) AS last_success_at
                        FROM quant.stock_bars bars
                        LEFT JOIN quant.securities securities USING(symbol)
                        LEFT JOIN quant.market_data_sync_state sync_state
                          ON sync_state.symbol=bars.symbol
                         AND sync_state.timeframe=bars.timeframe
                         AND sync_state.adjustment=bars.adjustment
                        GROUP BY bars.symbol, securities.name, securities.metadata,
                          bars.timeframe, bars.adjustment
                        ORDER BY bars.symbol, bars.timeframe, bars.adjustment
                        """
                    )
                rows = _dict_rows(cursor)
            finally:
                connection.close()
        for row in rows:
            row["security_metadata"] = _json_object(row.get("security_metadata"))
            row["data_status"] = _desktop_coverage_status(row)
        return rows

    @_serialized_duckdb_method
    async def universe_summaries(self) -> list[dict[str, Any]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                cursor = connection.execute(
                    """
                    WITH member_rows AS (
                      SELECT
                        universes.id,
                        universes.name,
                        universes.description,
                        universes.status,
                        universes.tags,
                        universes.metadata,
                        universes.created_at,
                        universes.updated_at,
                        securities.symbol,
                        securities.asset_type,
                        COALESCE((
                          SELECT sync_state.row_count
                          FROM quant.market_data_sync_state sync_state
                          WHERE sync_state.symbol=securities.symbol
                            AND sync_state.timeframe=COALESCE(
                              json_extract_string(universes.metadata, '$.default_timeframe'),
                              'daily'
                            )
                            AND sync_state.adjustment=COALESCE(
                              json_extract_string(universes.metadata, '$.default_adjustment'),
                              'qfq'
                            )
                          ORDER BY (
                            sync_state.provider=COALESCE(
                              json_extract_string(universes.metadata, '$.provider'),
                              'baostock'
                            )
                          ) DESC, sync_state.last_ts DESC NULLS LAST
                          LIMIT 1
                        ), 0) AS row_count,
                        (
                          SELECT sync_state.last_ts
                          FROM quant.market_data_sync_state sync_state
                          WHERE sync_state.symbol=securities.symbol
                            AND sync_state.timeframe=COALESCE(
                              json_extract_string(universes.metadata, '$.default_timeframe'),
                              'daily'
                            )
                            AND sync_state.adjustment=COALESCE(
                              json_extract_string(universes.metadata, '$.default_adjustment'),
                              'qfq'
                            )
                          ORDER BY (
                            sync_state.provider=COALESCE(
                              json_extract_string(universes.metadata, '$.provider'),
                              'baostock'
                            )
                          ) DESC, sync_state.last_ts DESC NULLS LAST
                          LIMIT 1
                        ) AS last_ts
                      FROM quant.security_universes universes
                      LEFT JOIN quant.security_universe_members members
                        ON members.universe_id=universes.id
                       AND members.role <> 'inactive'
                      LEFT JOIN quant.securities securities
                        ON securities.symbol=members.symbol
                       AND securities.status NOT IN ('inactive', 'delisted')
                    )
                    SELECT
                      id,
                      name,
                      description,
                      status,
                      tags,
                      metadata,
                      created_at,
                      updated_at,
                      count(symbol) AS member_count,
                      count(*) FILTER (WHERE asset_type='stock') AS stock_count,
                      count(*) FILTER (WHERE asset_type='etf') AS etf_count,
                      count(*) FILTER (WHERE asset_type='index') AS index_count,
                      count(*) FILTER (WHERE asset_type='fund') AS fund_count,
                      count(*) FILTER (WHERE row_count > 0 AND last_ts IS NOT NULL) AS ready_count,
                      COALESCE(sum(row_count), 0) AS bar_count,
                      max(last_ts) AS latest_ts
                    FROM member_rows
                    GROUP BY id, name, description, status, tags, metadata, created_at, updated_at
                    ORDER BY
                      TRY_CAST(json_extract_string(metadata, '$.display_order') AS INTEGER)
                        NULLS LAST,
                      created_at
                    """
                )
                rows = _dict_rows(cursor)
            finally:
                connection.close()
        for row in rows:
            metadata = _json_object(row.get("metadata"))
            row["metadata"] = metadata
            row["tags"] = [str(item) for item in _json_array(row.get("tags"))]
            row["source"] = str(metadata.get("source") or "local-market-data")
            row["default_timeframe"] = str(metadata.get("default_timeframe") or "daily")
            row["default_adjustment"] = str(metadata.get("default_adjustment") or "qfq")
            row["provider"] = str(metadata.get("provider") or "baostock")
            coverage_rows = await self.coverage_rows(universe_id=str(row["id"]))
            coverage_counts = {
                status: sum(item.get("data_status") == status for item in coverage_rows)
                for status in ("missing", "partial", "stale", "ready")
            }
            row["ready_count"] = coverage_counts["ready"]
            row["bar_count"] = sum(int(item.get("row_count") or 0) for item in coverage_rows)
            row["latest_ts"] = max(
                (item.get("last_ts") for item in coverage_rows if item.get("last_ts")),
                default=None,
            )
            metadata["coverage_counts"] = coverage_counts
        return rows

    @_serialized_duckdb_method
    async def universe_member_rows(
        self,
        *,
        universe_id: str,
        page: int,
        page_size: int,
        keyword: str | None,
        include_inactive: bool,
    ) -> tuple[list[dict[str, Any]], int, int, int]:
        await self.initialize()
        clean_keyword = (keyword or "").strip().lower()
        keyword_pattern = f"%{clean_keyword}%"
        normalized_size = max(1, page_size)
        with self._lock:
            connection = self._connect()
            try:
                total = int(
                    connection.execute(
                        """
                        SELECT count(*)
                        FROM quant.security_universe_members members
                        JOIN quant.securities securities USING(symbol)
                        WHERE members.universe_id=?
                          AND (
                            ?
                            OR (
                              members.role <> 'inactive'
                              AND securities.status NOT IN ('inactive', 'delisted')
                            )
                          )
                          AND (
                            ?=''
                            OR lower(securities.symbol) LIKE ?
                            OR lower(securities.code) LIKE ?
                            OR lower(COALESCE(securities.name, '')) LIKE ?
                            OR lower(COALESCE(securities.exchange, '')) LIKE ?
                            OR lower(COALESCE(securities.asset_type, '')) LIKE ?
                            OR lower(CAST(securities.metadata AS VARCHAR)) LIKE ?
                          )
                        """,
                        [
                            universe_id,
                            include_inactive,
                            clean_keyword,
                            keyword_pattern,
                            keyword_pattern,
                            keyword_pattern,
                            keyword_pattern,
                            keyword_pattern,
                            keyword_pattern,
                        ],
                    ).fetchone()[0]
                    or 0
                )
                total_pages = max(1, (total + normalized_size - 1) // normalized_size)
                current_page = min(max(1, page), total_pages)
                offset = (current_page - 1) * normalized_size
                cursor = connection.execute(
                    """
                    WITH paged AS (
                      SELECT
                        universes.metadata AS universe_metadata,
                        securities.symbol,
                        securities.code,
                        securities.name AS security_name,
                        securities.exchange,
                        securities.asset_type,
                        securities.currency,
                        securities.timezone,
                        securities.secid,
                        securities.provider,
                        securities.metadata AS security_metadata,
                        securities.status AS security_status,
                        members.role,
                        members.metadata AS member_metadata,
                        COALESCE(
                          json_extract_string(universes.metadata, '$.default_timeframe'),
                          'daily'
                        ) AS timeframe,
                        COALESCE(
                          json_extract_string(universes.metadata, '$.default_adjustment'),
                          'qfq'
                        ) AS adjustment
                      FROM quant.security_universe_members members
                      JOIN quant.security_universes universes
                        ON universes.id=members.universe_id
                      JOIN quant.securities securities USING(symbol)
                      WHERE members.universe_id=?
                        AND (
                          ?
                          OR (
                            members.role <> 'inactive'
                            AND securities.status NOT IN ('inactive', 'delisted')
                          )
                        )
                        AND (
                          ?=''
                          OR lower(securities.symbol) LIKE ?
                          OR lower(securities.code) LIKE ?
                          OR lower(COALESCE(securities.name, '')) LIKE ?
                          OR lower(COALESCE(securities.exchange, '')) LIKE ?
                          OR lower(COALESCE(securities.asset_type, '')) LIKE ?
                          OR lower(CAST(securities.metadata AS VARCHAR)) LIKE ?
                        )
                      ORDER BY
                        TRY_CAST(
                          json_extract_string(members.metadata, '$.order') AS INTEGER
                        ) NULLS LAST,
                        securities.symbol
                      LIMIT ? OFFSET ?
                    )
                    SELECT
                      paged.*,
                      NULL AS weight,
                      COALESCE(metrics.row_count, 0) AS row_count,
                      metrics.first_ts,
                      metrics.last_ts,
                      metrics.data_provider,
                      COALESCE(metrics.sample_count, 0) AS sample_count,
                      metrics.latest_close,
                      metrics.previous_close,
                      metrics.latest_change_percent,
                      metrics.latest_amount,
                      metrics.latest_turnover,
                      metrics.close_20d,
                      metrics.close_60d,
                      metrics.ma20,
                      metrics.ma60,
                      metrics.avg_amount_20d,
                      metrics.avg_volume_20d,
                      metrics.avg_turnover_20d,
                      metrics.trade_status,
                      metrics.is_st,
                      metrics.limit_up,
                      metrics.limit_down,
                      NULL AS pe_ttm,
                      NULL AS pb_mrq,
                      NULL AS ps_ttm,
                      NULL AS pcf_ncf_ttm
                    FROM paged
                    LEFT JOIN LATERAL (
                      SELECT
                        max(total_count) AS row_count,
                        min(first_ts) AS first_ts,
                        max(last_ts) AS last_ts,
                        arg_max(provider, ts) AS data_provider,
                        max(total_count) AS sample_count,
                        max(close) FILTER (WHERE rn=1) AS latest_close,
                        max(previous_close) FILTER (WHERE rn=1) AS previous_close,
                        max(change_percent) FILTER (WHERE rn=1) AS latest_change_percent,
                        max(amount) FILTER (WHERE rn=1) AS latest_amount,
                        max(turnover) FILTER (WHERE rn=1) AS latest_turnover,
                        max(close) FILTER (WHERE rn=21) AS close_20d,
                        max(close) FILTER (WHERE rn=61) AS close_60d,
                        avg(close) FILTER (WHERE rn <= 20) AS ma20,
                        avg(close) FILTER (WHERE rn <= 60) AS ma60,
                        avg(amount) FILTER (WHERE rn <= 20) AS avg_amount_20d,
                        avg(volume) FILTER (WHERE rn <= 20) AS avg_volume_20d,
                        avg(turnover) FILTER (WHERE rn <= 20) AS avg_turnover_20d,
                        max(trade_status) FILTER (WHERE rn=1) AS trade_status,
                        max(is_st) FILTER (WHERE rn=1) AS is_st,
                        max(limit_up) FILTER (WHERE rn=1) AS limit_up,
                        max(limit_down) FILTER (WHERE rn=1) AS limit_down
                      FROM (
                        SELECT
                          bars.*,
                          row_number() OVER (ORDER BY bars.ts DESC) AS rn,
                          count(*) OVER () AS total_count,
                          min(bars.ts) OVER () AS first_ts,
                          max(bars.ts) OVER () AS last_ts
                        FROM quant.stock_bars bars
                        WHERE bars.symbol=paged.symbol
                          AND bars.timeframe=paged.timeframe
                          AND bars.adjustment=paged.adjustment
                        QUALIFY rn <= 61
                      ) recent
                    ) metrics ON TRUE
                    ORDER BY
                      TRY_CAST(
                        json_extract_string(paged.member_metadata, '$.order') AS INTEGER
                      ) NULLS LAST,
                      paged.symbol
                    """,
                    [
                        universe_id,
                        include_inactive,
                        clean_keyword,
                        keyword_pattern,
                        keyword_pattern,
                        keyword_pattern,
                        keyword_pattern,
                        keyword_pattern,
                        keyword_pattern,
                        normalized_size,
                        offset,
                    ],
                )
                rows = _dict_rows(cursor)
            finally:
                connection.close()
        for row in rows:
            row["security_metadata"] = _json_object(row.get("security_metadata"))
            row["universe_metadata"] = _json_object(row.get("universe_metadata"))
            row["member_metadata"] = _json_object(row.get("member_metadata"))
            row["data_status"] = _desktop_coverage_status(row)
        return rows, total, total_pages, current_page

    @_serialized_duckdb_method
    async def ingestion_preflight(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        adjustment: str,
        cutoff: datetime,
        end_cutoff: datetime | None,
        require_fields: list[str],
    ) -> dict[str, dict[str, Any]]:
        await self.initialize()
        if not symbols:
            return {}
        if end_cutoff is None and timeframe == "daily":
            end_cutoff = datetime.combine(
                _expected_latest_daily_date(),
                datetime.min.time(),
                tzinfo=SHANGHAI_TZ,
            ).astimezone(UTC)
        placeholders = ", ".join("?" for _ in symbols)
        with self._lock:
            connection = self._connect()
            try:
                cursor = connection.execute(
                    f"""
                    SELECT symbol, ts, amount, turnover, trade_status, is_st, limit_up, limit_down
                    FROM quant.stock_bars
                    WHERE symbol IN ({placeholders})
                      AND timeframe=?
                      AND adjustment=?
                    ORDER BY symbol, ts
                    """,
                    [*symbols, timeframe, adjustment],
                )
                rows = _dict_rows(cursor)
                metadata_rows = _dict_rows(
                    connection.execute(
                        f"SELECT symbol, metadata FROM quant.securities WHERE symbol IN ({placeholders})",
                        symbols,
                    )
                )
            finally:
                connection.close()

        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        security_metadata = {
            str(row["symbol"]): _json_object(row.get("metadata"))
            for row in metadata_rows
        }
        benchmark_dates: set[datetime] = set()
        for row in rows:
            ts = _aware_datetime(row.get("ts"))
            if ts is None:
                continue
            row["ts"] = ts
            grouped[str(row["symbol"])].append(row)
            if ts >= cutoff and (end_cutoff is None or ts <= end_cutoff):
                benchmark_dates.add(ts)

        benchmark_last_ts = max(benchmark_dates, default=None)
        if end_cutoff is not None and (
            benchmark_last_ts is None or end_cutoff > benchmark_last_ts
        ):
            benchmark_last_ts = end_cutoff
        result: dict[str, dict[str, Any]] = {}
        for symbol in symbols:
            symbol_rows = grouped.get(symbol, [])
            coverage_start = cutoff.astimezone(SHANGHAI_TZ).date()
            listing_date = _catalog_listing_date(security_metadata.get(symbol))
            if listing_date and listing_date > coverage_start:
                coverage_start = listing_date
            coverage_end = (
                benchmark_last_ts.astimezone(SHANGHAI_TZ).date()
                if benchmark_last_ts
                else _expected_latest_daily_date()
            )
            observed_benchmark_rows = sum(
                1
                for benchmark_ts in benchmark_dates
                if benchmark_ts.astimezone(SHANGHAI_TZ).date() >= coverage_start
            )
            expected_rows = max(
                observed_benchmark_rows,
                _minimum_expected_sessions(coverage_start, coverage_end),
            )
            requested_rows = [
                row
                for row in symbol_rows
                if row["ts"] >= cutoff
                and (end_cutoff is None or row["ts"] <= end_cutoff)
            ]

            def row_is_complete(row: dict[str, Any]) -> bool:
                return all(row.get(field) is not None for field in require_fields)

            result[symbol] = {
                "symbol": symbol,
                "first_ts": symbol_rows[0]["ts"] if symbol_rows else None,
                "last_ts": symbol_rows[-1]["ts"] if symbol_rows else None,
                "benchmark_last_ts": benchmark_last_ts,
                "row_count": len(symbol_rows),
                "rows_since_cutoff": len(requested_rows),
                "expected_rows_since_cutoff": expected_rows,
                "complete_rows_since_cutoff": sum(
                    1 for row in requested_rows if row_is_complete(row)
                ),
                "pe_ttm_count": 0,
                "pb_mrq_count": 0,
                "ps_ttm_count": 0,
                "pcf_ncf_ttm_count": 0,
            }
        return result

    @_serialized_duckdb_method
    async def universe_symbols(self, universe_id: str) -> list[str]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                return [row[0] for row in connection.execute(
                    "SELECT symbol FROM quant.security_universe_members WHERE universe_id=? AND role <> 'inactive' ORDER BY symbol",
                    [universe_id],
                ).fetchall()]
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def universe_fetch_targets(self, universe_id: str) -> list[dict[str, str]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                rows = connection.execute(
                    """SELECT securities.symbol, securities.code, securities.secid, securities.asset_type
                    FROM quant.security_universe_members members
                    JOIN quant.securities securities USING(symbol)
                    WHERE members.universe_id=? AND members.role <> 'inactive'
                      AND securities.status NOT IN ('inactive','delisted')
                    ORDER BY
                      TRY_CAST(json_extract_string(members.metadata, '$.order') AS INTEGER)
                        NULLS LAST,
                      securities.symbol""",
                    [universe_id],
                ).fetchall()
            finally:
                connection.close()
        return [
            {"symbol": str(row[0]), "query": str(row[2] or row[1] or row[0]), "asset_type": str(row[3] or "stock")}
            for row in rows
        ]

    @_serialized_duckdb_method
    async def add_securities_to_universe(
        self, *, universe_id: str, securities: list[Any], role: str, added_source: str
    ) -> list[dict[str, Any]]:
        await self.initialize()
        await self.ensure_disk_capacity(max(1, len(securities)) * 2048)
        members: list[dict[str, Any]] = []
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN TRANSACTION")
                connection.execute(
                    "INSERT INTO quant.security_universes (id, name, metadata) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                    [
                        universe_id,
                        "全 A 股股票池" if universe_id == "a-share-sample-research-pool" else universe_id,
                        json.dumps(
                            {
                                "default_timeframe": "daily",
                                "default_adjustment": "qfq",
                                "provider": "baostock",
                                "source": "eastmoney",
                            },
                            ensure_ascii=False,
                        ),
                    ],
                )
                next_order = int(
                    connection.execute(
                        """
                        SELECT COALESCE(
                          max(TRY_CAST(json_extract_string(metadata, '$.order') AS INTEGER)),
                          0
                        ) + 1
                        FROM quant.security_universe_members
                        WHERE universe_id=?
                        """,
                        [universe_id],
                    ).fetchone()[0]
                    or 1
                )
                for index, security in enumerate(securities):
                    symbol = canonical_symbol(security.symbol, security.market)
                    metadata = {
                        "query": security.query, "raw": security.raw,
                        "listing_date": security.raw.get("listing_date") or security.raw.get("f26"),
                        "industry": security.raw.get("industry") or security.raw.get("f100"),
                        "region": security.raw.get("region") or security.raw.get("f102"),
                        "concepts": security.raw.get("concepts") or security.raw.get("f103"),
                        "added_source": added_source,
                    }
                    connection.execute(
                        """INSERT INTO quant.securities
                        (symbol, code, name, exchange, asset_type, currency, timezone, secid, provider, metadata)
                        VALUES (?, ?, ?, ?, ?, 'CNY', 'Asia/Shanghai', ?, ?, ?)
                        ON CONFLICT(symbol) DO UPDATE SET code=excluded.code, name=excluded.name,
                          exchange=excluded.exchange, asset_type=excluded.asset_type, secid=excluded.secid,
                          provider=excluded.provider, status='active', metadata=excluded.metadata, updated_at=now()""",
                        [symbol, security.symbol, security.name, security.market, security.asset_type,
                         security.secid, security.source, json.dumps(metadata, ensure_ascii=False, default=str)],
                    )
                    connection.execute(
                        """INSERT INTO quant.security_universe_members (universe_id, symbol, role, metadata)
                        VALUES (?, ?, ?, ?) ON CONFLICT(universe_id, symbol) DO UPDATE SET
                          role=excluded.role, metadata=excluded.metadata""",
                        [
                            universe_id,
                            symbol,
                            role or "member",
                            json.dumps(
                                {
                                    "order": (
                                        int(existing_order[0])
                                        if (
                                            existing_order := connection.execute(
                                                """
                                                SELECT TRY_CAST(
                                                  json_extract_string(metadata, '$.order') AS INTEGER
                                                )
                                                FROM quant.security_universe_members
                                                WHERE universe_id=? AND symbol=?
                                                """,
                                                [universe_id, symbol],
                                            ).fetchone()
                                        )
                                        and existing_order[0] is not None
                                        else next_order + index
                                    ),
                                    "added_source": added_source,
                                }
                            ),
                        ],
                    )
                    members.append({
                        "symbol": symbol, "code": security.symbol, "name": security.name,
                        "exchange": security.market, "asset_type": security.asset_type,
                        "secid": security.secid, "provider": security.source, "role": role or "member",
                    })
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()
        return members

    @_serialized_duckdb_method
    async def technical_screener_rows(
        self,
        *,
        universe_id: str,
        trade_date: date | None,
        timeframe: str,
        adjustment: str,
        min_sample_count: int,
        exclude_st: bool,
        exclude_limit_up: bool,
    ) -> tuple[date | None, list[dict[str, Any]]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                cursor = connection.execute(
                    """
                    WITH ranked AS (
                      SELECT
                        securities.symbol,
                        securities.code,
                        securities.name,
                        securities.exchange,
                        securities.metadata AS security_metadata,
                        bars.ts,
                        bars.open,
                        bars.high,
                        bars.low,
                        bars.close,
                        bars.previous_close,
                        bars.amount,
                        bars.volume,
                        bars.turnover,
                        bars.amplitude,
                        bars.change_percent,
                        bars.limit_up,
                        bars.is_st,
                        bars.provider,
                        row_number() OVER (
                          PARTITION BY securities.symbol ORDER BY bars.ts DESC
                        ) AS recent_rank
                      FROM quant.security_universe_members members
                      JOIN quant.securities securities ON securities.symbol=members.symbol
                      JOIN quant.stock_bars bars ON bars.symbol=members.symbol
                      WHERE members.universe_id=? AND members.role <> 'inactive'
                        AND securities.asset_type='stock'
                        AND securities.status NOT IN ('inactive','delisted')
                        AND bars.timeframe=? AND bars.adjustment=?
                        AND (
                          ? IS NULL
                          OR CAST(timezone('Asia/Shanghai', bars.ts) AS DATE) <= ?
                        )
                    )
                    SELECT * EXCLUDE (recent_rank)
                    FROM ranked
                    WHERE recent_rank <= 260
                    ORDER BY symbol, ts
                    """,
                    [universe_id, timeframe, adjustment, trade_date, trade_date],
                )
                columns = [item[0] for item in cursor.description]
                raw_rows = [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
            finally:
                connection.close()
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in raw_rows:
            local_date = (
                row["ts"].astimezone(SHANGHAI_TZ).date()
                if row["ts"].tzinfo
                else row["ts"].date()
            )
            if trade_date is None or local_date <= trade_date:
                row["trade_date"] = local_date
                grouped[str(row["symbol"])].append(row)
        resolved_date = trade_date or max(
            (row["trade_date"] for rows in grouped.values() for row in rows),
            default=None,
        )
        if resolved_date is None:
            return None, []

        def average(values: list[Any]) -> Decimal | None:
            normalized = [Decimal(str(value)) for value in values if value is not None]
            return sum(normalized, Decimal("0")) / len(normalized) if normalized else None

        result: list[dict[str, Any]] = []
        for symbol, symbol_rows in grouped.items():
            eligible = [row for row in symbol_rows if row["trade_date"] <= resolved_date][-260:]
            if not eligible or eligible[-1]["trade_date"] != resolved_date:
                continue
            latest = eligible[-1]
            if len(eligible) < min_sample_count:
                continue
            if exclude_st and latest.get("is_st") is True:
                continue
            if exclude_limit_up and latest.get("limit_up") is True:
                continue
            history = [
                {
                    "date": row["trade_date"].isoformat(), "open": row["open"], "high": row["high"],
                    "low": row["low"], "close": row["close"],
                    "previous_close": row.get("previous_close"), "amount": row.get("amount"),
                    "volume": row.get("volume"), "turnover": row.get("turnover"),
                    "amplitude": row.get("amplitude"),
                }
                for row in eligible
            ]
            features = build_technical_feature_rows(history)
            feature = features[-1] if features else {}
            reversed_rows = list(reversed(eligible))
            row: dict[str, Any] = {
                "symbol": symbol, "code": latest["code"], "name": latest.get("name"),
                "exchange": latest.get("exchange"), "security_metadata": latest.get("security_metadata") or {},
                "sample_count": len(eligible), "latest_trade_date": resolved_date,
                "latest_provider": latest.get("provider"), "latest_open": latest.get("open"),
                "latest_high": latest.get("high"), "latest_low": latest.get("low"),
                "latest_close": latest.get("close"), "previous_close": latest.get("previous_close"),
                "latest_amount": latest.get("amount"), "latest_volume": latest.get("volume"),
                "latest_turnover": latest.get("turnover"),
                "latest_change_percent": latest.get("change_percent"),
                "previous_change_percent": reversed_rows[1].get("change_percent") if len(reversed_rows) > 1 else None,
                "latest_limit_up": latest.get("limit_up"), "latest_is_st": latest.get("is_st"),
                "ma5": average([item.get("close") for item in reversed_rows[:5]]),
                "ma10": average([item.get("close") for item in reversed_rows[:10]]),
                "ma20": average([item.get("close") for item in reversed_rows[:20]]),
                "ma30": average([item.get("close") for item in reversed_rows[:30]]),
                "ma60": average([item.get("close") for item in reversed_rows[:60]]),
                "ma120": average([item.get("close") for item in reversed_rows[:120]]),
                "ma250": average([item.get("close") for item in reversed_rows[:250]]),
                "avg_amount_5d": average([item.get("amount") for item in reversed_rows[:5]]),
                "avg_amount_20d": average([item.get("amount") for item in reversed_rows[:20]]),
                "avg_volume_5d": average([item.get("volume") for item in reversed_rows[:5]]),
                "avg_volume_20d": average([item.get("volume") for item in reversed_rows[:20]]),
                "avg_turnover_20d": average([item.get("turnover") for item in reversed_rows[:20]]),
                "close_5d": reversed_rows[5].get("close") if len(reversed_rows) > 5 else None,
                "close_10d": reversed_rows[10].get("close") if len(reversed_rows) > 10 else None,
                "close_20d": reversed_rows[20].get("close") if len(reversed_rows) > 20 else None,
                "close_60d": reversed_rows[60].get("close") if len(reversed_rows) > 60 else None,
                "limit_up_count_4d": sum(item.get("limit_up") is True for item in reversed_rows[:4]),
                "limit_up_count_10d": sum(item.get("limit_up") is True for item in reversed_rows[:10]),
                "latest_limit_up_date": next((item["trade_date"] for item in reversed_rows[:10] if item.get("limit_up") is True), None),
                "bar_history": history,
            }
            row.update({key: value for key, value in feature.items() if value is not None})
            result.append(row)
        for row in result:
            row["scanned_symbols"] = len(result)
        return resolved_date, result

    @_serialized_duckdb_method
    async def create_ingestion_job(self, **job: Any) -> None:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                connection.execute(
                    """INSERT INTO quant.market_data_ingestion_jobs
                    (id, universe_id, provider, timeframe, adjustment, status, total_symbols, metadata, started_at)
                    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, now())
                    ON CONFLICT(id) DO UPDATE SET status='running', total_symbols=excluded.total_symbols,
                    metadata=excluded.metadata, started_at=now(), updated_at=now()""",
                    [job["job_id"], job.get("universe_id"), job["provider"], job["timeframe"],
                     job["adjustment"], job["total_symbols"], json.dumps(job.get("metadata", {}), default=str)],
                )
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def update_ingestion_job(self, job_id: str, **updates: Any) -> None:
        await self.initialize()
        allowed = {"status", "total_symbols", "completed_symbols", "failed_symbols", "rows_received", "rows_upserted", "error", "completed_at"}
        values = {key: value for key, value in updates.items() if key in allowed and value is not None}
        with self._lock:
            connection = self._connect()
            try:
                if "metadata" in updates and updates["metadata"] is not None:
                    current = connection.execute(
                        "SELECT metadata FROM quant.market_data_ingestion_jobs WHERE id=?",
                        [job_id],
                    ).fetchone()
                    merged = _json_object(current[0]) if current else {}
                    merged.update(_json_object(updates["metadata"]))
                    values["metadata"] = json.dumps(merged, default=str)
                if not values:
                    return
                assignments = ", ".join(f"{key}=?" for key in values)
                connection.execute(
                    f"UPDATE quant.market_data_ingestion_jobs SET {assignments}, updated_at=now() WHERE id=?",
                    [*values.values(), job_id],
                )
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def ingestion_control(self, job_id: str) -> str | None:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                row = connection.execute(
                    "SELECT json_extract_string(metadata, '$.control') FROM quant.market_data_ingestion_jobs WHERE id=?",
                    [job_id],
                ).fetchone()
                return row[0] if row else None
            finally:
                connection.close()

    @_serialized_duckdb_method
    async def control_ingestion_job(
        self,
        *,
        job_id: str,
        control: str,
        reason: str | None,
    ) -> dict[str, Any] | None:
        await self.initialize()
        now_iso = datetime.now(UTC).isoformat()
        with self._lock:
            connection = self._connect()
            try:
                current = connection.execute(
                    "SELECT metadata FROM quant.market_data_ingestion_jobs WHERE id=?",
                    [job_id],
                ).fetchone()
                if current is None:
                    return None
                metadata = _json_object(current[0])
                metadata.update(
                    {
                        "control": control,
                        "control_reason": reason,
                        "control_updated_at": now_iso,
                    }
                )
                connection.execute(
                    """
                    UPDATE quant.market_data_ingestion_jobs
                    SET metadata=?, updated_at=now()
                    WHERE id=?
                    """,
                    [json.dumps(metadata, default=str), job_id],
                )
                cursor = connection.execute(
                    """
                    SELECT id, universe_id, provider, timeframe, adjustment, status,
                      total_symbols, completed_symbols, failed_symbols, rows_received,
                      rows_upserted, error, metadata, started_at, completed_at,
                      created_at, updated_at
                    FROM quant.market_data_ingestion_jobs
                    WHERE id=?
                    """,
                    [job_id],
                )
                rows = _dict_rows(cursor)
            finally:
                connection.close()
        if not rows:
            return None
        rows[0]["metadata"] = _json_object(rows[0].get("metadata"))
        return rows[0]

    @_serialized_duckdb_method
    async def reconcile_stale_ingestion_jobs(
        self,
        *,
        universe_id: str | None,
        heartbeat_timeout_seconds: int,
        stop_grace_seconds: int,
    ) -> int:
        await self.initialize()
        now = datetime.now(UTC)
        with self._lock:
            connection = self._connect()
            try:
                if universe_id:
                    cursor = connection.execute(
                        """
                        SELECT id, error, metadata, updated_at
                        FROM quant.market_data_ingestion_jobs
                        WHERE status='running' AND universe_id=?
                        """,
                        [universe_id],
                    )
                else:
                    cursor = connection.execute(
                        """
                        SELECT id, error, metadata, updated_at
                        FROM quant.market_data_ingestion_jobs
                        WHERE status='running'
                        """
                    )
                rows = _dict_rows(cursor)
                reconciled = 0
                for row in rows:
                    metadata = _json_object(row.get("metadata"))
                    control = str(metadata.get("control") or "run")
                    reference = _aware_datetime(
                        metadata.get(
                            "control_updated_at" if control == "stop" else "last_heartbeat_at"
                        )
                    ) or _aware_datetime(row.get("updated_at"))
                    timeout_seconds = (
                        stop_grace_seconds if control == "stop" else heartbeat_timeout_seconds
                    )
                    if reference is None or now - reference <= timedelta(seconds=timeout_seconds):
                        continue
                    reason = (
                        "补数任务已请求停止，心跳未继续，已自动收口。"
                        if control == "stop"
                        else "补数任务心跳过期，已自动标记为部分完成。"
                    )
                    metadata.update(
                        {
                            "control": "idle",
                            "active_child_job_id": None,
                            "stop_reason": "stopped" if control == "stop" else "stale_heartbeat",
                            "stale_reconciled_at": now.isoformat(),
                        }
                    )
                    connection.execute(
                        """
                        UPDATE quant.market_data_ingestion_jobs
                        SET status='partial', completed_at=COALESCE(completed_at, now()),
                          error=COALESCE(error, ?), metadata=?, updated_at=now()
                        WHERE id=?
                        """,
                        [reason, json.dumps(metadata, default=str), row["id"]],
                    )
                    reconciled += 1
            finally:
                connection.close()
        return reconciled

    @_serialized_duckdb_method
    async def list_ingestion_jobs(
        self,
        *,
        universe_id: str | None,
        provider: str | None = None,
        limit: int,
    ) -> list[dict[str, Any]]:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                filters: list[str] = []
                params: list[Any] = []
                if universe_id:
                    filters.append("universe_id=?")
                    params.append(universe_id)
                if provider:
                    filters.append("provider=?")
                    params.append(provider)
                where_sql = f"WHERE {' AND '.join(filters)}" if filters else ""
                params.append(limit)
                cursor = connection.execute(
                    f"""
                    SELECT id, universe_id, provider, timeframe, adjustment, status,
                      total_symbols, completed_symbols, failed_symbols, rows_received,
                      rows_upserted, error, metadata, started_at, completed_at,
                      created_at, updated_at
                    FROM quant.market_data_ingestion_jobs
                    {where_sql}
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    params,
                )
                rows = _dict_rows(cursor)
            finally:
                connection.close()
        for row in rows:
            row["metadata"] = _json_object(row.get("metadata"))
        return rows

    @_serialized_duckdb_method
    async def save_backtest(self, run: dict[str, Any], orders: Iterable[dict[str, Any]]) -> None:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
                connection.execute("BEGIN TRANSACTION")
                connection.execute(
                    "INSERT OR REPLACE INTO quant.backtest_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, now(), now())",
                    [run["id"], run.get("strategy_id"), run.get("status", "completed"),
                     json.dumps(run.get("parameters", {})), json.dumps(run.get("metrics", {})),
                     json.dumps(run.get("metadata", {})), run.get("started_at"), run.get("completed_at")],
                )
                rows = [
                    [item["id"], run["id"], item["symbol"], item["ts"], item["side"],
                     item.get("quantity"), item.get("price"), item.get("fee"),
                     json.dumps(item.get("metadata", {}))]
                    for item in orders
                ]
                if rows:
                    connection.executemany(
                        "INSERT OR REPLACE INTO quant.backtest_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())",
                        rows,
                    )
                connection.execute("COMMIT")
            except Exception:
                with suppress(Exception):
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()

    async def close(self) -> None:
        """Stop the dedicated DuckDB worker after all scheduled work completes."""

        async with self._worker_lock:
            if self._closed:
                return
            self._closed = True
        await asyncio.to_thread(
            self._worker_executor.shutdown,
            wait=True,
            cancel_futures=True,
        )

    async def ensure_disk_capacity(self, required_bytes: int) -> None:
        usage = shutil.disk_usage(self.database_path.parent)
        minimum_free_bytes = max(
            256 * 1024 * 1024,
            int(os.getenv("QUANTPILOT_MARKET_MIN_FREE_BYTES", str(1024**3))),
        )
        if usage.free - max(0, required_bytes) < minimum_free_bytes:
            raise DatabaseError(
                "本地磁盘剩余空间不足，已停止行情写入；至少保留 "
                f"{minimum_free_bytes // (1024**2)} MB 空闲空间。"
            )
