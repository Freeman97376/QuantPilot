from __future__ import annotations

from fastapi.testclient import TestClient

import quantpilot_market_data.api as api_module
from quantpilot_market_data.api import create_app
from quantpilot_market_data.database_core import DatabaseError


def _configure_server_health_test(monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_RUNTIME_MODE", "server")

    async def no_jobs(**_query):
        return []

    monkeypatch.setattr(api_module, "list_ingestion_jobs", no_jobs)


def test_server_health_probes_timescaledb(monkeypatch) -> None:
    _configure_server_health_test(monkeypatch)
    statements: list[str] = []

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def execute(self, statement: str):
            statements.append(statement)

    async def fake_connect():
        return FakeConnection()

    monkeypatch.setattr(api_module, "connect", fake_connect)
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "engine": "timescaledb",
        "database": "reachable",
    }
    assert statements == ["SELECT 1"]


def test_server_health_returns_503_when_timescaledb_is_unavailable(monkeypatch) -> None:
    _configure_server_health_test(monkeypatch)

    async def failing_connect():
        raise DatabaseError("fixture database failure")

    monkeypatch.setattr(api_module, "connect", failing_connect)
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 503
    assert response.json() == {"detail": "TimescaleDB is unavailable."}
