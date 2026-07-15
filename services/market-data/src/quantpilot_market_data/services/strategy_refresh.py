from __future__ import annotations

import os
import shutil
from collections.abc import Iterable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.data_profiles import StrategyDataProfile
from quantpilot_market_data.database_core import ROOT_DIR
from quantpilot_market_data.indicators import build_technical_indicators
from quantpilot_market_data.models import (
    KlineResponse,
    StrategyDataProfileInfo,
    StrategyRefreshItem,
    StrategyRefreshResponse,
)
from quantpilot_market_data.providers.base import QuoteReadProvider
from quantpilot_market_data.providers.tushare import TushareClient, TushareError
from quantpilot_market_data.repositories.bars import get_local_kline
from quantpilot_market_data.repositories.upserts import (
    upsert_kline_response,
    upsert_realtime_quote_snapshot,
)
from quantpilot_market_data.services.quotes import (
    get_history_quote,
    intraday_cache_date,
    intraday_cache_expires_at,
    intraday_cache_ttl_seconds,
    intraday_redis_cache_key,
    with_intraday_fetch_metadata,
)

CN_TZ = ZoneInfo("Asia/Shanghai")


async def refresh_strategy_data(
    *,
    profile: StrategyDataProfile,
    symbols: list[str],
    universe_id: str | None,
    force: bool,
    client: QuoteReadProvider,
    cache: MarketDataCache,
    redis_cache: RedisJsonCache,
    tushare_client: TushareClient,
    kline_cache_ttl_seconds: int,
) -> StrategyRefreshResponse:
    normalized_symbols = list(
        dict.fromkeys(symbol.strip().upper() for symbol in symbols if symbol.strip())
    )
    if len(normalized_symbols) > profile.max_symbols:
        raise ValueError(f"{profile.id} 单次最多处理 {profile.max_symbols} 只股票。")

    if profile.id == "daily_live_5m":
        items = await _refresh_live_daily_snapshots(
            profile=profile,
            symbols=normalized_symbols,
            universe_id=universe_id,
            force=force,
            client=client,
            redis_cache=redis_cache,
        )
    elif profile.id == "daily_eod":
        items = [
            await _refresh_daily_symbol(
                profile=profile,
                symbol=symbol,
                universe_id=universe_id,
                force=force,
                client=client,
                tushare_client=tushare_client,
            )
            for symbol in normalized_symbols
        ]
    elif profile.id == "minute_backtest":
        items = [
            await _refresh_minute_backtest_symbol(
                profile=profile,
                symbol=symbol,
                universe_id=universe_id,
                force=force,
                tushare_client=tushare_client,
            )
            for symbol in normalized_symbols
        ]
    else:
        items = [
            await _refresh_intraday_symbol(
                profile=profile,
                symbol=symbol,
                force=force,
                client=client,
                cache=cache,
                redis_cache=redis_cache,
                tushare_client=tushare_client,
                kline_cache_ttl_seconds=kline_cache_ttl_seconds,
            )
            for symbol in normalized_symbols
        ]

    statuses = {item.status for item in items}
    if not items or statuses == {"unavailable"}:
        overall_status = "unavailable"
    elif "unavailable" in statuses or "degraded" in statuses:
        overall_status = "partial"
    elif "refreshed" in statuses:
        overall_status = "refreshed"
    else:
        overall_status = "ready"
    warnings = []
    if any(item.status == "degraded" for item in items):
        warnings.append("部分标的使用了过期缓存；日线筛选结果仍可继续使用。")
    if any(item.status == "unavailable" for item in items):
        warnings.append("部分分钟源不可用；系统没有用动态日K冒充真实分钟K。")
    return StrategyRefreshResponse(
        status=overall_status,
        profile=StrategyDataProfileInfo.model_validate(profile.to_dict()),
        job_id=f"strategy-refresh-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}",
        universe_id=universe_id,
        items=items,
        warnings=warnings,
    )


async def _refresh_daily_symbol(
    *,
    profile: StrategyDataProfile,
    symbol: str,
    universe_id: str | None,
    force: bool,
    client: QuoteReadProvider,
    tushare_client: TushareClient,
) -> StrategyRefreshItem:
    try:
        local = await get_local_kline(
            symbol=symbol,
            timeframe="daily",
            adjustment="qfq",
            limit=profile.window_bars,
            include_metadata=True,
        )
    except Exception as error:
        local = None
        local_error = str(error)
    else:
        local_error = None

    expected_date = expected_latest_daily_date()
    last_ts = local.summary.last_ts if local else None
    stale = last_ts is None or last_ts.astimezone(CN_TZ).date() < expected_date
    if local and local.bars and not force and not stale:
        latest = local.bars[-1]
        missing = _missing_market_fields(latest.amount, latest.turnover)
        return StrategyRefreshItem(
            symbol=local.symbol,
            name=local.name,
            status="ready",
            period="daily",
            requested_bars=profile.window_bars,
            returned_bars=len(local.bars),
            source=local.provider or "timescaledb",
            storage=profile.storage,
            as_of=last_ts,
            fetched_at=local.fetched_at,
            cache_status="local-hit",
            stale=False,
            missing_fields=missing,
            warnings=_missing_field_warnings(missing),
        )

    try:
        provider_warnings: list[str] = []
        if tushare_client.configured:
            try:
                kline = await tushare_client.get_kline(
                    symbol,
                    period="daily",
                    adjustment="qfq",
                    limit=profile.window_bars,
                )
            except TushareError as error:
                provider_warnings.append(f"Tushare 日线不可用，已回退免费源：{error}")
                kline = None
        else:
            kline = None
        if kline is None:
            kline = await client.get_kline(
                symbol,
                period="daily",
                adjustment="qfq",
                limit=profile.window_bars,
                allow_fallback=True,
            )
        _, rows_upserted, _, _ = await upsert_kline_response(
            kline,
            universe_id=universe_id,
            lookback_years=3,
        )
        latest = kline.bars[-1] if kline.bars else None
        missing = list(kline.data_quality.missing_fields)
        if latest:
            missing.extend(_missing_market_fields(latest.amount, latest.turnover))
        missing = list(dict.fromkeys(missing))
        return StrategyRefreshItem(
            symbol=symbol,
            name=kline.name,
            status="refreshed",
            period="daily",
            requested_bars=profile.window_bars,
            returned_bars=rows_upserted,
            source=kline.source,
            storage=profile.storage,
            as_of=kline.as_of,
            fetched_at=kline.fetched_at,
            cache_status="miss",
            stale=False,
            missing_fields=missing,
            warnings=list(
                dict.fromkeys(
                    [
                        *provider_warnings,
                        *kline.data_quality.warnings,
                        *_missing_field_warnings(missing),
                    ]
                )
            ),
        )
    except Exception as error:
        if local and local.bars:
            return StrategyRefreshItem(
                symbol=symbol,
                name=local.name,
                status="degraded",
                period="daily",
                requested_bars=profile.window_bars,
                returned_bars=len(local.bars),
                source=local.provider or "timescaledb",
                storage=profile.storage,
                as_of=last_ts,
                fetched_at=local.fetched_at,
                cache_status="local-stale",
                stale=True,
                warnings=["外部日线刷新失败，保留本地历史数据。"],
                error=str(error),
            )
        return StrategyRefreshItem(
            symbol=symbol,
            status="unavailable",
            period="daily",
            requested_bars=profile.window_bars,
            source=None,
            storage=profile.storage,
            stale=True,
            error=str(error) if str(error) else local_error,
        )


async def _refresh_live_daily_snapshots(
    *,
    profile: StrategyDataProfile,
    symbols: list[str],
    universe_id: str | None,
    force: bool,
    client: QuoteReadProvider,
    redis_cache: RedisJsonCache,
) -> list[StrategyRefreshItem]:
    ready_items: dict[str, StrategyRefreshItem] = {}
    stale_payloads: dict[str, StrategyRefreshItem] = {}
    pending: list[str] = []
    for symbol in symbols:
        cached_payload = await redis_cache.read(_live_snapshot_cache_key(symbol))
        cached_item = _cached_refresh_item(cached_payload)
        if cached_item:
            age = _age_seconds(cached_item.fetched_at)
            cached_item.age_seconds = age
            cached_item.stale = age is None or age > profile.max_staleness_seconds
            cached_item.cache_status = "redis-hit"
            if not force and not cached_item.stale:
                cached_item.status = "ready"
                ready_items[symbol] = cached_item
                continue
            stale_payloads[symbol] = cached_item
        pending.append(symbol)

    refreshed_items: dict[str, StrategyRefreshItem] = {}
    for chunk in _chunks(pending, 100):
        if not chunk:
            continue
        try:
            quotes = await client.get_realtime_quotes(chunk)
        except Exception as error:
            for symbol in chunk:
                stale_item = stale_payloads.get(symbol)
                if stale_item:
                    stale_item.status = "degraded"
                    stale_item.stale = True
                    stale_item.warnings = list(
                        dict.fromkeys([*stale_item.warnings, "盘中快照刷新失败，保留过期缓存。"])
                    )
                    stale_item.error = str(error)
                    refreshed_items[symbol] = stale_item
                else:
                    refreshed_items[symbol] = _unavailable_item(profile, symbol, str(error))
            continue

        quote_by_alias = {
            alias: quote
            for quote in quotes
            for alias in _symbol_aliases(quote.symbol, quote.secid)
        }
        for symbol in chunk:
            quote = next(
                (
                    quote_by_alias.get(alias)
                    for alias in _symbol_aliases(symbol, None)
                    if alias in quote_by_alias
                ),
                None,
            )
            if quote is None:
                refreshed_items[symbol] = _unavailable_item(
                    profile,
                    symbol,
                    "行情源未返回该标的的盘中快照。",
                )
                continue
            _, rows_upserted, _, _ = await upsert_realtime_quote_snapshot(
                quote,
                universe_id=universe_id,
                adjustment="qfq",
            )
            missing = list(dict.fromkeys([
                *quote.data_quality.missing_fields,
                *_missing_market_fields(quote.amount, quote.turnover),
            ]))
            item = StrategyRefreshItem(
                symbol=symbol,
                name=quote.name,
                status="refreshed",
                period="daily",
                requested_bars=1,
                returned_bars=rows_upserted,
                source=quote.source,
                storage=profile.storage,
                as_of=quote.as_of,
                fetched_at=quote.fetched_at,
                cache_status="miss",
                stale=False,
                age_seconds=0,
                missing_fields=missing,
                warnings=list(
                    dict.fromkeys(
                        [*quote.data_quality.warnings, *_missing_field_warnings(missing)]
                    )
                ),
            )
            await redis_cache.write(
                _live_snapshot_cache_key(symbol),
                ttl_seconds=max(900, profile.max_staleness_seconds * 2),
                payload=item.model_dump(mode="json"),
            )
            refreshed_items[symbol] = item

    return [ready_items.get(symbol) or refreshed_items[symbol] for symbol in symbols]


async def _refresh_intraday_symbol(
    *,
    profile: StrategyDataProfile,
    symbol: str,
    force: bool,
    client: QuoteReadProvider,
    cache: MarketDataCache,
    redis_cache: RedisJsonCache,
    tushare_client: TushareClient,
    kline_cache_ttl_seconds: int,
) -> StrategyRefreshItem:
    free_source_error: Exception | None = None
    try:
        response = await get_history_quote(
            client,
            cache,
            redis_cache,
            symbol=symbol,
            period=profile.period,
            adjustment="none",
            limit=profile.window_bars,
            end="20500101",
            refresh=force,
            ttl_seconds=kline_cache_ttl_seconds,
        )
        age = _age_seconds(response.fetch.cached_at or response.fetched_at)
        stale = age is None or age > profile.max_staleness_seconds
        if stale and not force:
            response = await get_history_quote(
                client,
                cache,
                redis_cache,
                symbol=symbol,
                period=profile.period,
                adjustment="none",
                limit=profile.window_bars,
                end="20500101",
                refresh=True,
                ttl_seconds=kline_cache_ttl_seconds,
            )
            age = _age_seconds(response.fetch.cached_at or response.fetched_at)
            stale = age is None or age > profile.max_staleness_seconds
        if stale and _paid_realtime_minute_enabled(tushare_client):
            try:
                response = await _get_paid_realtime_minutes(
                    profile=profile,
                    symbol=symbol,
                    redis_cache=redis_cache,
                    tushare_client=tushare_client,
                )
            except Exception as error:
                free_source_error = error
            else:
                age = 0
                stale = False
        status = (
            "degraded"
            if stale
            else "ready"
            if response.fetch.cache_status == "redis-hit"
            else "refreshed"
        )
        warnings = list(response.data_quality.warnings)
        if stale:
            warnings.append("真实分钟源刷新失败，返回的是过期分钟缓存；未使用动态日K替代。")
            if free_source_error is not None:
                warnings.append(f"Tushare 实时分钟兜底也不可用：{free_source_error}")
        return _minute_item_from_kline(
            profile=profile,
            symbol=symbol,
            response=response,
            status=status,
            stale=stale,
            age_seconds=age,
            warnings=warnings,
        )
    except Exception as error:
        free_source_error = error
        if _paid_realtime_minute_enabled(tushare_client):
            try:
                response = await _get_paid_realtime_minutes(
                    profile=profile,
                    symbol=symbol,
                    redis_cache=redis_cache,
                    tushare_client=tushare_client,
                )
            except Exception as paid_error:
                free_source_error = RuntimeError(
                    f"免费分钟源失败：{error}；Tushare 实时分钟源失败：{paid_error}"
                )
            else:
                return _minute_item_from_kline(
                    profile=profile,
                    symbol=symbol,
                    response=response,
                    status="refreshed",
                    stale=False,
                    age_seconds=0,
                    warnings=list(response.data_quality.warnings),
                )
        return _unavailable_item(
            profile,
            symbol,
            f"真实{_period_label(profile.period)}不可用：{free_source_error}",
        )


async def _get_paid_realtime_minutes(
    *,
    profile: StrategyDataProfile,
    symbol: str,
    redis_cache: RedisJsonCache,
    tushare_client: TushareClient,
) -> KlineResponse:
    response = await tushare_client.get_realtime_minutes(
        symbol,
        period=profile.period,
        limit=profile.window_bars,
    )
    cache_date = intraday_cache_date()
    cache_key = intraday_redis_cache_key(
        symbol=symbol,
        period=profile.period,
        cache_date=cache_date,
        limit=profile.window_bars,
    )
    ttl_seconds = intraday_cache_ttl_seconds(cache_date)
    response_with_metadata = with_intraday_fetch_metadata(
        response,
        status="miss",
        cache_key=cache_key,
        ttl_seconds=ttl_seconds,
        expires_at=intraday_cache_expires_at(cache_date).astimezone(UTC),
    )
    written = await redis_cache.write(
        cache_key,
        ttl_seconds=ttl_seconds,
        payload=response_with_metadata.model_dump(mode="json"),
    )
    if written:
        return response_with_metadata
    return with_intraday_fetch_metadata(
        response,
        status="disabled",
        cache_key=cache_key,
        ttl_seconds=ttl_seconds,
        expires_at=intraday_cache_expires_at(cache_date).astimezone(UTC),
    )


def _paid_realtime_minute_enabled(tushare_client: TushareClient) -> bool:
    return tushare_client.configured and _env_enabled(
        "QUANTPILOT_TUSHARE_REALTIME_MINUTE_ENABLED",
        False,
    )


async def _refresh_minute_backtest_symbol(
    *,
    profile: StrategyDataProfile,
    symbol: str,
    universe_id: str | None,
    force: bool,
    tushare_client: TushareClient,
) -> StrategyRefreshItem:
    del force
    if not _env_enabled("QUANTPILOT_MINUTE_BACKTEST_ENABLED", False):
        return _unavailable_item(
            profile,
            symbol,
            "分钟回测默认关闭；购买历史分钟权限后设置 QUANTPILOT_MINUTE_BACKTEST_ENABLED=1。",
        )
    if not tushare_client.configured:
        return _unavailable_item(profile, symbol, "分钟回测需要服务器端 TUSHARE_TOKEN。")
    disk = shutil.disk_usage(Path(ROOT_DIR))
    used_percent = (disk.used / disk.total) * 100 if disk.total else 0
    if used_percent >= 80:
        return _unavailable_item(
            profile,
            symbol,
            f"磁盘使用率 {used_percent:.1f}% 已达到80%，暂停新的分钟持久化任务。",
        )
    try:
        response = await tushare_client.get_kline(
            symbol,
            period=profile.period,
            adjustment="none",
            limit=profile.window_bars,
        )
        _, rows_upserted, _, _ = await upsert_kline_response(
            response,
            universe_id=universe_id,
            lookback_years=1,
        )
        return _minute_item_from_kline(
            profile=profile,
            symbol=symbol,
            response=response,
            status="refreshed",
            stale=False,
            age_seconds=0,
            warnings=["分钟回测数据已写入TimescaleDB，保留90天。"],
            returned_bars=rows_upserted,
        )
    except TushareError as error:
        return _unavailable_item(profile, symbol, str(error))


def expected_latest_daily_date(now: datetime | None = None) -> date:
    current = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    candidate = current.date()
    if current.weekday() < 5 and current.time() < time(hour=15, minute=20):
        candidate -= timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def _minute_item_from_kline(
    *,
    profile: StrategyDataProfile,
    symbol: str,
    response: KlineResponse,
    status: str,
    stale: bool,
    age_seconds: int | None,
    warnings: list[str],
    returned_bars: int | None = None,
) -> StrategyRefreshItem:
    indicator_summary = build_technical_indicators(response).summary.model_dump(mode="json")
    return StrategyRefreshItem(
        symbol=symbol,
        name=response.name,
        status=status,  # type: ignore[arg-type]
        period=profile.period,
        requested_bars=profile.window_bars,
        returned_bars=len(response.bars) if returned_bars is None else returned_bars,
        source=response.source,
        storage=profile.storage,
        as_of=response.as_of,
        fetched_at=response.fetch.cached_at or response.fetched_at,
        cache_status=response.fetch.cache_status,
        stale=stale,
        age_seconds=age_seconds,
        missing_fields=response.data_quality.missing_fields,
        warnings=list(dict.fromkeys(warnings)),
        indicators=indicator_summary,
    )


def _unavailable_item(
    profile: StrategyDataProfile,
    symbol: str,
    error: str,
) -> StrategyRefreshItem:
    return StrategyRefreshItem(
        symbol=symbol,
        status="unavailable",
        period=profile.period,
        requested_bars=profile.window_bars,
        source=None,
        storage=profile.storage,
        stale=True,
        error=error,
    )


def _cached_refresh_item(payload: dict[str, object] | None) -> StrategyRefreshItem | None:
    if payload is None:
        return None
    try:
        return StrategyRefreshItem.model_validate(payload)
    except ValueError:
        return None


def _age_seconds(value: datetime | None) -> int | None:
    if value is None:
        return None
    normalized = value if value.tzinfo else value.replace(tzinfo=UTC)
    return max(0, int((datetime.now(UTC) - normalized.astimezone(UTC)).total_seconds()))


def _live_snapshot_cache_key(symbol: str) -> str:
    return f"strategy-profile:daily_live_5m:{symbol.strip().upper()}"


def _missing_market_fields(amount: object | None, turnover: object | None) -> list[str]:
    missing: list[str] = []
    if amount is None:
        missing.append("amount")
    if turnover is None:
        missing.append("turnover")
    return missing


def _missing_field_warnings(missing: list[str]) -> list[str]:
    if not missing:
        return []
    return [f"字段 {', '.join(missing)} 缺失；相关策略条件会跳过该标的，不会把空值当作0。"]


def _period_label(period: str) -> str:
    return "1分钟K" if period == "minute1" else "5分钟K" if period == "minute5" else period


def _chunks(values: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _symbol_aliases(symbol: str, secid: str | None) -> set[str]:
    normalized = symbol.strip().upper()
    aliases = {normalized, normalized.split(".", 1)[0]}
    if secid:
        aliases.add(secid.strip().upper())
        aliases.add(secid.rsplit(".", 1)[-1])
    return aliases


def _env_enabled(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}
