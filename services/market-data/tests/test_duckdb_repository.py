from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.repositories.duckdb_repository import DuckDBMarketRepository
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
        assert health == {"status": "ok", "engine": "duckdb", "schema_version": 1}
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
        assert await repository.universe_symbols("fixture-universe") == [symbol]
        coverage = await repository.coverage(universe_id="fixture-universe")
        assert coverage[0]["row_count"] == 70

    asyncio.run(run())
