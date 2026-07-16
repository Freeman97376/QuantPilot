from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class MarketRepository(Protocol):
    async def initialize(self) -> None: ...
    async def health(self) -> dict[str, Any]: ...
    async def upsert_kline(
        self, kline: Any, **options: Any
    ) -> tuple[str, int, str | None, str | None]: ...
    async def local_kline_rows(self, **query: Any) -> list[dict[str, Any]]: ...


@runtime_checkable
class CoverageRepository(Protocol):
    async def coverage(self, *, universe_id: str | None = None) -> list[dict[str, Any]]: ...


@runtime_checkable
class UniverseRepository(Protocol):
    async def universe_symbols(self, universe_id: str) -> list[str]: ...


@runtime_checkable
class IngestionRepository(Protocol):
    async def create_ingestion_job(self, **job: Any) -> None: ...
    async def update_ingestion_job(self, job_id: str, **updates: Any) -> None: ...
    async def ingestion_control(self, job_id: str) -> str | None: ...


@runtime_checkable
class BacktestRepository(Protocol):
    async def save_backtest(
        self, run: dict[str, Any], orders: Iterable[dict[str, Any]]
    ) -> None: ...


@runtime_checkable
class CacheStore(Protocol):
    async def read(self, cache_key: str) -> dict[str, Any] | None: ...
    async def write(self, cache_key: str, *, ttl_seconds: int, payload: dict[str, Any]) -> bool: ...
    async def delete(self, cache_key: str) -> None: ...
