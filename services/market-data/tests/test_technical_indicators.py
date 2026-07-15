from __future__ import annotations

from decimal import Decimal

import pytest

from quantpilot_market_data.indicators import (
    build_technical_feature_rows,
    build_technical_indicators,
)
from quantpilot_market_data.models import KlineBar, KlineResponse, TechnicalScreenerCondition
from quantpilot_market_data.repositories.screener import (
    _enrich_technical_screener_row,
    _ensure_technical_field,
    _technical_condition_passes,
)


def test_candlestick_morphology_features_use_previous_close_denominator() -> None:
    features = build_technical_feature_rows(
        [
            {
                "date": "2026-06-01",
                "open": Decimal("10"),
                "high": Decimal("13"),
                "low": Decimal("9"),
                "close": Decimal("11"),
                "previous_close": Decimal("10"),
                "amount": Decimal("1000000"),
                "volume": 1000,
                "turnover": Decimal("2"),
            }
        ]
    )

    latest = features[-1]

    assert latest["upper_shadow_pct"] == Decimal("20.0000")
    assert latest["lower_shadow_pct"] == Decimal("10.0000")
    assert latest["body_pct"] == Decimal("10.0000")
    assert latest["amplitude"] == Decimal("40.0000")
    assert latest["close_position_pct"] == Decimal("50.0000")


def make_bars(count: int) -> list[KlineBar]:
    bars: list[KlineBar] = []
    close = Decimal("20")
    for index in range(count):
        previous_close = close
        close += Decimal("0.13") + (Decimal("0.05") if index % 17 == 0 else Decimal("0"))
        open_price = close - Decimal("0.08")
        bars.append(
            KlineBar(
                date=f"2025-{(index // 28) + 1:02d}-{(index % 28) + 1:02d}",
                open=open_price,
                high=close + Decimal("0.25"),
                low=open_price - Decimal("0.18"),
                close=close,
                previous_close=previous_close,
                volume=1_000_000 + index * 1_000,
                amount=close * Decimal("1000000"),
                turnover=Decimal("2") + Decimal(index % 5) / Decimal("10"),
            )
        )
    return bars


def test_build_technical_feature_rows_computes_extended_indicators() -> None:
    features = build_technical_feature_rows(make_bars(260))
    latest = features[-1]

    assert latest["ma120"] is not None
    assert latest["ma250"] is not None
    assert latest["ema12"] is not None
    assert latest["ema26"] is not None
    assert latest["rsi14"] is not None
    assert latest["macd_dif"] is not None
    assert latest["macd_dea"] is not None
    assert latest["macd_hist"] is not None
    assert latest["ma20_slope_5d_pct"] is not None
    assert latest["ma60_slope_20d_pct"] is not None
    assert latest["ma20_slope_5d_pct"] > Decimal("0")
    assert latest["amount_ratio_5d"] is not None
    assert latest["volume_ratio_20d"] is not None
    assert latest["turnover_avg_20d"] is not None


def test_build_technical_feature_rows_returns_none_for_insufficient_samples() -> None:
    latest = build_technical_feature_rows(make_bars(20))[-1]

    assert latest["ma250"] is None
    assert latest["ema26"] is None
    assert latest["macd_dif"] is None
    assert latest["macd_dea"] is None
    assert latest["ma60_slope_20d_pct"] is None


def test_build_technical_indicators_exposes_extended_summary_fields() -> None:
    kline = KlineResponse(
        symbol="002156",
        name="sample",
        secid="0.002156",
        asset_type="stock",
        market="SZ",
        source="fixture",
        period="daily",
        adjustment="qfq",
        bars=make_bars(260),
        fetched_at="2026-06-19T00:00:00Z",
    )

    indicators = build_technical_indicators(kline)

    assert indicators.points[-1].ma250 is not None
    assert indicators.points[-1].macd_dif is not None
    assert indicators.points[-1].ma20_slope_5d_pct is not None
    assert indicators.points[-1].ma60_slope_20d_pct is not None
    assert indicators.summary.ma250 == indicators.points[-1].ma250
    assert indicators.summary.macd_hist == indicators.points[-1].macd_hist
    assert indicators.summary.ma20_slope_5d_pct == indicators.points[-1].ma20_slope_5d_pct
    assert indicators.summary.upper_shadow_pct == indicators.points[-1].upper_shadow_pct


def test_technical_screener_accepts_new_fields_and_value_field_comparison() -> None:
    row = {
        "latest_close": Decimal("11"),
        "ma20": Decimal("10"),
        "macd_dif": Decimal("0.25"),
        "macd_dea": Decimal("0.10"),
        "ma20_slope_5d_pct": Decimal("2.1"),
        "upper_shadow_pct": Decimal("2.5"),
        "amount_ratio_5d": Decimal("1.6"),
    }

    assert _technical_condition_passes(
        TechnicalScreenerCondition(
            field="macd_dif",
            operator="gte",
            value_field="macd_dea",
        ),
        row,
    )
    assert _technical_condition_passes(
        TechnicalScreenerCondition(field="close", operator="gte", value_field="ma20"),
        row,
    )
    assert _technical_condition_passes(
        TechnicalScreenerCondition(field="upper_shadow_pct", operator="lte", value=Decimal("3")),
        row,
    )
    assert _technical_condition_passes(
        TechnicalScreenerCondition(field="ma20_slope_5d_pct", operator="gte", value=Decimal("2")),
        row,
    )
    assert _technical_condition_passes(
        TechnicalScreenerCondition(field="amount_ratio_5d", operator="gte", value=Decimal("1.5")),
        row,
    )


def test_technical_screener_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError):
        _ensure_technical_field("kdj_k")


def test_technical_screener_does_not_treat_missing_market_fields_as_zero() -> None:
    row = {
        "latest_amount": None,
        "latest_turnover": None,
        "avg_amount_20d": Decimal("1000000"),
    }

    assert not _technical_condition_passes(
        TechnicalScreenerCondition(field="amount", operator="gte", value=Decimal("0")),
        row,
    )
    assert not _technical_condition_passes(
        TechnicalScreenerCondition(field="turnover", operator="gte", value=Decimal("0")),
        row,
    )
    assert not _technical_condition_passes(
        TechnicalScreenerCondition(
            field="amount_ratio_20d",
            operator="gte",
            value=Decimal("0"),
        ),
        row,
    )


def test_technical_screener_row_enrichment_uses_shared_calculations() -> None:
    row = {"bar_history": [bar.model_dump(mode="json") for bar in make_bars(260)]}

    enriched = _enrich_technical_screener_row(row)

    assert enriched["ma250"] is not None
    assert enriched["macd_dif"] is not None
    assert enriched["rsi14"] is not None
    assert enriched["ma20_slope_5d_pct"] is not None
    assert enriched["ma60_slope_20d_pct"] is not None
    assert enriched["amount_ratio_20d"] is not None
