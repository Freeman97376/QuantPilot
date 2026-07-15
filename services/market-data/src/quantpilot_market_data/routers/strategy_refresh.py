from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.data_profiles import (
    get_strategy_data_profile,
    list_strategy_data_profiles,
)
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.models import (
    StrategyDataProfileInfo,
    StrategyRefreshRequest,
    StrategyRefreshResponse,
)
from quantpilot_market_data.providers.base import QuoteReadProvider
from quantpilot_market_data.providers.tushare import TushareClient
from quantpilot_market_data.repositories.strategy_data import (
    ACTIVE_UNIVERSE_ID,
    DEFAULT_SOURCE_UNIVERSE_ID,
    get_strategy_data_audit,
    refresh_active_universe,
)
from quantpilot_market_data.repositories.universes import get_universe_fetch_targets
from quantpilot_market_data.services.strategy_refresh import refresh_strategy_data


def create_strategy_refresh_router(
    *,
    client: QuoteReadProvider,
    cache: MarketDataCache,
    redis_cache: RedisJsonCache,
    tushare_client: TushareClient,
    kline_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/ingestion", tags=["strategy-refresh"])
    profile_refresh_locks: dict[str, asyncio.Lock] = {}

    @router.get("/strategy-profiles", response_model=list[StrategyDataProfileInfo])
    async def get_strategy_profiles() -> list[StrategyDataProfileInfo]:
        return [
            StrategyDataProfileInfo.model_validate(profile.to_dict())
            for profile in list_strategy_data_profiles()
        ]

    @router.post("/strategy-refresh", response_model=StrategyRefreshResponse)
    async def post_strategy_refresh(
        request: StrategyRefreshRequest,
    ) -> StrategyRefreshResponse:
        try:
            profile = get_strategy_data_profile(request.profile)
            symbols = list(request.symbols or [])
            if not symbols and request.universe_id:
                targets = await get_universe_fetch_targets(request.universe_id)
                symbols = [target["symbol"] for target in targets]
            if not symbols:
                raise HTTPException(
                    status_code=400,
                    detail="必须提供 symbols，或提供包含成员的 universe_id。",
                )
            if request.profile.startswith("minute") and request.symbols is None:
                raise HTTPException(
                    status_code=400,
                    detail="分钟分析必须显式传入日线筛选结果中的候选 symbols，单次最多20只。",
                )
            profile_lock = profile_refresh_locks.setdefault(profile.id, asyncio.Lock())
            async with profile_lock:
                return await refresh_strategy_data(
                    profile=profile,
                    symbols=symbols,
                    universe_id=request.universe_id,
                    force=request.force,
                    client=client,
                    cache=cache,
                    redis_cache=redis_cache,
                    tushare_client=tushare_client,
                    kline_cache_ttl_seconds=kline_cache_ttl_seconds,
                )
        except HTTPException:
            raise
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.post("/active-pool/rebuild")
    async def rebuild_active_pool(
        source_universe_id: str = DEFAULT_SOURCE_UNIVERSE_ID,
        active_universe_id: str = ACTIVE_UNIVERSE_ID,
        limit: int = 300,
    ) -> dict[str, object]:
        try:
            return await refresh_active_universe(
                source_universe_id=source_universe_id,
                active_universe_id=active_universe_id,
                limit=limit,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get("/strategy-audit")
    async def strategy_data_audit(run_retention: bool = False) -> dict[str, object]:
        try:
            return await get_strategy_data_audit(run_retention=run_retention)
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    return router
