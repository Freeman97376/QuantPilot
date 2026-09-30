from __future__ import annotations

import os
from functools import lru_cache

from quantpilot_market_data.repositories.duckdb_repository import DuckDBMarketRepository


def is_desktop_repository() -> bool:
    return os.getenv("QUANTPILOT_RUNTIME_MODE", "server").strip().lower() == "desktop"


@lru_cache(maxsize=1)
def get_duckdb_repository() -> DuckDBMarketRepository:
    return DuckDBMarketRepository.from_environment()


async def initialize_runtime_repository() -> None:
    if is_desktop_repository():
        await get_duckdb_repository().initialize()


async def close_runtime_repository() -> None:
    if not is_desktop_repository():
        return
    repository = get_duckdb_repository()
    try:
        await repository.close()
    finally:
        get_duckdb_repository.cache_clear()
