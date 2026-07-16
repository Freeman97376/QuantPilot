from __future__ import annotations

import json
import os
import shutil
import threading
from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb

from quantpilot_market_data.database_core import (
    canonical_symbol,
    date_cutoff_datetime,
    lookback_cutoff_datetime,
    parse_bar_datetime,
)
from quantpilot_market_data.indicators import build_technical_feature_rows
from quantpilot_market_data.models import LocalKlineBar, LocalKlineResponse, LocalKlineSummary

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


class DuckDBMarketRepository:
    """Desktop implementation for durable market data and job state."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self._lock = threading.RLock()
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
                    "INSERT INTO quant.market_schema_version VALUES (1, now()) ON CONFLICT DO NOTHING"
                )
            finally:
                connection.close()
            self._initialized = True

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
        return {"status": "ok", "engine": "duckdb", "schema_version": int(version or 0)}

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
                "source_bar": bar.metadata, "universe_id": universe_id,
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
                      provider=excluded.provider, metadata=excluded.metadata, updated_at=now()
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
                      provider=excluded.provider, metadata=excluded.metadata
                    """,
                    rows,
                )
                if universe_id:
                    connection.execute(
                        "INSERT INTO quant.security_universes (id, name, metadata) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                        [universe_id, universe_id, json.dumps({"default_timeframe": "daily", "default_adjustment": "qfq"})],
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
                    ORDER BY securities.symbol""",
                    [universe_id],
                ).fetchall()
            finally:
                connection.close()
        return [
            {"symbol": str(row[0]), "query": str(row[2] or row[1] or row[0]), "asset_type": str(row[3] or "stock")}
            for row in rows
        ]

    async def add_securities_to_universe(
        self, *, universe_id: str, securities: list[Any], role: str, added_source: str
    ) -> list[dict[str, Any]]:
        await self.initialize()
        members: list[dict[str, Any]] = []
        with self._lock:
            connection = self._connect()
            try:
                connection.execute(
                    "INSERT INTO quant.security_universes (id, name, metadata) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                    [universe_id, universe_id, json.dumps({"default_timeframe": "daily", "default_adjustment": "qfq", "provider": "eastmoney"})],
                )
                for index, security in enumerate(securities):
                    symbol = canonical_symbol(security.symbol, security.market)
                    metadata = {
                        "query": security.query, "raw": security.raw,
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
                        [universe_id, symbol, role or "member", json.dumps({"order": index + 1, "added_source": added_source})],
                    )
                    members.append({
                        "symbol": symbol, "code": security.symbol, "name": security.name,
                        "exchange": security.market, "asset_type": security.asset_type,
                        "secid": security.secid, "provider": security.source, "role": role or "member",
                    })
            finally:
                connection.close()
        return members

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
                    SELECT securities.symbol, securities.code, securities.name, securities.exchange,
                      securities.metadata AS security_metadata, bars.ts, bars.open, bars.high, bars.low,
                      bars.close, bars.previous_close, bars.amount, bars.volume, bars.turnover,
                      bars.amplitude, bars.change_percent, bars.limit_up, bars.is_st, bars.provider
                    FROM quant.security_universe_members members
                    JOIN quant.securities securities ON securities.symbol=members.symbol
                    JOIN quant.stock_bars bars ON bars.symbol=members.symbol
                    WHERE members.universe_id=? AND members.role <> 'inactive'
                      AND securities.asset_type='stock' AND securities.status NOT IN ('inactive','delisted')
                      AND bars.timeframe=? AND bars.adjustment=?
                    ORDER BY securities.symbol, bars.ts
                    """,
                    [universe_id, timeframe, adjustment],
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

    async def update_ingestion_job(self, job_id: str, **updates: Any) -> None:
        await self.initialize()
        allowed = {"status", "completed_symbols", "failed_symbols", "rows_received", "rows_upserted", "error", "completed_at"}
        values = {key: value for key, value in updates.items() if key in allowed and value is not None}
        if "metadata" in updates and updates["metadata"] is not None:
            values["metadata"] = json.dumps(updates["metadata"], default=str)
        if not values:
            return
        assignments = ", ".join(f"{key}=?" for key in values)
        with self._lock:
            connection = self._connect()
            try:
                connection.execute(
                    f"UPDATE quant.market_data_ingestion_jobs SET {assignments}, updated_at=now() WHERE id=?",
                    [*values.values(), job_id],
                )
            finally:
                connection.close()

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

    async def save_backtest(self, run: dict[str, Any], orders: Iterable[dict[str, Any]]) -> None:
        await self.initialize()
        with self._lock:
            connection = self._connect()
            try:
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
            finally:
                connection.close()

    async def ensure_disk_capacity(self, required_bytes: int) -> None:
        usage = shutil.disk_usage(self.database_path.parent)
        if usage.free < max(required_bytes, 256 * 1024 * 1024):
            raise RuntimeError("Insufficient disk space for the requested market-data write.")
