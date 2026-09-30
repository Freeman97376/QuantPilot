from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import quantpilot_market_data.providers.baostock as baostock_module
from quantpilot_market_data.providers.baostock import (
    baostock_code,
    baostock_volume_hands,
    is_a_share_stock_code,
    limit_marker_from_pct,
    parse_baostock_records,
)


def test_baostock_code_normalizes_common_a_share_codes() -> None:
    assert baostock_code("002156.SZ") == "sz.002156"
    assert baostock_code("1.600519") == "sh.600519"
    assert baostock_code("SH600519") == "sh.600519"


def test_baostock_volume_is_converted_from_shares_to_hands() -> None:
    assert baostock_volume_hands({"volume": "198689180"}) == 1986892


def test_parse_baostock_records_maps_enrichment_fields() -> None:
    bars = parse_baostock_records(
        [
            {
                "date": "2026-05-28",
                "code": "sz.002156",
                "open": "69.50",
                "high": "70.88",
                "low": "67.60",
                "close": "69.30",
                "preclose": "71.44",
                "volume": "196100000",
                "amount": "136200000.50",
                "turn": "1.72",
                "pctChg": "-2.9969",
                "tradestatus": "1",
                "isST": "0",
                "peTTM": "65.346712",
                "pbMRQ": "6.036094",
            }
        ]
    )

    assert len(bars) == 1
    assert bars[0].date == "2026-05-28"
    assert bars[0].volume == 1961000
    assert bars[0].amount == Decimal("136200000.50")
    assert bars[0].turnover == Decimal("1.72")
    assert bars[0].change_percent == Decimal("-2.9969")
    assert bars[0].change_amount == Decimal("-2.14")
    assert bars[0].amplitude == Decimal("4.59126540")
    assert bars[0].previous_close == Decimal("71.44")
    assert bars[0].trade_status == "1"
    assert bars[0].is_st is False
    assert bars[0].limit_up is False
    assert bars[0].limit_down is False
    assert bars[0].metadata["factors"]["pe_ttm"] == "65.346712"
    assert bars[0].metadata["factors"]["pb_mrq"] == "6.036094"
    assert bars[0].metadata["volume_unit"] == "hands"


def test_limit_marker_uses_a_share_board_thresholds() -> None:
    assert (
        limit_marker_from_pct(code="sz.002156", change_percent=Decimal("9.91"), is_st=False)
        == "up"
    )
    assert (
        limit_marker_from_pct(code="sz.300750", change_percent=Decimal("10.01"), is_st=False)
        is None
    )
    assert (
        limit_marker_from_pct(code="sz.300750", change_percent=Decimal("20.01"), is_st=False)
        == "up"
    )
    assert (
        limit_marker_from_pct(code="sh.600745", change_percent=Decimal("-4.96"), is_st=True)
        == "down"
    )


def test_baostock_ignores_etf_is_st_flag() -> None:
    assert is_a_share_stock_code("sh.510300") is False
    bars = parse_baostock_records(
        [
            {
                "date": "2026-05-28",
                "code": "sh.510300",
                "open": "4.85",
                "high": "4.90",
                "low": "4.80",
                "close": "4.88",
                "preclose": "4.86",
                "volume": "100000",
                "amount": "488000.00",
                "turn": "0.12",
                "pctChg": "0.41",
                "tradestatus": "1",
                "isST": "1",
            }
        ]
    )
    assert bars[0].is_st is False


def test_baostock_sdk_sessions_are_serialized(monkeypatch) -> None:
    active = 0
    peak_active = 0
    state_lock = threading.Lock()

    def fake_fetch(*_args):
        nonlocal active, peak_active
        with state_lock:
            active += 1
            peak_active = max(peak_active, active)
        time.sleep(0.03)
        with state_lock:
            active -= 1
        return []

    monkeypatch.setattr(
        baostock_module,
        "_fetch_baostock_history_records_unlocked",
        fake_fetch,
    )
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(
                baostock_module.fetch_baostock_history_records,
                "sh.600519",
                "d",
                "2026-01-01",
                "2026-01-31",
                "2",
            )
            for _ in range(4)
        ]
        assert [future.result() for future in futures] == [[], [], [], []]

    assert peak_active == 1
