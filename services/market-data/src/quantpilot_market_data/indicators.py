from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from math import sqrt
from typing import Any

from quantpilot_market_data.models import (
    KlineResponse,
    TechnicalIndicatorPoint,
    TechnicalIndicatorsResponse,
    TechnicalIndicatorSummary,
)

TECHNICAL_INDICATOR_FIELD_LABELS: dict[str, str] = {
    "ma5": "MA5",
    "ma10": "MA10",
    "ma20": "MA20",
    "ma30": "MA30",
    "ma60": "MA60",
    "ma120": "MA120",
    "ma250": "MA250",
    "ma5_slope_5d_pct": "MA5 slope 5d",
    "ma10_slope_5d_pct": "MA10 slope 5d",
    "ma20_slope_5d_pct": "MA20 slope 5d",
    "ma60_slope_20d_pct": "MA60 slope 20d",
    "ema12": "EMA12",
    "ema26": "EMA26",
    "rsi6": "RSI6",
    "rsi14": "RSI14",
    "macd_dif": "MACD DIF",
    "macd_dea": "MACD DEA",
    "macd_hist": "MACD柱",
    "upper_shadow_pct": "上影线",
    "lower_shadow_pct": "下影线",
    "body_pct": "实体",
    "amplitude": "振幅",
    "close_position_pct": "收盘位置",
    "volume_ratio_5d": "成交量/5日均量",
    "volume_ratio_20d": "成交量/20日均量",
    "amount_ratio_5d": "成交额/5日均额",
    "amount_ratio_20d": "成交额/20日均额",
    "turnover_avg_20d": "20日平均换手",
    "close_to_ma5_pct": "收盘价距MA5",
    "close_to_ma20_pct": "收盘价距MA20",
    "close_to_ma60_pct": "收盘价距MA60",
    "close_to_ma120_pct": "收盘价距MA120",
}


def _round(value: Decimal | None, places: int = 4) -> Decimal | None:
    if value is None:
        return None
    quant = Decimal("1").scaleb(-places)
    return value.quantize(quant, rounding=ROUND_HALF_UP)


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _rolling_mean(values: Sequence[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index + 1 < window:
        return None
    window_values = values[end_index + 1 - window : end_index + 1]
    if any(value is None for value in window_values):
        return None
    return _mean([value for value in window_values if value is not None])


def _return_pct(current: Decimal | None, previous: Decimal | None) -> Decimal | None:
    if current is None or previous is None or previous == 0:
        return None
    return ((current - previous) / previous) * Decimal("100")


def _moving_average_slope_pct(
    values: Sequence[Decimal | None],
    end_index: int,
    ma_window: int,
    lookback: int,
) -> Decimal | None:
    previous_index = end_index - lookback
    if previous_index < 0:
        return None
    current_ma = _rolling_mean(values, end_index, ma_window)
    previous_ma = _rolling_mean(values, previous_index, ma_window)
    return _return_pct(current_ma, previous_ma)


def _drawdown_pct(close: Decimal | None, peak: Decimal | None) -> Decimal | None:
    if close is None or peak is None or peak == 0:
        return None
    return ((close - peak) / peak) * Decimal("100")


def _annualized_volatility_pct(returns: list[Decimal]) -> Decimal | None:
    if len(returns) < 2:
        return None
    mean_return = _mean(returns)
    if mean_return is None:
        return None
    variance = sum((value - mean_return) ** 2 for value in returns) / Decimal(len(returns))
    return Decimal(str(sqrt(float(variance)))) * Decimal(str(sqrt(252)))


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def _bar_value(bar: Any, key: str) -> Any:
    if isinstance(bar, Mapping):
        return bar.get(key)
    return getattr(bar, key, None)


def _bar_decimal(bar: Any, key: str) -> Decimal | None:
    return _decimal_or_none(_bar_value(bar, key))


def _bar_int(bar: Any, key: str) -> int | None:
    return _int_or_none(_bar_value(bar, key))


def _bar_date(bar: Any) -> str:
    value = _bar_value(bar, "date")
    return "" if value is None else str(value)


def _decimal_ratio(current: Decimal | None, base: Decimal | None) -> Decimal | None:
    if current is None or base is None or base == 0:
        return None
    return current / base


def _percent_of_base(value: Decimal | None, base: Decimal | None) -> Decimal | None:
    if value is None or base is None or base == 0:
        return None
    return (value / base) * Decimal("100")


def _ema_series(values: Sequence[Decimal | None], window: int) -> list[Decimal | None]:
    multiplier = Decimal("2") / Decimal(window + 1)
    result: list[Decimal | None] = [None] * len(values)
    ema: Decimal | None = None

    for index, value in enumerate(values):
        if value is None:
            ema = None
            continue
        if ema is None:
            seed_values = values[index + 1 - window : index + 1]
            if len(seed_values) < window or any(item is None for item in seed_values):
                continue
            ema = _mean([item for item in seed_values if item is not None])
        else:
            ema = (value - ema) * multiplier + ema
        result[index] = ema

    return result


def _rsi_series(closes: Sequence[Decimal | None], window: int) -> list[Decimal | None]:
    result: list[Decimal | None] = [None] * len(closes)
    avg_gain: Decimal | None = None
    avg_loss: Decimal | None = None

    for index in range(1, len(closes)):
        current = closes[index]
        previous = closes[index - 1]
        if current is None or previous is None:
            avg_gain = None
            avg_loss = None
            continue

        change = current - previous
        gain = max(change, Decimal("0"))
        loss = max(-change, Decimal("0"))

        if avg_gain is None or avg_loss is None:
            if index < window:
                continue
            gains: list[Decimal] = []
            losses: list[Decimal] = []
            for change_index in range(index - window + 1, index + 1):
                left = closes[change_index - 1]
                right = closes[change_index]
                if left is None or right is None:
                    break
                delta = right - left
                gains.append(max(delta, Decimal("0")))
                losses.append(max(-delta, Decimal("0")))
            if len(gains) != window or len(losses) != window:
                continue
            avg_gain = _mean(gains)
            avg_loss = _mean(losses)
        else:
            avg_gain = ((avg_gain * Decimal(window - 1)) + gain) / Decimal(window)
            avg_loss = ((avg_loss * Decimal(window - 1)) + loss) / Decimal(window)

        if avg_gain is None or avg_loss is None:
            continue
        if avg_loss == 0:
            result[index] = Decimal("100") if avg_gain > 0 else Decimal("50")
        else:
            rs_value = avg_gain / avg_loss
            result[index] = Decimal("100") - (Decimal("100") / (Decimal("1") + rs_value))

    return result


def _positive_or_zero(value: Decimal) -> Decimal:
    return max(value, Decimal("0"))


def build_technical_feature_rows(bars: Sequence[Any]) -> list[dict[str, Any]]:
    """Return deterministic technical features for bars ordered oldest to newest."""

    closes = [_bar_decimal(bar, "close") for bar in bars]
    opens = [_bar_decimal(bar, "open") for bar in bars]
    highs = [_bar_decimal(bar, "high") for bar in bars]
    lows = [_bar_decimal(bar, "low") for bar in bars]
    previous_closes = [_bar_decimal(bar, "previous_close") for bar in bars]
    amounts = [_bar_decimal(bar, "amount") for bar in bars]
    volumes = [_bar_decimal(bar, "volume") for bar in bars]
    turnovers = [_bar_decimal(bar, "turnover") for bar in bars]
    source_amplitudes = [_bar_decimal(bar, "amplitude") for bar in bars]

    ema12 = _ema_series(closes, 12)
    ema26 = _ema_series(closes, 26)
    macd_dif = [
        left - right if left is not None and right is not None else None
        for left, right in zip(ema12, ema26, strict=True)
    ]
    macd_dea = _ema_series(macd_dif, 9)
    rsi6 = _rsi_series(closes, 6)
    rsi14 = _rsi_series(closes, 14)
    ma_windows = (5, 10, 20, 30, 60, 120, 250)

    rows: list[dict[str, Any]] = []
    for index, bar in enumerate(bars):
        close = closes[index]
        open_price = opens[index]
        high = highs[index]
        low = lows[index]
        previous_close = previous_closes[index] or (closes[index - 1] if index > 0 else None)
        range_value = high - low if high is not None and low is not None else None
        body_value = (
            abs(close - open_price) if close is not None and open_price is not None else None
        )
        upper_shadow = (
            _positive_or_zero(high - max(open_price, close))
            if high is not None and open_price is not None and close is not None
            else None
        )
        lower_shadow = (
            _positive_or_zero(min(open_price, close) - low)
            if low is not None and open_price is not None and close is not None
            else None
        )
        source_amplitude = source_amplitudes[index]
        derived_amplitude = _percent_of_base(range_value, previous_close)
        close_position = (
            ((close - low) / range_value) * Decimal("100")
            if close is not None and low is not None and range_value not in (None, Decimal("0"))
            else None
        )
        macd_hist = (
            (macd_dif[index] - macd_dea[index]) * Decimal("2")
            if macd_dif[index] is not None and macd_dea[index] is not None
            else None
        )

        row: dict[str, Any] = {
            "date": _bar_date(bar),
            "close": close,
            "volume": _bar_int(bar, "volume"),
            "return_pct": _round(
                _return_pct(close, closes[index - 1] if index > 0 else None),
                4,
            ),
            "ema12": _round(ema12[index], 4),
            "ema26": _round(ema26[index], 4),
            "rsi6": _round(rsi6[index], 4),
            "rsi14": _round(rsi14[index], 4),
            "macd_dif": _round(macd_dif[index], 4),
            "macd_dea": _round(macd_dea[index], 4),
            "macd_hist": _round(macd_hist, 4),
            "upper_shadow_pct": _round(_percent_of_base(upper_shadow, previous_close), 4),
            "lower_shadow_pct": _round(_percent_of_base(lower_shadow, previous_close), 4),
            "body_pct": _round(_percent_of_base(body_value, previous_close), 4),
            "amplitude": _round(
                source_amplitude if source_amplitude is not None else derived_amplitude,
                4,
            ),
            "close_position_pct": _round(close_position, 4),
            "volume_ratio_5d": _round(
                _decimal_ratio(volumes[index], _rolling_mean(volumes, index, 5)),
                4,
            ),
            "volume_ratio_20d": _round(
                _decimal_ratio(volumes[index], _rolling_mean(volumes, index, 20)),
                4,
            ),
            "amount_ratio_5d": _round(
                _decimal_ratio(amounts[index], _rolling_mean(amounts, index, 5)),
                4,
            ),
            "amount_ratio_20d": _round(
                _decimal_ratio(amounts[index], _rolling_mean(amounts, index, 20)),
                4,
            ),
            "turnover_avg_20d": _round(_rolling_mean(turnovers, index, 20), 4),
        }
        for window in ma_windows:
            row[f"ma{window}"] = _round(_rolling_mean(closes, index, window), 4)
        row["ma5_slope_5d_pct"] = _round(_moving_average_slope_pct(closes, index, 5, 5), 4)
        row["ma10_slope_5d_pct"] = _round(_moving_average_slope_pct(closes, index, 10, 5), 4)
        row["ma20_slope_5d_pct"] = _round(_moving_average_slope_pct(closes, index, 20, 5), 4)
        row["ma60_slope_20d_pct"] = _round(_moving_average_slope_pct(closes, index, 60, 20), 4)
        for window in (5, 20, 60, 120):
            row[f"close_to_ma{window}_pct"] = _round(
                _return_pct(close, row[f"ma{window}"]),
                4,
            )
        rows.append(row)

    return rows


def _feature_decimal(row: dict[str, Any], key: str) -> Decimal | None:
    return _decimal_or_none(row.get(key))


def build_technical_indicators(kline: KlineResponse) -> TechnicalIndicatorsResponse:
    closes = [bar.close for bar in kline.bars]
    feature_rows = build_technical_feature_rows(kline.bars)
    points: list[TechnicalIndicatorPoint] = []
    peak_close: Decimal | None = None
    returns: list[Decimal] = []

    for index, bar in enumerate(kline.bars):
        feature_row = feature_rows[index]
        if bar.close is not None:
            peak_close = bar.close if peak_close is None else max(peak_close, bar.close)

        return_value = _return_pct(bar.close, closes[index - 1] if index > 0 else None)
        if return_value is not None:
            returns.append(return_value)

        points.append(
            TechnicalIndicatorPoint(
                date=bar.date,
                close=bar.close,
                volume=bar.volume,
                ma5=_round(_rolling_mean(closes, index, 5), 4),
                ma10=_round(_rolling_mean(closes, index, 10), 4),
                ma20=_round(_rolling_mean(closes, index, 20), 4),
                ma30=_feature_decimal(feature_row, "ma30"),
                ma60=_feature_decimal(feature_row, "ma60"),
                ma120=_feature_decimal(feature_row, "ma120"),
                ma250=_feature_decimal(feature_row, "ma250"),
                ma5_slope_5d_pct=_feature_decimal(feature_row, "ma5_slope_5d_pct"),
                ma10_slope_5d_pct=_feature_decimal(feature_row, "ma10_slope_5d_pct"),
                ma20_slope_5d_pct=_feature_decimal(feature_row, "ma20_slope_5d_pct"),
                ma60_slope_20d_pct=_feature_decimal(feature_row, "ma60_slope_20d_pct"),
                ema12=_feature_decimal(feature_row, "ema12"),
                ema26=_feature_decimal(feature_row, "ema26"),
                rsi6=_feature_decimal(feature_row, "rsi6"),
                rsi14=_feature_decimal(feature_row, "rsi14"),
                macd_dif=_feature_decimal(feature_row, "macd_dif"),
                macd_dea=_feature_decimal(feature_row, "macd_dea"),
                macd_hist=_feature_decimal(feature_row, "macd_hist"),
                upper_shadow_pct=_feature_decimal(feature_row, "upper_shadow_pct"),
                lower_shadow_pct=_feature_decimal(feature_row, "lower_shadow_pct"),
                body_pct=_feature_decimal(feature_row, "body_pct"),
                amplitude=_feature_decimal(feature_row, "amplitude"),
                close_position_pct=_feature_decimal(feature_row, "close_position_pct"),
                volume_ratio_5d=_feature_decimal(feature_row, "volume_ratio_5d"),
                volume_ratio_20d=_feature_decimal(feature_row, "volume_ratio_20d"),
                amount_ratio_5d=_feature_decimal(feature_row, "amount_ratio_5d"),
                amount_ratio_20d=_feature_decimal(feature_row, "amount_ratio_20d"),
                turnover_avg_20d=_feature_decimal(feature_row, "turnover_avg_20d"),
                return_pct=_round(return_value, 4),
                drawdown_pct=_round(_drawdown_pct(bar.close, peak_close), 4),
            )
        )

    valid_closes = [close for close in closes if close is not None]
    volumes = [Decimal(bar.volume) for bar in kline.bars[-20:] if bar.volume is not None]
    first_close = valid_closes[0] if valid_closes else None
    latest_close = valid_closes[-1] if valid_closes else None
    drawdowns = [point.drawdown_pct for point in points if point.drawdown_pct is not None]
    latest_feature = feature_rows[-1] if feature_rows else {}

    summary = TechnicalIndicatorSummary(
        latest_close=latest_close,
        period_return_pct=_round(_return_pct(latest_close, first_close), 4),
        max_drawdown_pct=min(drawdowns) if drawdowns else None,
        volatility_annualized_pct=_round(_annualized_volatility_pct(returns), 4),
        avg_volume20=_round(_mean(volumes), 2),
        ma5=points[-1].ma5 if points else None,
        ma10=points[-1].ma10 if points else None,
        ma20=points[-1].ma20 if points else None,
        ma30=_feature_decimal(latest_feature, "ma30"),
        ma60=_feature_decimal(latest_feature, "ma60"),
        ma120=_feature_decimal(latest_feature, "ma120"),
        ma250=_feature_decimal(latest_feature, "ma250"),
        ma5_slope_5d_pct=_feature_decimal(latest_feature, "ma5_slope_5d_pct"),
        ma10_slope_5d_pct=_feature_decimal(latest_feature, "ma10_slope_5d_pct"),
        ma20_slope_5d_pct=_feature_decimal(latest_feature, "ma20_slope_5d_pct"),
        ma60_slope_20d_pct=_feature_decimal(latest_feature, "ma60_slope_20d_pct"),
        ema12=_feature_decimal(latest_feature, "ema12"),
        ema26=_feature_decimal(latest_feature, "ema26"),
        rsi6=_feature_decimal(latest_feature, "rsi6"),
        rsi14=_feature_decimal(latest_feature, "rsi14"),
        macd_dif=_feature_decimal(latest_feature, "macd_dif"),
        macd_dea=_feature_decimal(latest_feature, "macd_dea"),
        macd_hist=_feature_decimal(latest_feature, "macd_hist"),
        upper_shadow_pct=_feature_decimal(latest_feature, "upper_shadow_pct"),
        lower_shadow_pct=_feature_decimal(latest_feature, "lower_shadow_pct"),
        body_pct=_feature_decimal(latest_feature, "body_pct"),
        amplitude=_feature_decimal(latest_feature, "amplitude"),
        close_position_pct=_feature_decimal(latest_feature, "close_position_pct"),
        volume_ratio_5d=_feature_decimal(latest_feature, "volume_ratio_5d"),
        volume_ratio_20d=_feature_decimal(latest_feature, "volume_ratio_20d"),
        amount_ratio_5d=_feature_decimal(latest_feature, "amount_ratio_5d"),
        amount_ratio_20d=_feature_decimal(latest_feature, "amount_ratio_20d"),
        turnover_avg_20d=_feature_decimal(latest_feature, "turnover_avg_20d"),
    )

    return TechnicalIndicatorsResponse(
        symbol=kline.symbol,
        name=kline.name,
        secid=kline.secid,
        asset_type=kline.asset_type,
        market=kline.market,
        source=kline.source,
        period=kline.period,
        adjustment=kline.adjustment,
        points=points,
        summary=summary,
        as_of=kline.as_of,
        fetched_at=kline.fetched_at,
    )
