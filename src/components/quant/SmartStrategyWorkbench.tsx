"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpenCheck,
  Braces,
  CheckCircle2,
  Clipboard,
  Code2,
  Database,
  Gauge,
  Layers3,
  LineChart,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Timer,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  StrategyDashboardData,
  StrategyDataProfileId,
  StrategyIntent,
  StrategyRefreshResponse,
  StrategyScreenerCandidate,
  StrategyUniverse,
  StrategyUniverseMember,
  TechnicalScreenerCondition,
  TechnicalScreenerDraft,
  TechnicalScreenerResponse,
} from "@/lib/quant/strategies";
import { StockKlineDetail } from "@/components/quant/StockKlineDetail";
import {
  API_BASE,
  formatLargeValue,
  formatNumberValue,
  formatSignedPercent,
  signedToneClass,
} from "@/app/strategy-platform/strategy-platform-helpers";

type Props = {
  data: StrategyDashboardData;
};

type IndicatorGroupId = "trend" | "momentum" | "candle" | "volume" | "risk";

type IndicatorGroup = {
  id: IndicatorGroupId;
  label: string;
  description: string;
  fields: string[];
  examples: string[];
};

type MinuteProfileId = Extract<
  StrategyDataProfileId,
  "minute1_entry" | "minute1_momentum" | "minute1_pattern" | "minute5_confirm" | "minute_backtest"
>;

const MINUTE_PROFILE_OPTIONS: Array<{
  id: MinuteProfileId;
  label: string;
  detail: string;
}> = [
  { id: "minute1_entry", label: "1分钟入场", detail: "当天约241根" },
  { id: "minute1_momentum", label: "1分钟动量", detail: "近2个交易日约480根" },
  { id: "minute1_pattern", label: "1分钟形态", detail: "最多1000根" },
  { id: "minute5_confirm", label: "5分钟确认", detail: "近5个交易日约240根" },
  { id: "minute_backtest", label: "分钟回测", detail: "付费权限，最多4800根" },
];

function isMinuteProfile(value: StrategyDataProfileId | undefined): value is MinuteProfileId {
  return MINUTE_PROFILE_OPTIONS.some((option) => option.id === value);
}

const QUICK_TEMPLATES = [
  {
    title: "MACD 放量突破",
    prompt: "选出 MACD 金叉，成交额较 20 日均额放大 1.5 倍，收盘价站上 MA20，RSI 不高于 70 的股票",
    fields: ["macd_dif", "macd_dea", "amount_ratio_20d", "rsi14"],
  },
  {
    title: "趋势多头不过热",
    prompt: "选出 MA5 > MA10 > MA20，收盘价站上 MA5，20日涨幅大于 8%，RSI14 不高于 70 的股票",
    fields: ["ma5", "ma10", "ma20", "strength_20d_pct", "rsi14"],
  },
  {
    title: "避开长上影",
    prompt: "选出均线多头，成交额放大 1.5 倍，不要长上影线，上影线小于 3%，收盘靠近高点",
    fields: ["amount_ratio_20d", "upper_shadow_pct", "close_position_pct"],
  },
  {
    title: "MA20 斜率",
    prompt: "选出 MA20 斜率大于 2%，同时不是冲高回落的股票",
    fields: ["ma20_slope_5d_pct", "upper_shadow_pct", "close_position_pct"],
  },
  {
    title: "年线趋势确认",
    prompt: "选出收盘价站上年线，MA120 也在 MA250 上方，成交额活跃且不是 ST 的股票",
    fields: ["ma120", "ma250", "amount", "is_st"],
  },
];

const INDICATOR_GROUPS: IndicatorGroup[] = [
  {
    id: "trend",
    label: "趋势",
    description: "均线、指数均线和价格相对均线位置，用于趋势确认。",
    fields: ["ma5", "ma10", "ma20", "ma60", "ma120", "ma250", "ma20_slope_5d_pct", "ma60_slope_20d_pct", "ema12", "ema26", "close_to_ma120_pct"],
    examples: ["MA5 >= MA10 >= MA20", "MA20 5日斜率 >= 2%", "收盘价站上 MA120"],
  },
  {
    id: "momentum",
    label: "动量",
    description: "相对强弱、RSI 和 MACD，用于过滤过热或确认动量方向。",
    fields: ["strength_5d_pct", "strength_20d_pct", "rsi6", "rsi14", "macd_dif", "macd_dea", "macd_hist"],
    examples: ["MACD DIF >= DEA", "RSI14 <= 70", "20日强弱 >= 8%"],
  },
  {
    id: "candle",
    label: "形态",
    description: "基于日 K 的实体、上下影线、振幅和收盘位置。",
    fields: ["upper_shadow_pct", "lower_shadow_pct", "body_pct", "amplitude", "close_position_pct"],
    examples: ["上影线 <= 3%", "下影线 >= 3%", "收盘位置 >= 70%"],
  },
  {
    id: "volume",
    label: "量能",
    description: "成交额、成交量和换手的相对放大倍数。",
    fields: ["amount", "volume", "turnover", "amount_ratio_5d", "amount_ratio_20d", "volume_ratio_5d", "volume_ratio_20d", "turnover_avg_20d"],
    examples: ["成交额较20日均额 >= 1.5倍", "成交额 >= 1亿", "20日平均换手 >= 2%"],
  },
  {
    id: "risk",
    label: "风控",
    description: "样本、ST、涨停和流动性边界，避免不可交易或数据不足。",
    fields: ["sample_count", "is_st", "is_limit_up", "limit_up_count_4d", "limit_up_count_10d", "score"],
    examples: ["样本根数 >= 60", "排除 ST", "排除当日涨停"],
  },
];

const FIELD_LABELS: Record<string, string> = {
  open: "开盘",
  close: "收盘",
  high: "最高",
  low: "最低",
  previous_close: "昨收",
  change_percent: "涨跌幅",
  amount: "成交额",
  volume: "成交量",
  turnover: "换手率",
  ma5: "MA5",
  ma10: "MA10",
  ma20: "MA20",
  ma30: "MA30",
  ma60: "MA60",
  ma120: "MA120",
  ma250: "MA250",
  ma5_slope_5d_pct: "MA5 5日斜率",
  ma10_slope_5d_pct: "MA10 5日斜率",
  ma20_slope_5d_pct: "MA20 5日斜率",
  ma60_slope_20d_pct: "MA60 20日斜率",
  ema12: "EMA12",
  ema26: "EMA26",
  strength_5d_pct: "5日强弱",
  strength_10d_pct: "10日强弱",
  strength_20d_pct: "20日强弱",
  strength_60d_pct: "60日强弱",
  rsi6: "RSI6",
  rsi14: "RSI14",
  macd_dif: "MACD DIF",
  macd_dea: "MACD DEA",
  macd_hist: "MACD 柱",
  upper_shadow_pct: "上影线",
  lower_shadow_pct: "下影线",
  body_pct: "实体",
  amplitude: "振幅",
  close_position_pct: "收盘位置",
  amount_ratio_5d: "成交额/5日均额",
  amount_ratio_20d: "成交额/20日均额",
  volume_ratio_5d: "成交量/5日均量",
  volume_ratio_20d: "成交量/20日均量",
  turnover_avg_20d: "20日平均换手",
  close_to_ma5_pct: "收盘距MA5",
  close_to_ma20_pct: "收盘距MA20",
  close_to_ma60_pct: "收盘距MA60",
  close_to_ma120_pct: "收盘距MA120",
  limit_up_count_4d: "4日涨停次数",
  limit_up_count_10d: "10日涨停次数",
  sample_count: "样本根数",
  score: "综合分",
  is_limit_up: "当日涨停",
  is_st: "ST",
};

const OPERATOR_LABELS: Record<TechnicalScreenerCondition["operator"], string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  between: "介于",
};

const GROUP_TONE: Record<IndicatorGroupId, string> = {
  trend: "border-blue-200 bg-blue-50 text-blue-700",
  momentum: "border-indigo-200 bg-indigo-50 text-indigo-700",
  candle: "border-amber-200 bg-amber-50 text-amber-700",
  volume: "border-emerald-200 bg-emerald-50 text-emerald-700",
  risk: "border-slate-200 bg-slate-50 text-slate-600",
};

function candidateName(candidate: StrategyScreenerCandidate) {
  return candidate.name ? `${candidate.name} ${candidate.code}` : candidate.code || candidate.symbol;
}

function groupForField(field: string): IndicatorGroup {
  return INDICATOR_GROUPS.find((group) => group.fields.includes(field)) ?? INDICATOR_GROUPS[4];
}

function conditionLabel(condition: TechnicalScreenerCondition) {
  if (condition.label) return condition.label;
  const left = FIELD_LABELS[condition.field] ?? condition.field;
  const operator = OPERATOR_LABELS[condition.operator];
  const right = condition.valueField
    ? FIELD_LABELS[condition.valueField] ?? condition.valueField
    : condition.operator === "between"
      ? `${condition.value ?? "-"} 到 ${condition.upperValue ?? "-"}`
      : String(condition.value ?? "-");
  return `${left} ${operator} ${right}`;
}

function conditionIdentity(condition: TechnicalScreenerCondition) {
  return [
    condition.field,
    condition.operator,
    condition.valueField ?? "",
    condition.upperValue ?? "",
    condition.label ?? "",
  ].join("|");
}

function editableConditionValue(condition: TechnicalScreenerCondition) {
  return !condition.valueField && (typeof condition.value === "number" || (condition.value === null && condition.operator !== "eq"));
}

function patchedConditionLabel(condition: TechnicalScreenerCondition, value: number | null) {
  if (condition.valueField) return condition.label ?? conditionLabel(condition);
  const left = FIELD_LABELS[condition.field] ?? condition.field;
  const operator = OPERATOR_LABELS[condition.operator];
  const suffix = condition.field.endsWith("_pct") || condition.field.includes("slope") ? "%" : "";
  return `${left} ${operator} ${value ?? "-"}${suffix}`;
}

function intentStatusLabel(status: StrategyIntent["supportStatus"]) {
  if (status === "inferred") return "系统默认";
  if (status === "unsupported") return "未支持";
  if (status === "needs_clarification") return "需澄清";
  return "已支持";
}

function intentStatusTone(status: StrategyIntent["supportStatus"]) {
  if (status === "unsupported" || status === "needs_clarification") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "inferred") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function copyableJson(draft: TechnicalScreenerDraft | null) {
  return draft ? JSON.stringify(draft.spec, null, 2) : "";
}

function hitRate(result: TechnicalScreenerResponse | null) {
  if (!result || result.scannedSymbols <= 0) return null;
  return (result.totalCandidates / result.scannedSymbols) * 100;
}

function memberFromCandidate(candidate: StrategyScreenerCandidate): StrategyUniverseMember {
  return {
    symbol: candidate.symbol,
    code: candidate.code,
    name: candidate.name ?? candidate.code,
    industry: null,
    region: null,
    concepts: [],
    sectorHint: candidate.sectorTags[0] ?? null,
    sectorTags: candidate.sectorTags,
    exchange: candidate.exchange,
    assetType: "stock",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    provider: "quantpilot-market-api",
    securityStatus: "active",
    role: "member",
    rowCount: candidate.sampleCount,
    latestClose: candidate.close ?? null,
    latestChangePct: candidate.changePercent ?? null,
    latestAmount: candidate.amount ?? null,
    latestTurnover: candidate.turnover ?? null,
    strength20dPct: candidate.strength20dPct ?? null,
    strength60dPct: null,
    ma20: candidate.ma20 ?? null,
    ma60: candidate.ma60 ?? null,
    trendStatus:
      candidate.ma20 !== null &&
      candidate.ma20 !== undefined &&
      candidate.ma60 !== null &&
      candidate.ma60 !== undefined &&
      candidate.close !== null &&
      candidate.close !== undefined
        ? candidate.close >= candidate.ma20 && candidate.ma20 >= candidate.ma60
          ? "bullish"
          : candidate.close < candidate.ma20
            ? "bearish"
            : "sideways"
        : "insufficient",
    avgAmount20d: candidate.amountRatio20d && candidate.amount ? candidate.amount / candidate.amountRatio20d : null,
    avgVolume20d: null,
    avgTurnover20d: null,
    tradeStatus: null,
    isSt: candidate.isSt ?? null,
    limitUp: candidate.isLimitUp ?? null,
    limitDown: null,
    peTtm: null,
    pbMrq: null,
    psTtm: null,
    pcfNcfTtm: null,
    dataStatus: candidate.sampleCount > 0 ? "ready" : "missing",
  };
}

export function SmartStrategyWorkbench({ data }: Props) {
  const defaultUniverseId = data.research.primaryUniverseId || data.research.universes[0]?.id || "";
  const [prompt, setPrompt] = useState("");
  const [universeId, setUniverseId] = useState(defaultUniverseId);
  const [limit, setLimit] = useState("20");
  const [draft, setDraft] = useState<TechnicalScreenerDraft | null>(null);
  const [result, setResult] = useState<TechnicalScreenerResponse | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<IndicatorGroupId>("trend");
  const [showJson, setShowJson] = useState(true);
  const [copied, setCopied] = useState(false);
  const [minuteProfile, setMinuteProfile] = useState<MinuteProfileId>("minute1_entry");
  const [minuteResult, setMinuteResult] = useState<StrategyRefreshResponse | null>(null);
  const [isMinuteLoading, setIsMinuteLoading] = useState(false);
  const [minuteError, setMinuteError] = useState<string | null>(null);

  const parsedLimit = useMemo(() => {
    const value = Number(limit);
    return Number.isFinite(value) ? Math.max(1, Math.min(Math.round(value), 100)) : 20;
  }, [limit]);

  const selectedUniverse =
    data.research.universes.find((universe) => universe.id === universeId) ??
    data.research.universes.find((universe) => universe.id === data.research.primaryUniverseId) ??
    data.research.universes[0] ??
    null;
  const intents = draft?.intents ?? [];
  const activeGroup = INDICATOR_GROUPS.find((group) => group.id === activeGroupId) ?? INDICATOR_GROUPS[0];
  const resultHitRate = hitRate(result);
  const conditions = useMemo(
    () => draft?.spec.conditions.map((condition, index) => ({
      id: `${condition.field}-${condition.operator}-${index}`,
      label: conditionLabel(condition),
      group: groupForField(condition.field),
    })) ?? [],
    [draft]
  );
  const selectedCandidate =
    result?.candidates.find((candidate) => candidate.symbol === selectedSymbol) ??
    result?.candidates[0] ??
    null;
  const selectedMember = selectedCandidate ? memberFromCandidate(selectedCandidate) : null;
  const selectedMinuteItem = minuteResult?.items.find((item) => item.symbol === selectedCandidate?.symbol)
    ?? minuteResult?.items[0]
    ?? null;

  useEffect(() => {
    if (result?.candidates.length) {
      setSelectedSymbol(result.candidates[0].symbol);
    } else {
      setSelectedSymbol(null);
    }
  }, [result]);

  useEffect(() => {
    if (isMinuteProfile(draft?.recommendedDataProfile)) {
      setMinuteProfile(draft.recommendedDataProfile);
    }
  }, [draft?.recommendedDataProfile]);

  useEffect(() => {
    setMinuteResult(null);
    setMinuteError(null);
  }, [selectedSymbol]);

  const applyPrompt = (value: string) => {
    setPrompt(value);
    setDraft(null);
    setResult(null);
    setSelectedSymbol(null);
    setError(null);
  };

  const generateDraft = async () => {
    setIsDrafting(true);
    setError(null);
    setResult(null);
    setSelectedSymbol(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/smart-strategy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "draft",
          prompt,
          universeId,
          limit: parsedLimit,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.message || payload.error || "DeepSeek 策略草案生成失败");
      setDraft(payload.data as TechnicalScreenerDraft);
      setShowJson(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDrafting(false);
    }
  };

  const runScreener = async () => {
    const activeDraft = draft;
    if (!activeDraft) return;
    setIsRunning(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/smart-strategy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run",
          universeId,
          limit: parsedLimit,
          spec: activeDraft.spec,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.message || payload.error || "技术筛选失败");
      setResult(payload.data as TechnicalScreenerResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const runMinuteAnalysis = async () => {
    if (!selectedCandidate || !draft || !result) return;
    setIsMinuteLoading(true);
    setMinuteError(null);
    try {
      const response = await fetch(`${API_BASE}/api/quant/smart-strategy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "prepare-analysis",
          universeId,
          symbols: [selectedCandidate.symbol],
          profile: minuteProfile,
          tradeDate: result.tradeDate,
          limit: parsedLimit,
          spec: draft.spec,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.message || payload.error || "分钟行情准备失败");
      }
      setMinuteResult(payload.data as StrategyRefreshResponse);
    } catch (err) {
      setMinuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMinuteLoading(false);
    }
  };

  const copyJson = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(copyableJson(draft));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const updateIntentConditionValue = (intentIndex: number, conditionIndex: number, rawValue: string) => {
    const nextValue = rawValue.trim() === "" ? null : Number(rawValue);
    if (nextValue !== null && !Number.isFinite(nextValue)) return;
    setDraft((current) => {
      if (!current?.intents?.[intentIndex]?.conditions[conditionIndex]) return current;
      const currentCondition = current.intents[intentIndex].conditions[conditionIndex];
      const targetIdentity = conditionIdentity(currentCondition);
      const nextCondition = {
        ...currentCondition,
        value: nextValue,
        label: patchedConditionLabel(currentCondition, nextValue),
      };
      const nextIntents = current.intents.map((item, itemIndex) => {
        if (itemIndex !== intentIndex) return item;
        return {
          ...item,
          conditions: item.conditions.map((condition, itemConditionIndex) =>
            itemConditionIndex === conditionIndex ? nextCondition : condition
          ),
        };
      });
      return {
        ...current,
        intents: nextIntents,
        spec: {
          ...current.spec,
          conditions: current.spec.conditions.map((condition) =>
            conditionIdentity(condition) === targetIdentity ? nextCondition : condition
          ),
        },
      };
    });
    setResult(null);
  };

  return (
    <main className="mx-auto w-full max-w-[1900px] space-y-4 px-3 py-5 lg:px-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">智能策略执行失败</p>
            <p className="mt-1 break-words leading-6">{error}</p>
          </div>
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(340px,0.9fr)_minmax(420px,1fr)_minmax(520px,1.2fr)]">
        <div className="min-w-0 rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-600" />
              <h2 className="text-sm font-semibold text-slate-950">DeepSeek 策略输入</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              DeepSeek 只生成白名单 JSON，后端用本地日 K 做确定性筛选。
            </p>
          </div>

          <div className="space-y-4 p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={universeId} onValueChange={setUniverseId}>
                <SelectTrigger className="h-9 bg-white sm:w-[230px]">
                  <SelectValue placeholder="选择股票池" />
                </SelectTrigger>
                <SelectContent>
                  {data.research.universes.map((universe) => (
                    <SelectItem key={universe.id} value={universe.id}>
                      {universe.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={limit} onValueChange={setLimit}>
                <SelectTrigger className="h-9 bg-white sm:w-[120px]">
                  <SelectValue placeholder="数量" />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 30, 50, 100].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      Top {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {QUICK_TEMPLATES.map((template) => (
                <button
                  key={template.title}
                  type="button"
                  onClick={() => applyPrompt(template.prompt)}
                  className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-blue-200 hover:bg-blue-50"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Search className="h-4 w-4 text-blue-600" />
                    {template.title}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">
                    {template.prompt}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {template.fields.map((field) => (
                      <span key={field} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        {FIELD_LABELS[field] ?? field}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>

            <Textarea
              value={prompt}
              onChange={(event) => applyPrompt(event.target.value)}
              placeholder="例如：选出 MACD 金叉，成交额较 20 日均额放大 1.5 倍，RSI 不高于 70，不要长上影线，收盘靠近高点的股票"
              className="min-h-[132px] resize-y border-slate-200 bg-white text-sm leading-6"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={generateDraft}
                disabled={isDrafting || !prompt.trim()}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                {isDrafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Braces className="h-4 w-4" />}
                DeepSeek 生成
              </Button>
              <Button type="button" variant="outline" onClick={runScreener} disabled={isRunning || !draft}>
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                执行筛选
              </Button>
              {draft ? (
                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                  {draft.spec.conditions.length} 个条件
                </Badge>
              ) : null}
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <BookOpenCheck className="h-4 w-4 text-blue-600" />
                  指标白名单
                </div>
                <div className="flex flex-wrap gap-1">
                  {INDICATOR_GROUPS.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => setActiveGroupId(group.id)}
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs font-medium transition",
                        activeGroupId === group.id
                          ? GROUP_TONE[group.id]
                          : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                      )}
                    >
                      {group.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 p-3">
                <p className="text-xs leading-5 text-slate-500">{activeGroup.description}</p>
                <div className="flex flex-wrap gap-1.5">
                  {activeGroup.fields.map((field) => (
                    <span key={field} className={cn("rounded-md border px-2 py-1 text-[11px] font-medium", GROUP_TONE[activeGroup.id])}>
                      {FIELD_LABELS[field] ?? field}
                    </span>
                  ))}
                </div>
                <div className="rounded-md border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-700">
                  {activeGroup.examples.join(" / ")}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-950">策略草案与命中列表</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {result
                  ? `${result.tradeDate ?? "-"} · 扫描 ${result.scannedSymbols} 个标的 · 命中 ${result.totalCandidates} 个`
                  : "等待生成草案并执行筛选"}
              </p>
            </div>
            {resultHitRate !== null ? (
              <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                命中率 {formatNumberValue(resultHitRate, 2)}%
              </Badge>
            ) : null}
          </div>

          {draft ? (
            <div className="border-b border-slate-100 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-950">{draft.spec.name}</p>
                    <Badge variant="outline" className="bg-white text-slate-500">
                      {draft.generatedBy}
                    </Badge>
                    {draft.model ? (
                      <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                        {draft.model}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{draft.spec.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowJson((value) => !value)}
                    className="h-7 px-2 text-xs"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    JSON
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={copyJson} className="h-7 px-2 text-xs">
                    {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                    {copied ? "已复制" : "复制"}
                  </Button>
                </div>
              </div>

              {intents.length ? (
                <div className="mt-3 rounded-md border border-slate-200 bg-slate-50">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <BookOpenCheck className="h-4 w-4 text-blue-600" />
                      系统理解
                    </div>
                    {draft.clarificationNeeded ? (
                      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                        需要澄清
                      </Badge>
                    ) : null}
                  </div>
                  <div className="space-y-2 p-3">
                    {intents.map((strategyIntent, intentIndex) => (
                      <div key={`${strategyIntent.id}-${intentIndex}`} className="rounded-md border border-slate-200 bg-white p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={intentStatusTone(strategyIntent.supportStatus)}>
                            {intentStatusLabel(strategyIntent.supportStatus)}
                          </Badge>
                          <span className="text-xs font-medium text-slate-500">{strategyIntent.intentType}</span>
                          <span className="text-xs text-slate-400">
                            {Math.round(strategyIntent.confidence * 100)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-slate-700">{strategyIntent.rawText}</p>
                        {strategyIntent.explanation ? (
                          <p className="mt-1 text-xs leading-5 text-slate-500">{strategyIntent.explanation}</p>
                        ) : null}
                        {strategyIntent.mappedFields.length ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {strategyIntent.mappedFields.map((field) => (
                              <span key={field} className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                                {FIELD_LABELS[field] ?? field}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {strategyIntent.conditions.length ? (
                          <div className="mt-2 space-y-1.5">
                            {strategyIntent.conditions.map((condition, conditionIndex) => (
                              <div key={`${conditionIdentity(condition)}-${conditionIndex}`} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5">
                                <span className="min-w-[92px] text-[11px] font-semibold text-slate-600">
                                  {FIELD_LABELS[condition.field] ?? condition.field}
                                </span>
                                {editableConditionValue(condition) ? (
                                  <>
                                    <span className="text-xs text-slate-500">{OPERATOR_LABELS[condition.operator]}</span>
                                    <Input
                                      type="number"
                                      step="0.1"
                                      value={typeof condition.value === "number" ? condition.value : ""}
                                      onChange={(event) => updateIntentConditionValue(intentIndex, conditionIndex, event.target.value)}
                                      className="h-7 w-24 bg-white px-2 text-xs"
                                    />
                                  </>
                                ) : (
                                  <span className="min-w-0 text-xs leading-5 text-slate-600">{conditionLabel(condition)}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {strategyIntent.unsupportedTerms.length ? (
                          <p className="mt-2 text-xs leading-5 text-amber-700">
                            未支持：{strategyIntent.unsupportedTerms.join("、")}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-2">
                  <p className="text-[11px] text-slate-500">样本</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{draft.spec.minSampleCount} 根</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-2">
                  <p className="text-[11px] text-slate-500">排序</p>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-900">{FIELD_LABELS[draft.spec.sort.field] ?? draft.spec.sort.field}</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-2">
                  <p className="text-[11px] text-slate-500">过滤</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {draft.spec.excludeSt && draft.spec.excludeLimitUp ? "ST/涨停" : draft.spec.excludeSt ? "ST" : "自定义"}
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {conditions.map((condition) => (
                  <div key={condition.id} className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2">
                    <span className={cn("mt-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold", GROUP_TONE[condition.group.id])}>
                      {condition.group.label}
                    </span>
                    <span className="min-w-0 flex-1 text-xs leading-5 text-slate-700">{condition.label}</span>
                  </div>
                ))}
              </div>

              {showJson ? (
                <div className="mt-3 rounded-md bg-slate-50 p-3 font-mono text-[11px] leading-5 text-slate-600">
                  <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap">{copyableJson(draft)}</pre>
                </div>
              ) : null}
              {draft.warnings.length ? (
                <div className="mt-3 space-y-1 text-xs leading-5 text-amber-700">
                  {draft.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState
              icon={<Layers3 className="h-5 w-5" />}
              title="暂无策略草案"
              description="输入描述后先识别策略意图，再编译为受控日级选股 JSON；未配置 DEEPSEEK_API_KEY 时使用本地规则解析。"
              className="m-4 border-0 bg-slate-50"
            />
          )}

          <div className="border-b border-slate-100 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <Database className="h-4 w-4 text-blue-600" />
                <div>
                  <p className="text-xs text-slate-500">扫描标的</p>
                  <p className="text-sm font-semibold text-slate-950">{result?.scannedSymbols ?? "-"}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <Gauge className="h-4 w-4 text-emerald-600" />
                <div>
                  <p className="text-xs text-slate-500">命中候选</p>
                  <p className="text-sm font-semibold text-slate-950">{result?.totalCandidates ?? "-"}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <LineChart className="h-4 w-4 text-indigo-600" />
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">数据口径</p>
                  <p className="truncate text-sm font-semibold text-slate-950">{result?.dataBasis ?? "-"}</p>
                </div>
              </div>
            </div>
          </div>

          {result && result.candidates.length ? (
            <div className="max-h-[720px] overflow-auto p-3">
              <div className="space-y-2">
                {result.candidates.map((candidate, index) => {
                  const selected = selectedCandidate?.symbol === candidate.symbol;
                  return (
                    <button
                      key={candidate.symbol}
                      type="button"
                      onClick={() => setSelectedSymbol(candidate.symbol)}
                      className={cn(
                        "w-full rounded-md border px-3 py-3 text-left transition",
                        selected
                          ? "border-blue-200 bg-blue-50"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-slate-400">#{index + 1}</span>
                            <p className="font-semibold text-slate-950">{candidateName(candidate)}</p>
                            <span className="font-mono text-xs text-slate-500">{candidate.symbol}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {candidate.signals.slice(0, 5).map((signal) => (
                              <span key={signal} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600">
                                {signal}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold tabular-nums text-slate-950">{formatNumberValue(candidate.close, 2)}</p>
                          <p className={cn("text-xs font-medium tabular-nums", signedToneClass(candidate.changePercent))}>
                            {formatSignedPercent(candidate.changePercent)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                        <div>
                          <p className="text-slate-400">20日强弱</p>
                          <p className={cn("mt-0.5 font-semibold tabular-nums", signedToneClass(candidate.strength20dPct))}>
                            {formatSignedPercent(candidate.strength20dPct)}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-400">成交额</p>
                          <p className="mt-0.5 font-semibold tabular-nums text-slate-900">{formatLargeValue(candidate.amount, 1)}</p>
                        </div>
                        <div>
                          <p className="text-slate-400">量能</p>
                          <p className="mt-0.5 font-semibold tabular-nums text-slate-900">{formatNumberValue(candidate.amountRatio20d, 2)}</p>
                        </div>
                        <div>
                          <p className="text-slate-400">分数</p>
                          <p className="mt-0.5 font-semibold tabular-nums text-slate-900">{formatNumberValue(candidate.score, 2)}</p>
                        </div>
                      </div>
                      {candidate.warnings.length ? (
                        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-amber-700">
                          {candidate.warnings.slice(0, 2).join("；")}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : result ? (
            <EmptyState title="没有命中候选" description="当前条件可能过严，或本地 K 线覆盖不足。" className="m-4 border-0 bg-slate-50" />
          ) : (
            <EmptyState title="暂无命中列表" description="先生成策略 JSON，再执行筛选。" className="m-4 border-0 bg-slate-50" />
          )}
        </div>

        <div className="min-w-0 rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-950">命中标的 K 线与基本信息</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {selectedCandidate
                ? `${selectedCandidate.name ?? selectedCandidate.code} · ${selectedCandidate.symbol} · ${selectedCandidate.tradeDate}`
                : "选择命中股票后显示行情详情"}
            </p>
          </div>

          {selectedCandidate && selectedMember && selectedUniverse ? (
            <div>
              <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">最新收盘</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatNumberValue(selectedCandidate.close, 2)}</p>
                </div>
                <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">涨跌幅</p>
                  <p className={cn("mt-1 text-lg font-semibold tabular-nums", signedToneClass(selectedCandidate.changePercent))}>
                    {formatSignedPercent(selectedCandidate.changePercent)}
                  </p>
                </div>
                <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">成交额</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{formatLargeValue(selectedCandidate.amount, 1)}</p>
                </div>
                <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">样本根数</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{selectedCandidate.sampleCount}</p>
                </div>
              </div>
              <div className="border-b border-slate-100 p-4">
                <div className="rounded-md border border-slate-200 bg-slate-50">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Timer className="h-4 w-4 text-blue-600" />
                        <p className="text-sm font-semibold text-slate-950">候选股分钟分析</p>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        日线筛选保持只读；只有点击后才按需拉取真实分钟K，单次最多20只。
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                        日线 · 本地
                      </Badge>
                      <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                        盘中5分钟更新 · 动态日K
                      </Badge>
                      <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700">
                        真实分钟K · 按需
                      </Badge>
                    </div>
                  </div>

                  <div className="grid gap-3 p-3 lg:grid-cols-[minmax(180px,0.8fr)_minmax(190px,0.9fr)_auto] lg:items-end">
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium text-slate-500">分析档位</p>
                      <Select
                        value={minuteProfile}
                        onValueChange={(value) => {
                          setMinuteProfile(value as MinuteProfileId);
                          setMinuteResult(null);
                          setMinuteError(null);
                        }}
                      >
                        <SelectTrigger className="h-9 bg-white text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MINUTE_PROFILE_OPTIONS.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.label} · {option.detail}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="text-[11px] text-slate-500">DeepSeek 建议档位</p>
                      <p className="mt-1 text-xs font-semibold text-slate-800">
                        {MINUTE_PROFILE_OPTIONS.find((option) => option.id === draft?.recommendedDataProfile)?.label
                          ?? (draft?.recommendedDataProfile === "daily_live_5m" ? "盘中动态日K" : "日线收盘策略")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={runMinuteAnalysis}
                      disabled={isMinuteLoading}
                      className="h-9"
                    >
                      {isMinuteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      {isMinuteLoading ? "正在准备" : "拉取并分析"}
                    </Button>
                  </div>

                  {minuteError ? (
                    <div className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-semibold">分钟源不可用，已保留日线筛选结果</p>
                        <p>{minuteError}</p>
                      </div>
                    </div>
                  ) : null}

                  {selectedMinuteItem ? (
                    <div className="mx-3 mb-3 rounded-md border border-slate-200 bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              selectedMinuteItem.status === "ready" || selectedMinuteItem.status === "refreshed"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : selectedMinuteItem.status === "degraded"
                                  ? "border-amber-200 bg-amber-50 text-amber-700"
                                  : "border-red-200 bg-red-50 text-red-700"
                            )}
                          >
                            {selectedMinuteItem.status === "ready"
                              ? "缓存可用"
                              : selectedMinuteItem.status === "refreshed"
                                ? "已刷新"
                                : selectedMinuteItem.status === "degraded"
                                  ? "过期缓存"
                                  : "不可用"}
                          </Badge>
                          <span className="text-xs font-semibold text-slate-800">{minuteResult?.profile.label}</span>
                          <span className="font-mono text-[11px] text-slate-400">
                            {selectedMinuteItem.returnedBars}/{selectedMinuteItem.requestedBars} 根
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500">
                          {selectedMinuteItem.fetchedAt
                            ? new Date(selectedMinuteItem.fetchedAt).toLocaleString("zh-CN", { hour12: false })
                            : "尚未取得时间"}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] text-slate-500">数据源</p>
                          <p className="mt-1 text-xs font-semibold text-slate-900">{selectedMinuteItem.source ?? "-"}</p>
                        </div>
                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] text-slate-500">缓存</p>
                          <p className="mt-1 text-xs font-semibold text-slate-900">{selectedMinuteItem.cacheStatus}</p>
                        </div>
                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] text-slate-500">RSI14</p>
                          <p className="mt-1 text-xs font-semibold tabular-nums text-slate-900">
                            {formatNumberValue(
                              typeof selectedMinuteItem.indicators.rsi14 === "number"
                                ? selectedMinuteItem.indicators.rsi14
                                : null,
                              2
                            )}
                          </p>
                        </div>
                        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <p className="text-[11px] text-slate-500">MACD柱</p>
                          <p className="mt-1 text-xs font-semibold tabular-nums text-slate-900">
                            {formatNumberValue(
                              typeof selectedMinuteItem.indicators.macd_hist === "number"
                                ? selectedMinuteItem.indicators.macd_hist
                                : null,
                              4
                            )}
                          </p>
                        </div>
                      </div>
                      {selectedMinuteItem.error ? (
                        <p className="mt-2 text-xs leading-5 text-red-700">{selectedMinuteItem.error}</p>
                      ) : null}
                      {selectedMinuteItem.warnings.length ? (
                        <p className="mt-2 text-xs leading-5 text-amber-700">
                          {selectedMinuteItem.warnings.join("；")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <StockKlineDetail member={selectedMember} universe={selectedUniverse} />
            </div>
          ) : (
            <EmptyState
              icon={<LineChart className="h-5 w-5" />}
              title="暂无选中标的"
              description="执行筛选后会默认选中第一条命中股票，也可以在命中列表中切换。"
              className="m-4 border-0 bg-slate-50"
            />
          )}

          {result?.notes.length ? (
            <div className="border-t border-slate-100 px-4 py-3 text-xs leading-5 text-slate-500">
              {result.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
