from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from quantpilot_market_data.models import KlinePeriod

StrategyDataProfileId = Literal[
    "daily_eod",
    "daily_live_5m",
    "minute1_entry",
    "minute1_momentum",
    "minute1_pattern",
    "minute5_confirm",
    "minute_backtest",
]

StorageMode = Literal["timescaledb", "timescaledb-daily", "redis", "timescaledb-minute"]


@dataclass(frozen=True, slots=True)
class StrategyDataProfile:
    id: StrategyDataProfileId
    label: str
    description: str
    period: KlinePeriod
    window_bars: int
    max_staleness_seconds: int
    max_symbols: int
    provider_order: tuple[str, ...]
    storage: StorageMode
    paid_only: bool = False
    retention_days: int | None = None

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["provider_order"] = list(self.provider_order)
        return payload


STRATEGY_DATA_PROFILES: dict[StrategyDataProfileId, StrategyDataProfile] = {
    "daily_eod": StrategyDataProfile(
        id="daily_eod",
        label="日线（收盘后）",
        description="全市场日频策略的本地基础层；已有最新日线时不访问外部数据源。",
        period="daily",
        window_bars=750,
        max_staleness_seconds=86_400,
        max_symbols=300,
        provider_order=("tushare", "eastmoney", "tencent", "baostock", "akshare"),
        storage="timescaledb",
        retention_days=1_095,
    ),
    "daily_live_5m": StrategyDataProfile(
        id="daily_live_5m",
        label="盘中5分钟更新",
        description="活跃池的动态日K快照，不代表真实5分钟K线。",
        period="daily",
        window_bars=1,
        max_staleness_seconds=420,
        max_symbols=300,
        provider_order=("eastmoney",),
        storage="timescaledb-daily",
        retention_days=1_825,
    ),
    "minute1_entry": StrategyDataProfile(
        id="minute1_entry",
        label="真实1分钟K · 入场",
        description="当天约241根真实1分钟K，用于入场确认。",
        period="minute1",
        window_bars=241,
        max_staleness_seconds=90,
        max_symbols=20,
        provider_order=("eastmoney", "tushare-realtime"),
        storage="redis",
    ),
    "minute1_momentum": StrategyDataProfile(
        id="minute1_momentum",
        label="真实1分钟K · 动量",
        description="最近2个交易日约480根真实1分钟K，用于短线动量分析。",
        period="minute1",
        window_bars=480,
        max_staleness_seconds=90,
        max_symbols=20,
        provider_order=("eastmoney", "tushare-realtime"),
        storage="redis",
    ),
    "minute1_pattern": StrategyDataProfile(
        id="minute1_pattern",
        label="真实1分钟K · 形态",
        description="最多1000根真实1分钟K，用于多日盘中形态分析。",
        period="minute1",
        window_bars=1_000,
        max_staleness_seconds=90,
        max_symbols=20,
        provider_order=("eastmoney", "tushare-realtime"),
        storage="redis",
    ),
    "minute5_confirm": StrategyDataProfile(
        id="minute5_confirm",
        label="真实5分钟K · 确认",
        description="最近5个交易日约240根真实5分钟K，用于趋势和形态确认。",
        period="minute5",
        window_bars=240,
        max_staleness_seconds=90,
        max_symbols=20,
        provider_order=("eastmoney", "tushare-realtime"),
        storage="redis",
    ),
    "minute_backtest": StrategyDataProfile(
        id="minute_backtest",
        label="分钟回测",
        description="最多20个交易日、约4800根/股；需要付费历史分钟权限。",
        period="minute1",
        window_bars=4_800,
        max_staleness_seconds=86_400,
        max_symbols=20,
        provider_order=("tushare-history",),
        storage="timescaledb-minute",
        paid_only=True,
        retention_days=90,
    ),
}


def get_strategy_data_profile(profile_id: str) -> StrategyDataProfile:
    try:
        return STRATEGY_DATA_PROFILES[profile_id]  # type: ignore[index]
    except KeyError as error:
        supported = "、".join(STRATEGY_DATA_PROFILES)
        raise ValueError(f"未知策略数据档位：{profile_id}；支持：{supported}") from error


def list_strategy_data_profiles() -> list[StrategyDataProfile]:
    return list(STRATEGY_DATA_PROFILES.values())
