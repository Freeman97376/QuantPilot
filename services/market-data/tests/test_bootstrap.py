from __future__ import annotations

import asyncio
import threading
import time

from fastapi.testclient import TestClient

import quantpilot_market_data.api as api_module
from quantpilot_market_data.api import create_app
from quantpilot_market_data.models import AShareUniverseBatchImportResponse
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.repositories.factory import get_duckdb_repository


def _headers() -> dict[str, str]:
    return {"X-QuantPilot-Startup-Token": "bootstrap-test-token"}


def _configure_desktop(monkeypatch, database_path) -> None:
    monkeypatch.setenv("QUANTPILOT_RUNTIME_MODE", "desktop")
    monkeypatch.setenv("QUANTPILOT_STARTUP_TOKEN", "bootstrap-test-token")
    monkeypatch.setenv("QUANTPILOT_MARKET_DB_PATH", str(database_path))
    monkeypatch.setattr(api_module, "CATALOG_RETRY_DELAYS_SECONDS", (0, 0, 0))
    get_duckdb_repository.cache_clear()


def _jobs(client: TestClient, universe_id: str) -> list[dict[str, object]]:
    response = client.get(
        "/api/v1/ingestion/jobs",
        params={"universe_id": universe_id, "limit": 100},
        headers=_headers(),
    )
    assert response.status_code == 200
    return response.json()["jobs"]


def _wait_for_job(
    client: TestClient,
    universe_id: str,
    provider: str,
    status: str,
    *,
    timeout: float = 3,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = next(
            (
                item
                for item in _jobs(client, universe_id)
                if item["provider"] == provider and item["status"] == status
            ),
            None,
        )
        if job is not None:
            return job
        time.sleep(0.02)
    raise AssertionError(f"{provider} did not reach {status}")


def test_bootstrap_returns_quickly_reuses_job_and_persists_partial_resume(
    tmp_path,
    monkeypatch,
) -> None:
    universe_id = "bootstrap-partial"
    database_path = tmp_path / "market.duckdb"
    _configure_desktop(monkeypatch, database_path)
    attempts: list[int] = []

    async def fail_page(_client, request):
        attempts.append(request.page)
        raise EastMoneyError("temporary catalog failure")

    monkeypatch.setattr(api_module, "import_a_share_universe_batch", fail_page)
    try:
        with TestClient(create_app()) as client:
            started = time.monotonic()
            first = client.post(
                "/api/v1/ingestion/a-share/bootstrap",
                json={"universe_id": universe_id},
                headers=_headers(),
            )
            assert time.monotonic() - started < 5
            assert first.status_code == 202
            first_payload = first.json()
            assert first_payload["catalog_status"] == "running"
            assert first_payload["reused_existing_job"] is False

            partial = _wait_for_job(
                client,
                universe_id,
                "eastmoney-catalog",
                "partial",
            )
            assert len(attempts) == 4
            assert partial["metadata"]["next_page"] == 1
            assert partial["metadata"]["last_successful_page"] is None
            assert partial["metadata"]["auto_resume"] is True

            resumed = client.post(
                "/api/v1/ingestion/a-share/bootstrap",
                json={"universe_id": universe_id},
                headers=_headers(),
            )
            assert resumed.status_code == 202
            assert resumed.json()["catalog_job_id"] == first_payload["catalog_job_id"]
            assert resumed.json()["reused_existing_job"] is True

            deadline = time.monotonic() + 3
            while len(attempts) < 8 and time.monotonic() < deadline:
                time.sleep(0.02)
            assert attempts == [1] * 8
            partial = _wait_for_job(
                client,
                universe_id,
                "eastmoney-catalog",
                "partial",
            )
            assert partial["metadata"]["next_page"] == 1
    finally:
        get_duckdb_repository.cache_clear()


def test_partial_catalog_auto_resumes_after_restart_and_starts_one_history_job(
    tmp_path,
    monkeypatch,
) -> None:
    universe_id = "bootstrap-restart"
    database_path = tmp_path / "market.duckdb"
    _configure_desktop(monkeypatch, database_path)

    async def fail_page(_client, _request):
        raise EastMoneyError("restart fixture")

    monkeypatch.setattr(api_module, "import_a_share_universe_batch", fail_page)
    with TestClient(create_app()) as client:
        first = client.post(
            "/api/v1/ingestion/a-share/bootstrap",
            json={"universe_id": universe_id},
            headers=_headers(),
        )
        catalog_job_id = first.json()["catalog_job_id"]
        _wait_for_job(client, universe_id, "eastmoney-catalog", "partial")

    get_duckdb_repository.cache_clear()
    completed_pages: list[int] = []

    async def complete_page(_client, request):
        completed_pages.append(request.page)
        return AShareUniverseBatchImportResponse(
            universe_id=request.universe_id,
            page=request.page,
            page_size=request.page_size,
            total_available=1,
            total_pages=1,
            next_page=None,
            imported_count=1,
        )

    async def one_target(_universe_id):
        return [{"symbol": "600519.SH", "query": "600519", "asset_type": "stock"}]

    async def slow_history(*_args, **_kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(api_module, "import_a_share_universe_batch", complete_page)
    monkeypatch.setattr(api_module, "get_universe_fetch_targets", one_target)
    monkeypatch.setattr(api_module, "fetch_baostock_kline_for_ingestion", slow_history)
    try:
        with TestClient(create_app()) as client:
            completed = _wait_for_job(
                client,
                universe_id,
                "eastmoney-catalog",
                "completed",
            )
            assert completed["id"] == catalog_job_id
            assert completed["metadata"]["last_successful_page"] == 1
            assert completed["metadata"]["next_page"] is None
            assert completed_pages == [1]

            history = _wait_for_job(
                client,
                universe_id,
                "baostock-autofill",
                "running",
            )
            repeated = client.post(
                "/api/v1/ingestion/a-share/bootstrap",
                json={"universe_id": universe_id},
                headers=_headers(),
            )
            assert repeated.status_code == 202
            assert repeated.json()["reused_existing_job"] is True
            assert repeated.json()["history_job_id"] == history["id"]
            history_jobs = [
                job
                for job in _jobs(client, universe_id)
                if job["provider"] == "baostock-autofill"
            ]
            assert len(history_jobs) == 1
    finally:
        get_duckdb_repository.cache_clear()


def test_catalog_stop_during_page_fetch_is_not_overwritten(
    tmp_path,
    monkeypatch,
) -> None:
    universe_id = "bootstrap-stop-race"
    database_path = tmp_path / "market.duckdb"
    _configure_desktop(monkeypatch, database_path)
    entered = threading.Event()
    release = threading.Event()
    requested_pages: list[int] = []

    async def delayed_page(_client, request):
        requested_pages.append(request.page)
        entered.set()
        released = await asyncio.to_thread(release.wait, 2)
        assert released
        return AShareUniverseBatchImportResponse(
            universe_id=request.universe_id,
            page=request.page,
            page_size=request.page_size,
            total_available=2,
            total_pages=2,
            next_page=2,
            imported_count=1,
        )

    monkeypatch.setattr(api_module, "import_a_share_universe_batch", delayed_page)
    try:
        with TestClient(create_app()) as client:
            response = client.post(
                "/api/v1/ingestion/a-share/bootstrap",
                json={"universe_id": universe_id},
                headers=_headers(),
            )
            job_id = response.json()["catalog_job_id"]
            assert entered.wait(timeout=2)

            stopped = client.post(
                f"/api/v1/ingestion/jobs/{job_id}/control",
                json={"action": "stop"},
                headers=_headers(),
            )
            assert stopped.status_code == 200
            assert stopped.json()["control"] == "stop"
            release.set()

            partial = _wait_for_job(
                client,
                universe_id,
                "eastmoney-catalog",
                "partial",
            )
            assert partial["metadata"]["control"] == "stop"
            assert partial["metadata"]["auto_resume"] is False
            assert partial["metadata"]["stop_reason"] == "stopped"
            assert requested_pages == [1]
    finally:
        release.set()
        get_duckdb_repository.cache_clear()


def test_stopped_catalog_is_not_auto_resumed_after_restart(tmp_path, monkeypatch) -> None:
    universe_id = "bootstrap-stopped"
    database_path = tmp_path / "market.duckdb"
    _configure_desktop(monkeypatch, database_path)
    entered = threading.Event()
    attempts = 0

    async def blocking_page(_client, _request):
        nonlocal attempts
        attempts += 1
        entered.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(api_module, "import_a_share_universe_batch", blocking_page)
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/v1/ingestion/a-share/bootstrap",
            json={"universe_id": universe_id},
            headers=_headers(),
        )
        job_id = response.json()["catalog_job_id"]
        assert entered.wait(timeout=2)
        stopped = client.post(
            f"/api/v1/ingestion/jobs/{job_id}/control",
            json={"action": "stop"},
            headers=_headers(),
        )
        assert stopped.status_code == 200
        assert stopped.json()["control"] == "stop"

    get_duckdb_repository.cache_clear()
    with TestClient(create_app()) as client:
        time.sleep(0.1)
        jobs = _jobs(client, universe_id)
        catalog = next(job for job in jobs if job["id"] == job_id)
        assert catalog["metadata"]["control"] == "stop"
        assert attempts == 1

    get_duckdb_repository.cache_clear()
