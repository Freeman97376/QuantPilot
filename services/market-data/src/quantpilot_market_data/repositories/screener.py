from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from psycopg.rows import dict_row

from quantpilot_market_data.cache import RedisJsonCache, ttl_from_env
from quantpilot_market_data.clickhouse import (
    is_clickhouse_enabled,
    query_screener_feature_rows,
)
from quantpilot_market_data.database_core import (
    bool_or_none,
    connect,
    decimal_or_none,
    decimal_ratio,
    percent_change,
    security_sector_fields,
)
from quantpilot_market_data.indicators import (
    TECHNICAL_INDICATOR_FIELD_LABELS,
    build_technical_feature_rows,
)
from quantpilot_market_data.models import (
    AnalyticsExecutionMetadata,
    AShareScreenerCandidate,
    AShareScreenerResponse,
    ScreenerMode,
    TechnicalScreenerCondition,
    TechnicalScreenerRequest,
    TechnicalScreenerResponse,
)
from quantpilot_market_data.repositories.analytics import sync_clickhouse_daily_bars

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"
SCREENER_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SCREENER_CACHE_TTL_SECONDS", 60)
_SCREENER_CACHE: dict[tuple[str, str, str, int], tuple[datetime, AShareScreenerResponse]] = {}
_SCREENER_TRADE_DATE_CACHE: dict[tuple[str, str], tuple[datetime, date | None]] = {}
_SCREENER_REDIS_CACHE = RedisJsonCache()

__all__ = ["screen_a_share_short_term_candidates", "screen_a_share_technical_strategy"]


def _screener_missing_fields(row: dict[str, Any]) -> list[str]:
    required = {
        "close": row.get("latest_close"),
        "open": row.get("latest_open"),
        "previous_close": row.get("previous_close"),
        "amount": row.get("latest_amount"),
        "turnover": row.get("latest_turnover"),
        "ma5": row.get("ma5"),
        "ma10": row.get("ma10"),
        "ma20": row.get("ma20"),
        "ma30": row.get("ma30"),
        "ma60": row.get("ma60"),
    }
    return [key for key, value in required.items() if value is None]


def _screener_score(row: dict[str, Any]) -> Decimal:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    limit_up_count_10d = int(row.get("limit_up_count_10d") or 0)
    score = Decimal("0")

    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        score += Decimal("28")
    elif (
        all(value is not None for value in (ma5, ma10, ma20, ma60))
        and ma5 >= ma10 >= ma20 >= ma60
    ):
        score += Decimal("20")
    if close is not None and ma5 is not None and close >= ma5:
        score += Decimal("12")
        distance = decimal_ratio(close, ma5)
        if distance is not None and distance > Decimal("1.12"):
            score -= Decimal("6")
    if strength_20d is not None:
        score += max(Decimal("0"), min(Decimal("18"), strength_20d / Decimal("2")))
    if amount_ratio is not None:
        score += max(Decimal("0"), min(Decimal("16"), amount_ratio * Decimal("5")))
    if latest_change is not None and latest_change > 0:
        score += Decimal("8")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        score += Decimal("6")
    if previous_change is not None and previous_change >= 0:
        score += Decimal("4")
    if limit_up_count_4d > 0:
        score += Decimal("10")
    elif limit_up_count_10d > 0:
        score += Decimal("5")
    return score.quantize(Decimal("0.01"))


def _screener_signals(row: dict[str, Any]) -> list[str]:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    signals: list[str] = []
    if limit_up_count_4d > 0:
        signals.append("近4日出现涨停")
    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        signals.append("MA5/10/20/30/60 多头排列")
    if close is not None and ma5 is not None and close >= ma5:
        signals.append("收盘价站上 MA5")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        signals.append("今日高开")
    if latest_change is not None and latest_change > 0:
        signals.append("今日上涨")
    if previous_change is not None and previous_change >= 0:
        signals.append("前一日未下跌")
    if amount_ratio is not None and amount_ratio >= Decimal("1.2"):
        signals.append("成交额较20日均额放大")
    return signals


def _screener_warnings(row: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if int(row.get("sample_count") or 0) < 60:
        warnings.append("样本不足 60 根日 K，MA60 稳定性较弱")
    if bool_or_none(row.get("latest_limit_up")) is True:
        warnings.append("当日涨停，可能无法合理买入")
    if decimal_or_none(row.get("latest_amount")) is None:
        warnings.append("缺少成交额，流动性判断不完整")
    if decimal_or_none(row.get("latest_turnover")) is None:
        warnings.append("缺少换手率")
    return warnings


def _screener_cache_key(
    *,
    universe_id: str,
    trade_date: date,
    mode: ScreenerMode,
    limit: int,
) -> tuple[str, str, str, int]:
    return (universe_id, trade_date.isoformat(), mode, limit)


def _screener_trade_date_cache_key(
    *,
    universe_id: str,
    trade_date: date | None,
) -> tuple[str, str]:
    return (universe_id, trade_date.isoformat() if trade_date else "latest")


def _screener_trade_date_cache_get(
    key: tuple[str, str],
) -> tuple[bool, date | None]:
    cached = _SCREENER_TRADE_DATE_CACHE.get(key)
    if not cached:
        return False, None
    cached_at, value = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_CACHE_TTL_SECONDS):
        _SCREENER_TRADE_DATE_CACHE.pop(key, None)
        return False, None
    return True, value


def _screener_trade_date_cache_set(
    key: tuple[str, str],
    value: date | None,
) -> None:
    if SCREENER_CACHE_TTL_SECONDS <= 0:
        return
    _SCREENER_TRADE_DATE_CACHE[key] = (datetime.now(UTC), value)
    if len(_SCREENER_TRADE_DATE_CACHE) > 64:
        oldest_key = min(_SCREENER_TRADE_DATE_CACHE.items(), key=lambda item: item[1][0])[0]
        _SCREENER_TRADE_DATE_CACHE.pop(oldest_key, None)


def _screener_cached_response(
    response: AShareScreenerResponse,
    cache_status: str,
) -> AShareScreenerResponse:
    return response.model_copy(
        update={
            "cache_status": cache_status,
            "cache_ttl_seconds": SCREENER_CACHE_TTL_SECONDS,
            "fetched_at": datetime.now(UTC),
        }
    )


def _screener_cache_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    cached = _SCREENER_CACHE.get(key)
    if not cached:
        return None
    cached_at, response = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_CACHE_TTL_SECONDS):
        _SCREENER_CACHE.pop(key, None)
        return None
    return _screener_cached_response(response, "hit")


def _screener_cache_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    if SCREENER_CACHE_TTL_SECONDS <= 0:
        return
    _SCREENER_CACHE[key] = (datetime.now(UTC), response)
    if len(_SCREENER_CACHE) > 64:
        oldest_key = min(_SCREENER_CACHE.items(), key=lambda item: item[1][0])[0]
        _SCREENER_CACHE.pop(oldest_key, None)


def _screener_cached_response_is_usable(response: AShareScreenerResponse) -> bool:
    if not is_clickhouse_enabled():
        return True
    return response.data_basis.startswith("clickhouse.")


def _screener_redis_key(key: tuple[str, str, str, int]) -> str:
    return _SCREENER_REDIS_CACHE.key(":".join(str(part) for part in ("screener", *key)))


async def _screener_redis_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    payload = await _SCREENER_REDIS_CACHE.read(_screener_redis_key(key))
    if payload is None:
        return None
    try:
        response = AShareScreenerResponse.model_validate(payload)
    except (TypeError, ValueError):
        return None
    return _screener_cached_response(response, "redis-hit")


async def _screener_redis_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    await _SCREENER_REDIS_CACHE.write(
        _screener_redis_key(key),
        ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
        payload=response.model_dump(mode="json"),
    )


async def screen_a_share_short_term_candidates(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    trade_date: date | None = None,
    mode: ScreenerMode = "short_term",
    limit: int = 20,
) -> AShareScreenerResponse:
    safe_limit = max(1, min(limit, 100))
    resolved_trade_date = trade_date
    requested_trade_date_input = trade_date
    trade_date_cache_key = _screener_trade_date_cache_key(
        universe_id=universe_id,
        trade_date=trade_date,
    )
    trade_date_cache_hit, cached_trade_date = _screener_trade_date_cache_get(trade_date_cache_key)
    if trade_date_cache_hit and cached_trade_date is not None:
        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=cached_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        cached = _screener_cache_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            return cached
        cached = await _screener_redis_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            _screener_cache_set(cache_key, cached)
            return cached

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        if trade_date_cache_hit:
            resolved_trade_date = cached_trade_date
        else:
            if resolved_trade_date is None:
                await cursor.execute(
                    """
                    WITH universe_config AS (
                      SELECT
                        id,
                        COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                        COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                      FROM quant.security_universes
                      WHERE id = %s
                    ),
                    target_members AS (
                      SELECT
                        members.symbol,
                        universe_config.timeframe,
                        universe_config.adjustment
                      FROM quant.security_universe_members members
                      JOIN universe_config
                        ON universe_config.id = members.universe_id
                      JOIN quant.securities securities
                        ON securities.symbol = members.symbol
                      WHERE members.universe_id = %s
                        AND securities.asset_type = 'stock'
                        AND COALESCE(members.role, 'member') <> 'inactive'
                        AND COALESCE(securities.status, 'active') NOT IN (
                          'inactive',
                          'delisted'
                        )
                    )
                    SELECT max((sync_state.last_ts AT TIME ZONE 'Asia/Shanghai')::date)
                      AS trade_date
                    FROM target_members
                    JOIN quant.market_data_sync_state sync_state
                      ON sync_state.symbol = target_members.symbol
                     AND sync_state.timeframe = target_members.timeframe
                     AND sync_state.adjustment = target_members.adjustment
                    WHERE sync_state.row_count > 0
                      AND sync_state.last_ts IS NOT NULL
                    """,
                    (universe_id, universe_id),
                )
                target_row = await cursor.fetchone()
                resolved_trade_date = target_row["trade_date"] if target_row else None

            if requested_trade_date_input is not None or resolved_trade_date is None:
                await cursor.execute(
                    """
                    WITH universe_config AS (
                      SELECT
                        id,
                        COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                        COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                      FROM quant.security_universes
                      WHERE id = %s
                    )
                    SELECT max((bars.ts AT TIME ZONE 'Asia/Shanghai')::date) AS trade_date
                    FROM quant.security_universe_members members
                    JOIN universe_config
                      ON universe_config.id = members.universe_id
                    JOIN quant.securities securities
                      ON securities.symbol = members.symbol
                    JOIN quant.stock_bars bars
                      ON bars.symbol = members.symbol
                     AND bars.timeframe = universe_config.timeframe
                     AND bars.adjustment = universe_config.adjustment
                    WHERE members.universe_id = %s
                      AND securities.asset_type = 'stock'
                      AND COALESCE(members.role, 'member') <> 'inactive'
                      AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                      AND (
                        %s::date IS NULL
                        OR bars.ts < ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                      )
                    """,
                    (universe_id, universe_id, resolved_trade_date, resolved_trade_date),
                )
                target_row = await cursor.fetchone()
                resolved_trade_date = target_row["trade_date"] if target_row else None
            _screener_trade_date_cache_set(trade_date_cache_key, resolved_trade_date)

        if resolved_trade_date is None:
            return AShareScreenerResponse(
                universe_id=universe_id,
                mode=mode,
                trade_date=None,
                scanned_symbols=0,
                limit=safe_limit,
                candidates=[],
                notes=["本地股票池尚未找到可筛选的交易日。"],
            )

        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=resolved_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        cached = _screener_cache_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            return cached
        cached = await _screener_redis_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            _screener_cache_set(cache_key, cached)
            return cached

        data_basis = "timescaledb.stock_bars"
        clickhouse_note: str | None = None
        analytics = AnalyticsExecutionMetadata(
            engine="timescaledb",
            status="disabled" if not is_clickhouse_enabled() else "fallback",
            basis=data_basis,
            target_trade_date=resolved_trade_date,
        )
        rows: list[dict[str, Any]] = []
        if is_clickhouse_enabled():
            try:
                clickhouse_trade_date, clickhouse_rows = await query_screener_feature_rows(
                    universe_id=universe_id,
                    trade_date=resolved_trade_date,
                    timeframe="daily",
                    adjustment="qfq",
                )
                auto_sync_status: Literal["not_needed", "synced", "skipped", "error"] = "not_needed"
                auto_sync_rows_written = 0
                if clickhouse_trade_date != resolved_trade_date:
                    sync_start = (
                        resolved_trade_date - timedelta(days=260)
                        if clickhouse_trade_date is None
                        else min(clickhouse_trade_date + timedelta(days=1), resolved_trade_date)
                    )
                    sync_response = await sync_clickhouse_daily_bars(
                        universe_id=universe_id,
                        start=sync_start,
                        end=resolved_trade_date,
                        timeframe="daily",
                        adjustment="qfq",
                        limit=None,
                    )
                    auto_sync_rows_written = sync_response.rows_written
                    if sync_response.status == "ok" and sync_response.rows_written > 0:
                        auto_sync_status = "synced"
                        clickhouse_trade_date, clickhouse_rows = await query_screener_feature_rows(
                            universe_id=universe_id,
                            trade_date=resolved_trade_date,
                            timeframe="daily",
                            adjustment="qfq",
                        )
                        clickhouse_note = (
                            f"ClickHouse 已自动同步 {sync_response.rows_written} 行日线后重试筛选。"
                        )
                    elif sync_response.status == "error":
                        auto_sync_status = "error"
                        clickhouse_note = (
                            "ClickHouse 自动同步失败，已回退 TimescaleDB："
                            f"{sync_response.message}"
                        )
                    else:
                        auto_sync_status = "skipped"
                        clickhouse_note = "ClickHouse 无新增可同步日线，已回退 TimescaleDB。"

                if clickhouse_trade_date == resolved_trade_date and clickhouse_rows:
                    rows = clickhouse_rows
                    data_basis = "clickhouse.quant_bars_daily"
                    analytics = AnalyticsExecutionMetadata(
                        engine="clickhouse",
                        status="hit",
                        basis=data_basis,
                        target_trade_date=resolved_trade_date,
                        clickhouse_trade_date=clickhouse_trade_date,
                        auto_sync_status=auto_sync_status,
                        auto_sync_rows_written=auto_sync_rows_written,
                        message=clickhouse_note or "本次筛选使用 ClickHouse 分析表生成横截面特征。",
                    )
                    clickhouse_note = analytics.message
                elif clickhouse_trade_date == resolved_trade_date:
                    clickhouse_note = "ClickHouse 未返回可用筛选特征，已回退 TimescaleDB。"
                elif clickhouse_trade_date is not None:
                    clickhouse_note = (
                        "ClickHouse 分析表最新交易日为 "
                        f"{clickhouse_trade_date.isoformat()}，"
                        "与 TimescaleDB 目标交易日不一致，已回退 TimescaleDB。"
                    )
                if data_basis.startswith("timescaledb."):
                    analytics = AnalyticsExecutionMetadata(
                        engine="timescaledb",
                        status="fallback",
                        basis=data_basis,
                        target_trade_date=resolved_trade_date,
                        clickhouse_trade_date=clickhouse_trade_date,
                        auto_sync_status=auto_sync_status,
                        auto_sync_rows_written=auto_sync_rows_written,
                        message=clickhouse_note,
                    )
            except Exception as error:
                clickhouse_note = f"ClickHouse 查询失败，已回退 TimescaleDB：{error}"
                analytics = AnalyticsExecutionMetadata(
                    engine="timescaledb",
                    status="error",
                    basis=data_basis,
                    target_trade_date=resolved_trade_date,
                    auto_sync_status="error",
                    message=clickhouse_note,
                )

        if not rows:
            await cursor.execute(
                """
                WITH universe_config AS (
                  SELECT
                    id,
                    COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                    COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                  FROM quant.security_universes
                  WHERE id = %s
                ),
                member_symbols AS (
                  SELECT
                    securities.symbol,
                    securities.code,
                    securities.name,
                    securities.exchange,
                    securities.metadata AS security_metadata,
                    universe_config.timeframe,
                    universe_config.adjustment
                  FROM quant.security_universe_members members
                  JOIN universe_config
                    ON universe_config.id = members.universe_id
                  JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                  WHERE members.universe_id = %s
                    AND securities.asset_type = 'stock'
                    AND COALESCE(members.role, 'member') <> 'inactive'
                    AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                    AND securities.exchange <> 'BJ'
                    AND securities.code !~ '^(688|8|4)'
                    AND securities.name NOT ILIKE '%%ST%%'
                ),
                features AS (
                  SELECT
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata,
                    count(recent_bars.*)::INT AS sample_count,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_trade_date,
                    max(recent_bars.provider) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_provider,
                    max(recent_bars.open) FILTER (WHERE recent_bars.rn = 1) AS latest_open,
                    max(recent_bars.high) FILTER (WHERE recent_bars.rn = 1) AS latest_high,
                    max(recent_bars.low) FILTER (WHERE recent_bars.rn = 1) AS latest_low,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 1) AS latest_close,
                    max(recent_bars.previous_close) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS previous_close,
                    max(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_amount,
                    max(recent_bars.turnover) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_turnover,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_change_percent,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 2
                    ) AS previous_change_percent,
                    bool_or(recent_bars.limit_up) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_limit_up,
                    bool_or(recent_bars.is_st) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_is_st,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 5) AS ma5,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 10) AS ma10,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 20) AS ma20,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 30) AS ma30,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 60) AS ma60,
                    avg(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn <= 20 AND recent_bars.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 21) AS close_20d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 4 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_4d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_10d,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    ) AS latest_limit_up_date
                  FROM member_symbols members
                  LEFT JOIN LATERAL (
                    SELECT
                      local_bars.*,
                      row_number() OVER (ORDER BY local_bars.ts DESC) AS rn
                    FROM (
                      SELECT
                        bars.ts,
                        (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
                        bars.open,
                        bars.high,
                        bars.low,
                        bars.close,
                        bars.previous_close,
                        bars.amount,
                        bars.volume,
                        bars.turnover,
                        bars.change_percent,
                        bars.limit_up,
                        bars.is_st,
                        bars.provider
                      FROM quant.stock_bars bars
                      WHERE bars.symbol = members.symbol
                        AND bars.timeframe = members.timeframe
                        AND bars.adjustment = members.adjustment
                        AND bars.ts >= (
                          (%s::date - 260)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                        AND bars.ts < (
                          (%s::date + 1)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                      ORDER BY bars.ts DESC
                      LIMIT 60
                    ) local_bars
                  ) recent_bars ON TRUE
                  GROUP BY
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata
                )
                SELECT
                  features.*,
                  %s::date AS requested_trade_date,
                  count(*) OVER ()::INT AS scanned_symbols
                FROM features
                WHERE features.latest_trade_date = %s::date
                  AND COALESCE(features.latest_is_st, FALSE) IS FALSE
                  AND COALESCE(features.latest_limit_up, FALSE) IS FALSE
                  AND features.latest_close IS NOT NULL
                  AND features.sample_count >= 20
                """,
                (
                    universe_id,
                    universe_id,
                    resolved_trade_date,
                    resolved_trade_date,
                    resolved_trade_date,
                    resolved_trade_date,
                ),
            )
            rows = await cursor.fetchall()

    def passes_mode(row: dict[str, Any]) -> bool:
        close = decimal_or_none(row.get("latest_close"))
        open_price = decimal_or_none(row.get("latest_open"))
        previous_close = decimal_or_none(row.get("previous_close"))
        amount = decimal_or_none(row.get("latest_amount"))
        avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
        amount_ratio = decimal_ratio(amount, avg_amount_20d)
        ma5 = decimal_or_none(row.get("ma5"))
        ma10 = decimal_or_none(row.get("ma10"))
        ma20 = decimal_or_none(row.get("ma20"))
        ma30 = decimal_or_none(row.get("ma30"))
        ma60 = decimal_or_none(row.get("ma60"))
        latest_change = decimal_or_none(row.get("latest_change_percent"))
        previous_change = decimal_or_none(row.get("previous_change_percent"))
        strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
        has_ma_stack_60 = all(
            value is not None for value in (ma5, ma10, ma20, ma30, ma60)
        ) and ma5 >= ma10 >= ma20 >= ma30 >= ma60
        has_ma_stack_20 = all(
            value is not None for value in (ma5, ma10, ma20)
        ) and ma5 >= ma10 >= ma20
        has_liquidity = amount is not None and amount >= Decimal("100000000")
        if mode == "limit_up_relay":
            return bool(
                int(row.get("limit_up_count_4d") or 0) >= 1
                and has_ma_stack_60
                and close is not None
                and ma5 is not None
                and close >= ma5
                and open_price is not None
                and previous_close is not None
                and open_price > previous_close
                and latest_change is not None
                and latest_change > 0
                and previous_change is not None
                and previous_change >= 0
                and has_liquidity
            )
        if mode == "trend_liquidity":
            return bool(
                has_ma_stack_20
                and close is not None
                and ma5 is not None
                and close >= ma5
                and strength_20d is not None
                and strength_20d > 0
                and amount_ratio is not None
                and amount_ratio >= Decimal("1.1")
                and has_liquidity
            )
        return bool(
            has_liquidity
            and close is not None
            and ma5 is not None
            and close >= ma5
            and latest_change is not None
            and latest_change > 0
            and (
                has_ma_stack_60
                or int(row.get("limit_up_count_4d") or 0) >= 1
                or (
                    strength_20d is not None
                    and strength_20d >= Decimal("8")
                    and amount_ratio is not None
                    and amount_ratio >= Decimal("1.2")
                )
            )
        )

    filtered_rows = [row for row in rows if passes_mode(row)]
    filtered_rows.sort(key=_screener_score, reverse=True)
    candidates: list[AShareScreenerCandidate] = []
    for row in filtered_rows[:safe_limit]:
        sector_fields = security_sector_fields(row["security_metadata"])
        amount_ratio = decimal_ratio(
            decimal_or_none(row.get("latest_amount")),
            decimal_or_none(row.get("avg_amount_20d")),
        )
        candidate = AShareScreenerCandidate(
            symbol=str(row["symbol"]),
            code=str(row["code"]),
            name=row["name"],
            exchange=row["exchange"] or "UNKNOWN",
            sector_tags=sector_fields["sector_tags"],
            trade_date=row["latest_trade_date"],
            close=decimal_or_none(row.get("latest_close")),
            open=decimal_or_none(row.get("latest_open")),
            high=decimal_or_none(row.get("latest_high")),
            low=decimal_or_none(row.get("latest_low")),
            previous_close=decimal_or_none(row.get("previous_close")),
            change_percent=decimal_or_none(row.get("latest_change_percent")),
            amount=decimal_or_none(row.get("latest_amount")),
            turnover=decimal_or_none(row.get("latest_turnover")),
            ma5=decimal_or_none(row.get("ma5")),
            ma10=decimal_or_none(row.get("ma10")),
            ma20=decimal_or_none(row.get("ma20")),
            ma30=decimal_or_none(row.get("ma30")),
            ma60=decimal_or_none(row.get("ma60")),
            strength_20d_pct=percent_change(
                decimal_or_none(row.get("latest_close")),
                decimal_or_none(row.get("close_20d")),
            ),
            amount_ratio_20d=amount_ratio,
            limit_up_count_4d=int(row.get("limit_up_count_4d") or 0),
            limit_up_count_10d=int(row.get("limit_up_count_10d") or 0),
            latest_limit_up_date=row.get("latest_limit_up_date"),
            is_limit_up=bool_or_none(row.get("latest_limit_up")),
            is_st=bool_or_none(row.get("latest_is_st")),
            sample_count=int(row.get("sample_count") or 0),
            score=_screener_score(row),
            signals=_screener_signals(row),
            warnings=_screener_warnings(row),
            missing_fields=_screener_missing_fields(row),
        )
        candidates.append(candidate)

    response_trade_date = next(
        (row.get("latest_trade_date") for row in rows if row.get("latest_trade_date")),
        resolved_trade_date,
    )
    notes = [
        (
            "本接口通过 QuantPilot market-data API 读取 ClickHouse 分析表；"
            "skills 不直接访问数据库。"
            if data_basis.startswith("clickhouse.")
            else (
                "本接口只通过 QuantPilot market-data API 读取本地 TimescaleDB；"
                "skills 不直接访问数据库。"
            )
        ),
        "当前 DDE 大单金额/大单净量未落库，候选结果使用日线 OHLCV、涨跌停、均线和流动性代理。",
    ]
    if clickhouse_note:
        notes.append(clickhouse_note)
    if requested_trade_date_input is not None and response_trade_date != requested_trade_date_input:
        notes.append(
            f"用户请求交易日 {requested_trade_date_input.isoformat()} 本地没有完整股票池覆盖，"
            f"已使用不晚于该日期的最近可用交易日 {response_trade_date.isoformat()}。"
        )
    response = AShareScreenerResponse(
        universe_id=universe_id,
        mode=mode,
        trade_date=response_trade_date,
        scanned_symbols=int(rows[0]["scanned_symbols"] or len(rows)) if rows else 0,
        limit=safe_limit,
        candidates=candidates,
        data_basis=data_basis,
        analytics=analytics.model_copy(update={"basis": data_basis}),
        notes=notes,
        cache_status="miss",
        cache_ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
    )
    if response_trade_date is not None and _screener_cached_response_is_usable(response):
        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=response_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        _screener_cache_set(cache_key, response)
        await _screener_redis_set(cache_key, response)
    return response


TECHNICAL_SCREENER_FIELD_LABELS: dict[str, str] = {
    "open": "开盘价",
    "close": "收盘价",
    "high": "最高价",
    "low": "最低价",
    "previous_close": "昨收",
    "change_percent": "涨跌幅",
    "amount": "成交额",
    "volume": "成交量",
    "turnover": "换手率",
    "ma5": "MA5",
    "ma10": "MA10",
    "ma20": "MA20",
    "ma30": "MA30",
    "ma60": "MA60",
    "strength_5d_pct": "5日强弱",
    "strength_10d_pct": "10日强弱",
    "strength_20d_pct": "20日强弱",
    "strength_60d_pct": "60日强弱",
    "amount_ratio_20d": "成交额/20日均额",
    "volume_ratio_20d": "成交量/20日均量",
    "close_to_ma5_pct": "收盘价距MA5",
    "close_to_ma20_pct": "收盘价距MA20",
    "close_to_ma60_pct": "收盘价距MA60",
    "limit_up_count_4d": "4日涨停次数",
    "limit_up_count_10d": "10日涨停次数",
    "sample_count": "样本根数",
    "score": "综合分",
    "is_limit_up": "当日涨停",
    "is_st": "ST",
}
TECHNICAL_SCREENER_FIELD_LABELS.update(
    {
        field: label
        for field, label in TECHNICAL_INDICATOR_FIELD_LABELS.items()
        if field not in TECHNICAL_SCREENER_FIELD_LABELS
    }
)

TECHNICAL_NUMERIC_FIELDS = {
    field
    for field in TECHNICAL_SCREENER_FIELD_LABELS
    if field not in {"is_limit_up", "is_st"}
}
TECHNICAL_BOOLEAN_FIELDS = {"is_limit_up", "is_st"}


def _technical_screener_field_label(field: str) -> str:
    return TECHNICAL_SCREENER_FIELD_LABELS.get(field, field)


def _ensure_technical_field(field: str) -> None:
    if field not in TECHNICAL_SCREENER_FIELD_LABELS:
        allowed = "、".join(sorted(TECHNICAL_SCREENER_FIELD_LABELS))
        raise ValueError(f"不支持的技术筛选字段：{field}。允许字段：{allowed}")


def _technical_value(row: dict[str, Any], field: str) -> Decimal | bool | None:
    _ensure_technical_field(field)
    close = decimal_or_none(row.get("latest_close"))
    if field == "open":
        return decimal_or_none(row.get("latest_open"))
    if field == "close":
        return close
    if field == "high":
        return decimal_or_none(row.get("latest_high"))
    if field == "low":
        return decimal_or_none(row.get("latest_low"))
    if field == "previous_close":
        return decimal_or_none(row.get("previous_close"))
    if field == "change_percent":
        return decimal_or_none(row.get("latest_change_percent"))
    if field == "amount":
        return decimal_or_none(row.get("latest_amount"))
    if field == "volume":
        return decimal_or_none(row.get("latest_volume"))
    if field == "turnover":
        return decimal_or_none(row.get("latest_turnover"))
    if field in TECHNICAL_INDICATOR_FIELD_LABELS:
        direct = decimal_or_none(row.get(field))
        if direct is not None:
            return direct
    if field in {"ma5", "ma10", "ma20", "ma30", "ma60", "ma120", "ma250"}:
        return decimal_or_none(row.get(field))
    if field == "strength_5d_pct":
        return percent_change(close, decimal_or_none(row.get("close_5d")))
    if field == "strength_10d_pct":
        return percent_change(close, decimal_or_none(row.get("close_10d")))
    if field == "strength_20d_pct":
        return percent_change(close, decimal_or_none(row.get("close_20d")))
    if field == "strength_60d_pct":
        return percent_change(close, decimal_or_none(row.get("close_60d")))
    if field == "amount_ratio_20d":
        return decimal_ratio(
            decimal_or_none(row.get("latest_amount")),
            decimal_or_none(row.get("avg_amount_20d")),
        )
    if field == "amount_ratio_5d":
        return decimal_ratio(
            decimal_or_none(row.get("latest_amount")),
            decimal_or_none(row.get("avg_amount_5d")),
        )
    if field == "volume_ratio_20d":
        return decimal_ratio(
            decimal_or_none(row.get("latest_volume")),
            decimal_or_none(row.get("avg_volume_20d")),
        )
    if field == "volume_ratio_5d":
        return decimal_ratio(
            decimal_or_none(row.get("latest_volume")),
            decimal_or_none(row.get("avg_volume_5d")),
        )
    if field == "turnover_avg_20d":
        return decimal_or_none(row.get("avg_turnover_20d"))
    if field == "close_to_ma5_pct":
        return percent_change(close, decimal_or_none(row.get("ma5")))
    if field == "close_to_ma20_pct":
        return percent_change(close, decimal_or_none(row.get("ma20")))
    if field == "close_to_ma60_pct":
        return percent_change(close, decimal_or_none(row.get("ma60")))
    if field == "close_to_ma120_pct":
        return percent_change(close, decimal_or_none(row.get("ma120")))
    if field == "limit_up_count_4d":
        return Decimal(int(row.get("limit_up_count_4d") or 0))
    if field == "limit_up_count_10d":
        return Decimal(int(row.get("limit_up_count_10d") or 0))
    if field == "sample_count":
        return Decimal(int(row.get("sample_count") or 0))
    if field == "score":
        return _screener_score(row)
    if field == "is_limit_up":
        return bool_or_none(row.get("latest_limit_up")) is True
    if field == "is_st":
        return bool_or_none(row.get("latest_is_st")) is True
    return None


def _technical_condition_rhs(
    condition: TechnicalScreenerCondition,
    row: dict[str, Any],
) -> Decimal | bool | None:
    if condition.value_field:
        _ensure_technical_field(condition.value_field)
        return _technical_value(row, condition.value_field)
    if isinstance(condition.value, bool):
        return condition.value
    if condition.value is None:
        return None
    return decimal_or_none(condition.value)


def _technical_condition_passes(
    condition: TechnicalScreenerCondition,
    row: dict[str, Any],
) -> bool:
    _ensure_technical_field(condition.field)
    left = _technical_value(row, condition.field)
    right = _technical_condition_rhs(condition, row)
    if condition.field in TECHNICAL_BOOLEAN_FIELDS:
        if condition.operator != "eq":
            raise ValueError(f"布尔字段 {condition.field} 只支持 eq 操作符")
        return left is right
    if condition.operator == "between":
        if left is None or condition.value is None or condition.upper_value is None:
            return False
        lower = decimal_or_none(condition.value)
        upper = decimal_or_none(condition.upper_value)
        return lower is not None and upper is not None and lower <= left <= upper
    if left is None or right is None:
        return False
    if condition.operator == "gt":
        return left > right
    if condition.operator == "gte":
        return left >= right
    if condition.operator == "lt":
        return left < right
    if condition.operator == "lte":
        return left <= right
    if condition.operator == "eq":
        return left == right
    return False


def _technical_condition_label(condition: TechnicalScreenerCondition) -> str:
    if condition.label:
        return condition.label
    field = _technical_screener_field_label(condition.field)
    op = {
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
        "eq": "=",
        "between": "介于",
    }[condition.operator]
    if condition.value_field:
        target = _technical_screener_field_label(condition.value_field)
    elif condition.operator == "between":
        target = f"{condition.value} 到 {condition.upper_value}"
    else:
        target = str(condition.value)
    return f"{field} {op} {target}"


def _technical_candidate_signals(
    row: dict[str, Any],
    conditions: list[TechnicalScreenerCondition],
) -> list[str]:
    signals = _screener_signals(row)
    for condition in conditions:
        label = _technical_condition_label(condition)
        if label not in signals:
            signals.append(label)
    return signals[:10]


def _technical_screener_sort_key(
    row: dict[str, Any],
    field: str,
) -> Decimal:
    value = _technical_value(row, field)
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal("1") if value else Decimal("0")
    return Decimal("-999999999")


async def _resolve_technical_screener_trade_date(
    cursor,
    *,
    universe_id: str,
    trade_date: date | None,
    timeframe: str,
    adjustment: str,
) -> date | None:
    await cursor.execute(
        """
        SELECT max((bars.ts AT TIME ZONE 'Asia/Shanghai')::date) AS trade_date
        FROM quant.security_universe_members members
        JOIN quant.securities securities
          ON securities.symbol = members.symbol
        JOIN quant.stock_bars bars
          ON bars.symbol = members.symbol
         AND bars.timeframe = %s
         AND bars.adjustment = %s
        WHERE members.universe_id = %s
          AND securities.asset_type = 'stock'
          AND COALESCE(members.role, 'member') <> 'inactive'
          AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
          AND (
            %s::date IS NULL
            OR bars.ts < ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
          )
        """,
        (timeframe, adjustment, universe_id, trade_date, trade_date),
    )
    row = await cursor.fetchone()
    return row["trade_date"] if row else None


def _enrich_technical_screener_row(row: dict[str, Any]) -> dict[str, Any]:
    history = row.get("bar_history") or []
    if not isinstance(history, list):
        return row
    feature_rows = build_technical_feature_rows(history)
    if not feature_rows:
        return row
    latest_features = feature_rows[-1]
    for field in TECHNICAL_INDICATOR_FIELD_LABELS:
        value = latest_features.get(field)
        if value is not None:
            row[field] = value
    return row


async def _fetch_technical_screener_rows(
    cursor,
    *,
    universe_id: str,
    trade_date: date,
    timeframe: str,
    adjustment: str,
    min_sample_count: int,
    exclude_st: bool,
    exclude_limit_up: bool,
) -> list[dict[str, Any]]:
    await cursor.execute(
        """
        WITH member_symbols AS (
          SELECT
            securities.symbol,
            securities.code,
            securities.name,
            securities.exchange,
            securities.metadata AS security_metadata
          FROM quant.security_universe_members members
          JOIN quant.securities securities
            ON securities.symbol = members.symbol
          WHERE members.universe_id = %s
            AND securities.asset_type = 'stock'
            AND COALESCE(members.role, 'member') <> 'inactive'
            AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
            AND securities.exchange <> 'BJ'
            AND securities.code !~ '^(688|8|4)'
        ),
        features AS (
          SELECT
            members.symbol,
            members.code,
            members.name,
            members.exchange,
            members.security_metadata,
            count(recent_bars.*)::INT AS sample_count,
            max(recent_bars.trade_date) FILTER (WHERE recent_bars.rn = 1)
              AS latest_trade_date,
            max(recent_bars.provider) FILTER (WHERE recent_bars.rn = 1)
              AS latest_provider,
            max(recent_bars.open) FILTER (WHERE recent_bars.rn = 1) AS latest_open,
            max(recent_bars.high) FILTER (WHERE recent_bars.rn = 1) AS latest_high,
            max(recent_bars.low) FILTER (WHERE recent_bars.rn = 1) AS latest_low,
            max(recent_bars.close) FILTER (WHERE recent_bars.rn = 1) AS latest_close,
            max(recent_bars.previous_close) FILTER (WHERE recent_bars.rn = 1)
              AS previous_close,
            max(recent_bars.amount) FILTER (WHERE recent_bars.rn = 1)
              AS latest_amount,
            max(recent_bars.volume) FILTER (WHERE recent_bars.rn = 1)
              AS latest_volume,
            max(recent_bars.turnover) FILTER (WHERE recent_bars.rn = 1)
              AS latest_turnover,
            max(recent_bars.change_percent) FILTER (WHERE recent_bars.rn = 1)
              AS latest_change_percent,
            max(recent_bars.change_percent) FILTER (WHERE recent_bars.rn = 2)
              AS previous_change_percent,
            bool_or(recent_bars.limit_up) FILTER (WHERE recent_bars.rn = 1)
              AS latest_limit_up,
            bool_or(recent_bars.is_st) FILTER (WHERE recent_bars.rn = 1)
              AS latest_is_st,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 5) AS ma5,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 10) AS ma10,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 20) AS ma20,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 30) AS ma30,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 60) AS ma60,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 120) AS ma120,
            avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 250) AS ma250,
            avg(recent_bars.amount) FILTER (
              WHERE recent_bars.rn <= 5 AND recent_bars.amount IS NOT NULL
            ) AS avg_amount_5d,
            avg(recent_bars.amount) FILTER (
              WHERE recent_bars.rn <= 20 AND recent_bars.amount IS NOT NULL
            ) AS avg_amount_20d,
            avg(recent_bars.volume) FILTER (
              WHERE recent_bars.rn <= 5 AND recent_bars.volume IS NOT NULL
            ) AS avg_volume_5d,
            avg(recent_bars.volume) FILTER (
              WHERE recent_bars.rn <= 20 AND recent_bars.volume IS NOT NULL
            ) AS avg_volume_20d,
            avg(recent_bars.turnover) FILTER (
              WHERE recent_bars.rn <= 20 AND recent_bars.turnover IS NOT NULL
            ) AS avg_turnover_20d,
            max(recent_bars.close) FILTER (WHERE recent_bars.rn = 6) AS close_5d,
            max(recent_bars.close) FILTER (WHERE recent_bars.rn = 11) AS close_10d,
            max(recent_bars.close) FILTER (WHERE recent_bars.rn = 21) AS close_20d,
            max(recent_bars.close) FILTER (WHERE recent_bars.rn = 61) AS close_60d,
            count(*) FILTER (
              WHERE recent_bars.rn <= 4 AND recent_bars.limit_up IS TRUE
            )::INT AS limit_up_count_4d,
            count(*) FILTER (
              WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
            )::INT AS limit_up_count_10d,
            max(recent_bars.trade_date) FILTER (
              WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
            ) AS latest_limit_up_date,
            jsonb_agg(
              jsonb_build_object(
                'date', recent_bars.trade_date,
                'open', recent_bars.open,
                'high', recent_bars.high,
                'low', recent_bars.low,
                'close', recent_bars.close,
                'previous_close', recent_bars.previous_close,
                'amount', recent_bars.amount,
                'volume', recent_bars.volume,
                'turnover', recent_bars.turnover,
                'amplitude', recent_bars.amplitude
              )
              ORDER BY recent_bars.rn DESC
            ) FILTER (WHERE recent_bars.rn IS NOT NULL) AS bar_history
          FROM member_symbols members
          LEFT JOIN LATERAL (
            SELECT
              local_bars.*,
              row_number() OVER (ORDER BY local_bars.ts DESC) AS rn
            FROM (
              SELECT
                bars.ts,
                (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
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
                bars.provider
              FROM quant.stock_bars bars
              WHERE bars.symbol = members.symbol
                AND bars.timeframe = %s
                AND bars.adjustment = %s
                AND bars.ts >= ((%s::date - 460)::timestamp AT TIME ZONE 'Asia/Shanghai')
                AND bars.ts < ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
              ORDER BY bars.ts DESC
              LIMIT 260
            ) local_bars
          ) recent_bars ON TRUE
          GROUP BY
            members.symbol,
            members.code,
            members.name,
            members.exchange,
            members.security_metadata
        )
        SELECT
          features.*,
          count(*) OVER ()::INT AS scanned_symbols
        FROM features
        WHERE features.latest_trade_date = %s::date
          AND features.latest_close IS NOT NULL
          AND features.sample_count >= %s
          AND (%s IS FALSE OR COALESCE(features.latest_is_st, FALSE) IS FALSE)
          AND (%s IS FALSE OR COALESCE(features.latest_limit_up, FALSE) IS FALSE)
        """,
        (
            universe_id,
            timeframe,
            adjustment,
            trade_date,
            trade_date,
            trade_date,
            min_sample_count,
            exclude_st,
            exclude_limit_up,
        ),
    )
    rows = await cursor.fetchall()
    return [_enrich_technical_screener_row(row) for row in rows]


def _technical_candidate_from_row(
    row: dict[str, Any],
    conditions: list[TechnicalScreenerCondition],
) -> AShareScreenerCandidate:
    sector_fields = security_sector_fields(row["security_metadata"])
    amount_ratio = decimal_ratio(
        decimal_or_none(row.get("latest_amount")),
        decimal_or_none(row.get("avg_amount_20d")),
    )
    return AShareScreenerCandidate(
        symbol=str(row["symbol"]),
        code=str(row["code"]),
        name=row["name"],
        exchange=row["exchange"] or "UNKNOWN",
        sector_tags=sector_fields["sector_tags"],
        trade_date=row["latest_trade_date"],
        close=decimal_or_none(row.get("latest_close")),
        open=decimal_or_none(row.get("latest_open")),
        high=decimal_or_none(row.get("latest_high")),
        low=decimal_or_none(row.get("latest_low")),
        previous_close=decimal_or_none(row.get("previous_close")),
        change_percent=decimal_or_none(row.get("latest_change_percent")),
        amount=decimal_or_none(row.get("latest_amount")),
        turnover=decimal_or_none(row.get("latest_turnover")),
        ma5=decimal_or_none(row.get("ma5")),
        ma10=decimal_or_none(row.get("ma10")),
        ma20=decimal_or_none(row.get("ma20")),
        ma30=decimal_or_none(row.get("ma30")),
        ma60=decimal_or_none(row.get("ma60")),
        strength_20d_pct=percent_change(
            decimal_or_none(row.get("latest_close")),
            decimal_or_none(row.get("close_20d")),
        ),
        amount_ratio_20d=amount_ratio,
        limit_up_count_4d=int(row.get("limit_up_count_4d") or 0),
        limit_up_count_10d=int(row.get("limit_up_count_10d") or 0),
        latest_limit_up_date=row.get("latest_limit_up_date"),
        is_limit_up=bool_or_none(row.get("latest_limit_up")),
        is_st=bool_or_none(row.get("latest_is_st")),
        sample_count=int(row.get("sample_count") or 0),
        score=_screener_score(row),
        signals=_technical_candidate_signals(row, conditions),
        warnings=_screener_warnings(row),
        missing_fields=_screener_missing_fields(row),
    )


async def screen_a_share_technical_strategy(
    request: TechnicalScreenerRequest,
) -> TechnicalScreenerResponse:
    spec = request.spec
    timeframe = str(spec.timeframe)
    adjustment = str(spec.adjustment)
    if timeframe != "daily":
        raise ValueError("技术选股当前只支持 daily K 线")
    for condition in spec.conditions:
        _ensure_technical_field(condition.field)
        if condition.value_field:
            _ensure_technical_field(condition.value_field)
    _ensure_technical_field(spec.sort.field)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        trade_date = await _resolve_technical_screener_trade_date(
            cursor,
            universe_id=request.universe_id,
            trade_date=request.trade_date,
            timeframe=timeframe,
            adjustment=adjustment,
        )
        if trade_date is None:
            return TechnicalScreenerResponse(
                universe_id=request.universe_id,
                trade_date=None,
                scanned_symbols=0,
                limit=request.limit,
                spec=spec,
                candidates=[],
                notes=["本地股票池尚未找到可筛选的交易日。"],
            )
        rows = await _fetch_technical_screener_rows(
            cursor,
            universe_id=request.universe_id,
            trade_date=trade_date,
            timeframe=timeframe,
            adjustment=adjustment,
            min_sample_count=spec.min_sample_count,
            exclude_st=spec.exclude_st,
            exclude_limit_up=spec.exclude_limit_up,
        )

    filtered_rows = [
        row
        for row in rows
        if all(_technical_condition_passes(condition, row) for condition in spec.conditions)
    ]
    reverse = spec.sort.direction == "desc"
    filtered_rows.sort(
        key=lambda row: _technical_screener_sort_key(row, spec.sort.field),
        reverse=reverse,
    )
    safe_limit = max(1, min(request.limit, 100))
    candidates = [
        _technical_candidate_from_row(row, spec.conditions)
        for row in filtered_rows[:safe_limit]
    ]
    response_trade_date = next(
        (row.get("latest_trade_date") for row in rows if row.get("latest_trade_date")),
        trade_date,
    )
    notes = [
        (
            "EMA/RSI/MACD, candlestick morphology, and volume features are computed "
            "deterministically from the latest local daily bars."
        ),
        "LLM 只生成白名单策略 JSON；实际筛选由 QuantPilot market-data 后端执行。",
        "当前技术筛选使用本地 TimescaleDB 日 K、均线、强弱、成交额/成交量放大和涨停次数。",
        "DDE 大单资金、分钟线盘口和行业中性化不在本接口内，不能把代理指标当真实资金流。",
    ]
    return TechnicalScreenerResponse(
        universe_id=request.universe_id,
        trade_date=response_trade_date,
        scanned_symbols=int(rows[0]["scanned_symbols"] or len(rows)) if rows else 0,
        limit=safe_limit,
        spec=spec,
        candidates=candidates,
        analytics=AnalyticsExecutionMetadata(
            engine="timescaledb",
            status="disabled",
            basis="timescaledb.stock_bars",
            target_trade_date=response_trade_date,
            message="自定义技术筛选当前固定读取 TimescaleDB 横截面特征。",
        ),
        notes=notes,
    )
