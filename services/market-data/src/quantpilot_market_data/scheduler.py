from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

import httpx

CN_TZ = ZoneInfo("Asia/Shanghai")


def is_cn_market_session(now: datetime | None = None) -> bool:
    current = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    if current.weekday() >= 5:
        return False
    current_time = current.time()
    morning_session = time(9, 25) <= current_time <= time(11, 35)
    afternoon_session = time(12, 55) <= current_time <= time(15, 5)
    return morning_session or afternoon_session


def is_cn_weekday(now: datetime | None = None) -> bool:
    current = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    return current.weekday() < 5


def calendar_says_closed(payload: dict[str, Any], trade_date: date) -> bool:
    days = payload.get("days")
    if not isinstance(days, list):
        return False
    for item in days:
        if not isinstance(item, dict) or item.get("trade_date") != trade_date.isoformat():
            continue
        return item.get("is_open") is False
    return False


class TieredRefreshExecutor:
    def __init__(self, base_url: str | None = None, timeout_seconds: float = 3_600) -> None:
        self.base_url = (
            base_url
            or os.getenv("QUANTPILOT_MARKET_API_URL")
            or "http://127.0.0.1:8000"
        ).rstrip("/")
        self.client = httpx.Client(base_url=self.base_url, timeout=timeout_seconds)

    def close(self) -> None:
        self.client.close()

    def active_snapshot(self, *, force: bool = False) -> dict[str, Any]:
        if not force and not is_cn_market_session():
            return {"status": "skipped", "reason": "outside-cn-a-session"}
        if not force and self._is_market_holiday():
            return {"status": "skipped", "reason": "cn-a-market-holiday"}
        return self._post(
            "/api/v1/ingestion/strategy-refresh",
            {
                "profile": "daily_live_5m",
                "universe_id": os.getenv(
                    "QUANTPILOT_ACTIVE_UNIVERSE_ID",
                    "a-share-active-300",
                ),
                "force": force,
            },
        )

    def bootstrap(self) -> dict[str, Any]:
        universe_id = os.getenv(
            "QUANTPILOT_DAILY_UNIVERSE_ID",
            "a-share-sample-research-pool",
        )
        page = 1
        imported = 0
        total_available = 0
        while True:
            payload = self._post(
                "/api/v1/research/a-share/import-batch",
                {
                    "universe_id": universe_id,
                    "page": page,
                    "page_size": 100,
                    "role": "member",
                },
            )
            imported += int(payload.get("imported_count") or 0)
            total_available = int(payload.get("total_available") or total_available)
            next_page = payload.get("next_page")
            if next_page is None:
                break
            page = int(next_page)
        backfill = self.repair(force=True)
        return {
            "status": "started",
            "universe_id": universe_id,
            "imported_count": imported,
            "total_available": total_available,
            "backfill": backfill,
        }

    def eod_snapshot(self, *, force: bool = False) -> dict[str, Any]:
        if not force and not is_cn_weekday():
            return {"status": "skipped", "reason": "weekend"}
        if not force and self._is_market_holiday():
            return {"status": "skipped", "reason": "cn-a-market-holiday"}
        source_universe = os.getenv(
            "QUANTPILOT_DAILY_UNIVERSE_ID",
            "a-share-sample-research-pool",
        )
        self._post(
            "/api/v1/ingestion/active-pool/rebuild",
            query={"source_universe_id": source_universe, "limit": "300"},
        )
        batches: list[dict[str, Any]] = []
        offset = 0
        while True:
            payload = self._post(
                "/api/v1/ingestion/eastmoney/realtime-snapshot",
                {
                    "universe_id": source_universe,
                    "adjustment": "qfq",
                    "batch_size": 200,
                    "offset": offset,
                    "request_delay_seconds": 0.2,
                },
            )
            batches.append(
                {
                    "status": payload.get("status"),
                    "completed_symbols": payload.get("completed_symbols"),
                    "failed_symbols": payload.get("failed_symbols"),
                    "rows_upserted": payload.get("rows_upserted"),
                    "batch_offset": payload.get("batch_offset"),
                }
            )
            next_offset = int(payload.get("next_offset") or 0)
            if next_offset == 0 or next_offset == offset:
                break
            offset = next_offset
        active_pool = self._post(
            "/api/v1/ingestion/active-pool/rebuild",
            query={"source_universe_id": source_universe, "limit": "300"},
        )
        return {"status": "completed", "batches": batches, "active_pool": active_pool}

    def repair(self, *, force: bool = False) -> dict[str, Any]:
        if not force and not is_cn_weekday():
            return {"status": "skipped", "reason": "weekend"}
        if not force and self._is_market_holiday():
            return {"status": "skipped", "reason": "cn-a-market-holiday"}
        return self._post(
            "/api/v1/ingestion/baostock/history/autofill",
            {
                "universe_id": os.getenv(
                    "QUANTPILOT_DAILY_UNIVERSE_ID",
                    "a-share-sample-research-pool",
                ),
                "period": "daily",
                "adjustment": "qfq",
                "limit": 750,
                "lookback_years": 3,
                "allow_fallback": False,
                "request_delay_seconds": 0.5,
                "max_retries": 2,
                "batch_size": 25,
                "offset": 0,
                "batch_delay_seconds": 0.5,
            },
        )

    def audit(self) -> dict[str, Any]:
        response = self.client.get(
            "/api/v1/ingestion/strategy-audit",
            params={"run_retention": "true"},
        )
        response.raise_for_status()
        return response.json()

    def _post(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        response = self.client.post(path, json=payload, params=query)
        response.raise_for_status()
        return response.json()

    def _is_market_holiday(self) -> bool:
        today = datetime.now(CN_TZ).date()
        try:
            response = self.client.get(
                "/api/v1/foundation/trading-calendar",
                params={
                    "market": "CN-A",
                    "start": today.isoformat(),
                    "end": today.isoformat(),
                    "limit": "2",
                },
            )
            response.raise_for_status()
            return calendar_says_closed(response.json(), today)
        except (httpx.HTTPError, ValueError):
            return False


def main() -> None:
    parser = argparse.ArgumentParser(description="QuantPilot tiered market-data executor")
    parser.add_argument("command", choices=("bootstrap", "active", "eod", "repair", "audit"))
    parser.add_argument("--force", action="store_true", help="ignore session/weekend guards")
    args = parser.parse_args()
    executor = TieredRefreshExecutor()
    try:
        if args.command == "bootstrap":
            result = executor.bootstrap()
        elif args.command == "active":
            result = executor.active_snapshot(force=args.force)
        elif args.command == "eod":
            result = executor.eod_snapshot(force=args.force)
        elif args.command == "repair":
            result = executor.repair(force=args.force)
        else:
            result = executor.audit()
        print(json.dumps(result, ensure_ascii=False, default=str))
    finally:
        executor.close()


if __name__ == "__main__":
    main()
