import type {
  StrategyIntent,
  StrategyIntentSupportStatus,
  StrategyIntentType,
  TechnicalScreenerCondition,
  TechnicalScreenerDraft,
  TechnicalScreenerOperator,
  TechnicalScreenerSpec,
} from '@/lib/quant/strategy-types';

const MAX_CONDITIONS = 24;

export const TECHNICAL_SCREENER_ALLOWED_FIELDS = [
  'open',
  'close',
  'high',
  'low',
  'previous_close',
  'change_percent',
  'amount',
  'volume',
  'turnover',
  'ma5',
  'ma10',
  'ma20',
  'ma30',
  'ma60',
  'ma120',
  'ma250',
  'ma5_slope_5d_pct',
  'ma10_slope_5d_pct',
  'ma20_slope_5d_pct',
  'ma60_slope_20d_pct',
  'ema12',
  'ema26',
  'strength_5d_pct',
  'strength_10d_pct',
  'strength_20d_pct',
  'strength_60d_pct',
  'rsi6',
  'rsi14',
  'macd_dif',
  'macd_dea',
  'macd_hist',
  'upper_shadow_pct',
  'lower_shadow_pct',
  'body_pct',
  'amplitude',
  'close_position_pct',
  'amount_ratio_5d',
  'amount_ratio_20d',
  'volume_ratio_5d',
  'volume_ratio_20d',
  'turnover_avg_20d',
  'close_to_ma5_pct',
  'close_to_ma20_pct',
  'close_to_ma60_pct',
  'close_to_ma120_pct',
  'limit_up_count_4d',
  'limit_up_count_10d',
  'sample_count',
  'score',
  'is_limit_up',
  'is_st',
] as const;

export const TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS = [
  'score',
  'strength_20d_pct',
  'amount_ratio_20d',
  'amount_ratio_5d',
  'volume_ratio_20d',
  'volume_ratio_5d',
  'amount',
  'turnover',
  'close_position_pct',
  'ma20_slope_5d_pct',
  'ma60_slope_20d_pct',
] as const;

const ALLOWED_FIELD_SET = new Set<string>(TECHNICAL_SCREENER_ALLOWED_FIELDS);
const ALLOWED_SORT_FIELD_SET = new Set<string>(TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS);
const UNSUPPORTED_TERM_PATTERNS = [
  /资金流|資金流|主力|大单|大單|盘口|盤口|委比|委差|dde/i,
  /kdj|boll|布林|atr/i,
];

type ParseStrategyIntentParams = {
  prompt: string;
  llmIntents?: unknown;
};

type CompileIntentParams = {
  prompt: string;
  intents: StrategyIntent[];
  universeId?: string;
  limit?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function normalizePrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, ' ');
}

function condition(
  field: string,
  operator: TechnicalScreenerOperator,
  value: number | boolean | string | null,
  label: string,
  valueField?: string,
  upperValue?: number
): TechnicalScreenerCondition {
  return {
    field,
    operator,
    value,
    valueField: valueField ?? null,
    upperValue: upperValue ?? null,
    label,
  };
}

function intent(params: {
  index: number;
  intentType: StrategyIntentType;
  confidence?: number;
  rawText: string;
  mappedFields?: string[];
  conditions?: TechnicalScreenerCondition[];
  unsupportedTerms?: string[];
  clarificationNeeded?: boolean;
  supportStatus?: StrategyIntentSupportStatus;
  explanation?: string;
  defaulted?: boolean;
  source?: StrategyIntent['source'];
}): StrategyIntent {
  const unsupportedTerms = params.unsupportedTerms ?? [];
  const clarificationNeeded = params.clarificationNeeded ?? false;
  const supportStatus =
    params.supportStatus ??
    (clarificationNeeded ? 'needs_clarification' : unsupportedTerms.length ? 'unsupported' : 'supported');
  return {
    id: `${params.intentType}-${params.index}`,
    intentType: params.intentType,
    confidence: Math.max(0, Math.min(params.confidence ?? 0.8, 1)),
    rawText: params.rawText,
    mappedFields: params.mappedFields ?? [],
    conditions: params.conditions ?? [],
    unsupportedTerms,
    clarificationNeeded,
    supportStatus,
    explanation: params.explanation ?? null,
    defaulted: params.defaulted ?? false,
    source: params.source ?? 'rule',
  };
}

function conditionKey(item: TechnicalScreenerCondition) {
  return [
    item.field,
    item.operator,
    item.value ?? '',
    item.valueField ?? '',
    item.upperValue ?? '',
  ].join('|');
}

function addCondition(items: TechnicalScreenerCondition[], item: TechnicalScreenerCondition) {
  const key = conditionKey(item);
  if (!items.some((existing) => conditionKey(existing) === key)) {
    items.push(item);
  }
}

function extractNumber(prompt: string, patterns: RegExp[], fallback: number) {
  for (const pattern of patterns) {
    const match = pattern.exec(prompt);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function extractUnsupportedTerms(prompt: string) {
  const terms = new Set<string>();
  const candidates = ['资金流', '主力', '大单', '盘口', '委比', 'DDE', 'KDJ', 'BOLL', '布林', 'ATR'];
  for (const term of candidates) {
    if (new RegExp(term, 'i').test(prompt)) terms.add(term);
  }
  return Array.from(terms);
}

function includesUnsupportedTerms(prompt: string) {
  return UNSUPPORTED_TERM_PATTERNS.some((pattern) => pattern.test(prompt));
}

function maSlopeField(prompt: string) {
  const lower = prompt.toLowerCase();
  if (/ma5|5日均线|五日均线/.test(lower)) return { field: 'ma5_slope_5d_pct', label: 'MA5 5日斜率', defaulted: false };
  if (/ma10|10日均线|十日均线/.test(lower)) return { field: 'ma10_slope_5d_pct', label: 'MA10 5日斜率', defaulted: false };
  if (/ma60|60日均线|六十日均线|季线/.test(lower)) return { field: 'ma60_slope_20d_pct', label: 'MA60 20日斜率', defaulted: false };
  if (/ma20|20日均线|二十日均线|月线/.test(lower)) return { field: 'ma20_slope_5d_pct', label: 'MA20 5日斜率', defaulted: false };
  return { field: 'ma20_slope_5d_pct', label: 'MA20 5日斜率', defaulted: true };
}

function normalizeCondition(value: unknown): TechnicalScreenerCondition | null {
  const record = asRecord(value);
  const field = asString(record.field);
  if (!ALLOWED_FIELD_SET.has(field)) return null;
  const valueFieldRaw = record.valueField ?? record.value_field;
  const valueField = valueFieldRaw === null || valueFieldRaw === undefined || valueFieldRaw === ''
    ? null
    : asString(valueFieldRaw);
  if (valueField && !ALLOWED_FIELD_SET.has(valueField)) return null;
  const operator = normalizeOperator(record.operator);
  const boolValue = asBoolean(record.value);
  return condition(
    field,
    operator,
    boolValue ?? asNumber(record.value) ?? (typeof record.value === 'string' ? record.value.trim() : null),
    asString(record.label) || `${field} ${operator}`,
    valueField || undefined,
    asNumber(record.upperValue ?? record.upper_value) ?? undefined
  );
}

function normalizeOperator(value: unknown): TechnicalScreenerOperator {
  if (value === 'gt' || value === 'gte' || value === 'lt' || value === 'lte' || value === 'eq' || value === 'between') {
    return value;
  }
  return 'gte';
}

function normalizeLlmIntent(value: unknown, index: number): StrategyIntent | null {
  const record = asRecord(value);
  const intentType = asString(record.intentType ?? record.intent_type) as StrategyIntentType;
  if (!['trend_alignment', 'ma_slope', 'volume_expansion', 'candlestick_shape', 'momentum_strength', 'risk_filter', 'price_position'].includes(intentType)) {
    return null;
  }
  const rawConditions = Array.isArray(record.conditions) ? record.conditions : [];
  const conditions = rawConditions.map(normalizeCondition).filter((item): item is TechnicalScreenerCondition => Boolean(item));
  const mappedFieldsValue = record.mappedFields ?? record.mapped_fields;
  const mappedFieldsRaw: unknown[] = Array.isArray(mappedFieldsValue) ? mappedFieldsValue : [];
  const mappedFields = mappedFieldsRaw
    .map((field) => asString(field))
    .filter((field) => ALLOWED_FIELD_SET.has(field));
  const unsupportedTermsValue = record.unsupportedTerms ?? record.unsupported_terms;
  const unsupportedTermsRaw: unknown[] = Array.isArray(unsupportedTermsValue) ? unsupportedTermsValue : [];
  const unsupportedTerms = unsupportedTermsRaw.map((term) => asString(term)).filter(Boolean);
  const clarificationNeeded = asBoolean(record.clarificationNeeded ?? record.clarification_needed) ?? false;
  const supportStatus = asString(record.supportStatus ?? record.support_status) as StrategyIntentSupportStatus;
  return intent({
    index,
    intentType,
    confidence: asNumber(record.confidence) ?? 0.7,
    rawText: asString(record.rawText ?? record.raw_text) || intentType,
    mappedFields,
    conditions,
    unsupportedTerms,
    clarificationNeeded,
    supportStatus: ['supported', 'inferred', 'unsupported', 'needs_clarification'].includes(supportStatus)
      ? supportStatus
      : undefined,
    explanation: asString(record.explanation),
    defaulted: asBoolean(record.defaulted) ?? false,
    source: 'llm',
  });
}

function parseRuleBasedStrategyIntent(prompt: string): StrategyIntent[] {
  const normalized = normalizePrompt(prompt);
  const lower = normalized.toLowerCase();
  const intents: StrategyIntent[] = [];
  let index = 0;

  const push = (item: Omit<Parameters<typeof intent>[0], 'index'>) => {
    intents.push(intent({ ...item, index }));
    index += 1;
  };

  const unsupportedTerms = extractUnsupportedTerms(normalized);
  if (unsupportedTerms.length || includesUnsupportedTerms(normalized)) {
    push({
      intentType: 'risk_filter',
      rawText: unsupportedTerms.join('、') || normalized,
      unsupportedTerms,
      supportStatus: 'unsupported',
      explanation: '当前日级技术筛选没有真实资金流、盘口、大单或未纳入指标字段，不会替换成成交额。',
    });
  }

  const hasBullTrend = /均线多头|多头排列|趋势向上|上升趋势|向上趋势|站上均线|ma5\s*[>=＞>]\s*ma10|ma10\s*[>=＞>]\s*ma20/i.test(normalized);
  if (hasBullTrend) {
    push({
      intentType: 'trend_alignment',
      rawText: normalized,
      mappedFields: ['ma5', 'ma10', 'ma20', 'strength_20d_pct'],
      conditions: [
        condition('ma5', 'gte', null, 'MA5 >= MA10', 'ma10'),
        condition('ma10', 'gte', null, 'MA10 >= MA20', 'ma20'),
      ],
      supportStatus: /趋势向上|上升趋势|向上趋势/.test(normalized) ? 'inferred' : 'supported',
      explanation: /趋势向上|上升趋势|向上趋势/.test(normalized)
        ? '系统把“趋势向上”默认理解为短中期均线多头排列，而不是斜率。'
        : '系统按均线多头排列理解趋势条件。',
      defaulted: /趋势向上|上升趋势|向上趋势/.test(normalized),
    });
  }

  const priceMaConditions: TechnicalScreenerCondition[] = [];
  const priceAboveMaMappings = [
    { field: 'ma5', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma5|5日均线|五日均线)/i, label: '收盘价 >= MA5' },
    { field: 'ma10', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma10|10日均线|十日均线)/i, label: '收盘价 >= MA10' },
    { field: 'ma20', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma20|20日均线|二十日均线|月线)/i, label: '收盘价 >= MA20' },
    { field: 'ma60', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma60|60日均线|六十日均线|季线)/i, label: '收盘价 >= MA60' },
    { field: 'ma120', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma120|120日均线|半年线)/i, label: '收盘价 >= MA120' },
    { field: 'ma250', pattern: /(?:(?:收盘价?|价格).{0,8})?(?:站上|高于|突破).{0,2}(?:ma250|250日均线|年线)/i, label: '收盘价 >= MA250' },
  ] as const;
  for (const mapping of priceAboveMaMappings) {
    if (mapping.pattern.test(normalized)) {
      priceMaConditions.push(condition('close', 'gte', null, mapping.label, mapping.field));
    }
  }
  if (/(?:ma120|120日均线|半年线).{0,10}(?:在|位于|高于|站上|大于).{0,6}(?:ma250|250日均线|年线)/i.test(normalized)) {
    priceMaConditions.push(condition('ma120', 'gte', null, 'MA120 >= MA250', 'ma250'));
  }
  if (priceMaConditions.length) {
    push({
      intentType: 'trend_alignment',
      rawText: normalized,
      mappedFields: Array.from(new Set(priceMaConditions.flatMap((item) => [item.field, item.valueField].filter(Boolean) as string[]))),
      conditions: priceMaConditions,
      supportStatus: 'supported',
      explanation: '系统按收盘价与指定均线、长周期均线之间的相对位置编译趋势条件。',
    });
  }

  if (/斜率|变陡|均线向上|均线往上|向上发散|20日均线向上|ma20.*向上|ma60.*向上/i.test(normalized)) {
    const slope = maSlopeField(normalized);
    const threshold = extractNumber(
      normalized,
      [
        /斜率.{0,12}?大于\s*(\d+(?:\.\d+)?)%?/i,
        /斜率.{0,12}?>=?\s*(\d+(?:\.\d+)?)%?/i,
        /(?:ma5|ma10|ma20|ma60|均线).{0,12}?(\d+(?:\.\d+)?)%/i,
      ],
      0
    );
    push({
      intentType: 'ma_slope',
      rawText: normalized,
      mappedFields: [slope.field],
      conditions: [
        condition(slope.field, 'gte', threshold, `${slope.label} >= ${threshold}%`),
      ],
      supportStatus: slope.defaulted ? 'inferred' : 'supported',
      explanation: slope.defaulted
        ? '用户没有指定哪条均线，系统默认用 MA20 5日斜率。'
        : `系统按 ${slope.label} 计算均线斜率。`,
      defaulted: slope.defaulted || threshold === 0,
    });
  }

  if (/放量|量能|成交额.{0,16}(?:放大|活跃)|成交量.{0,16}放大|量价/.test(normalized)) {
    const ratioField = /成交量/.test(normalized) && !/成交额/.test(normalized)
      ? 'volume_ratio_20d'
      : 'amount_ratio_20d';
    const ratioSubject = ratioField === 'volume_ratio_20d' ? '成交量较20日均量' : '成交额较20日均额';
    const ratio = extractNumber(
      normalized,
      [
        /(?:放量|量能|成交额.{0,12}放大|成交量.{0,12}放大).{0,12}?(\d+(?:\.\d+)?)\s*倍/,
        /(\d+(?:\.\d+)?)\s*倍.{0,8}(?:放量|量能)/,
      ],
      /活跃/.test(normalized) ? 1 : 1.5
    );
    push({
      intentType: 'volume_expansion',
      rawText: normalized,
      mappedFields: [ratioField],
      conditions: [
        condition(ratioField, 'gte', ratio, `${ratioSubject} >= ${ratio}倍`),
      ],
      supportStatus: ratio === 1.5 || ratio === 1 ? 'inferred' : 'supported',
      explanation: ratio === 1.5
        ? `系统把当前量能要求理解为${ratioSubject}至少1.5倍。`
        : ratio === 1
          ? `系统把“活跃”默认理解为${ratioSubject}不低于1倍。`
          : `系统按用户给定倍数映射${ratioSubject}放大。`,
      defaulted: ratio === 1.5 || ratio === 1,
    });
  }

  if (/macd/i.test(normalized)) {
    const macdConditions: TechnicalScreenerCondition[] = [];
    if (/金叉|dif.{0,8}(?:上穿|高于|大于|>=|＞).{0,5}dea/i.test(normalized)) {
      macdConditions.push(condition('macd_dif', 'gte', null, 'MACD DIF >= DEA', 'macd_dea'));
    }
    if (/macd.{0,8}(?:柱|hist).{0,8}(?:翻红|为正|大于\s*0|>\s*0)/i.test(normalized)) {
      macdConditions.push(condition('macd_hist', 'gt', 0, 'MACD 柱 > 0'));
    }
    if (!macdConditions.length) {
      macdConditions.push(condition('macd_dif', 'gte', null, 'MACD DIF >= DEA', 'macd_dea'));
    }
    push({
      intentType: 'momentum_strength',
      rawText: normalized,
      mappedFields: Array.from(new Set(macdConditions.flatMap((item) => [item.field, item.valueField].filter(Boolean) as string[]))),
      conditions: macdConditions,
      supportStatus: /金叉|dif|dea|柱|hist/i.test(normalized) ? 'supported' : 'inferred',
      explanation: /金叉/i.test(normalized)
        ? '系统把 MACD 金叉映射为 DIF 不低于 DEA。'
        : '系统按 MACD 动量方向生成可复核条件。',
      defaulted: !/金叉|dif|dea|柱|hist/i.test(normalized),
    });
  }

  if (/rsi\s*(?:6|14)?/i.test(normalized)) {
    const rsiPeriod = /rsi\s*6/i.test(normalized) ? 6 : 14;
    const rsiField = rsiPeriod === 6 ? 'rsi6' : 'rsi14';
    const upperMatch = /rsi\s*(?:6|14)?.{0,8}(?:不高于|小于等于|低于|小于|<=|≤)\s*(\d+(?:\.\d+)?)/i.exec(normalized);
    const lowerMatch = /rsi\s*(?:6|14)?.{0,8}(?:不低于|大于等于|高于|大于|>=|≥)\s*(\d+(?:\.\d+)?)/i.exec(normalized);
    const threshold = Number(upperMatch?.[1] ?? lowerMatch?.[1] ?? 70);
    const operator: TechnicalScreenerOperator = upperMatch ? 'lte' : lowerMatch ? 'gte' : 'lte';
    push({
      intentType: 'momentum_strength',
      rawText: normalized,
      mappedFields: [rsiField],
      conditions: [condition(rsiField, operator, threshold, `RSI${rsiPeriod} ${operator === 'lte' ? '<=' : '>='} ${threshold}`)],
      supportStatus: upperMatch || lowerMatch ? 'supported' : 'inferred',
      explanation: upperMatch || lowerMatch
        ? `系统按用户给定阈值约束 RSI${rsiPeriod}。`
        : `用户没有给出 RSI${rsiPeriod} 阈值，系统默认用 70 作为过热上限。`,
      defaulted: !upperMatch && !lowerMatch,
    });
  }

  const mentionsUpperShadow = /上影线|上引线|长上影|冲高回落/.test(normalized);
  const avoidUpperShadow = mentionsUpperShadow && /不要|避免|排除|不能|没有|无|不是/.test(normalized);
  const explicitLongUpperShadow = /上影线.{0,8}(?:很长|较长|长|明显)|长上影/.test(normalized);
  const explicitAvoidLongUpperShadow = /(?:不要|避免|排除|不能|没有|无).{0,8}(?:长上影|上影线)|不是.{0,4}冲高回落/.test(normalized);
  const requireLongUpperShadow = mentionsUpperShadow && !avoidUpperShadow && /长|很长|明显|冲高回落/.test(normalized);
  const conflictingUpperShadow =
    explicitLongUpperShadow &&
    explicitAvoidLongUpperShadow &&
    /同时|又|但|且|并且|还/.test(normalized);
  if (mentionsUpperShadow) {
    const threshold = extractNumber(normalized, [/(?:上影线|上引线|长上影).{0,12}?(\d+(?:\.\d+)?)%/], 3);
    const conditions = [
      condition(
        'upper_shadow_pct',
        avoidUpperShadow ? 'lte' : 'gte',
        threshold,
        avoidUpperShadow ? `上影线 <= ${threshold}%` : `上影线 >= ${threshold}%`
      ),
    ];
    if (/冲高回落/.test(normalized)) {
      conditions.push(
        condition('close_position_pct', avoidUpperShadow ? 'gte' : 'lte', avoidUpperShadow ? 60 : 40, avoidUpperShadow ? '收盘位置 >= 60%' : '收盘位置 <= 40%')
      );
    }
    push({
      intentType: 'candlestick_shape',
      rawText: normalized,
      mappedFields: conditions.map((item) => item.field),
      conditions,
      clarificationNeeded: conflictingUpperShadow,
      supportStatus: conflictingUpperShadow ? 'needs_clarification' : threshold === 3 ? 'inferred' : 'supported',
      explanation: conflictingUpperShadow
        ? '同一描述同时要求长上影线和不要长上影线，需要用户澄清。'
        : avoidUpperShadow
          ? '系统把“不要长上影线/不是冲高回落”映射为上影线占比上限。'
          : requireLongUpperShadow
            ? '系统把“长上影线/冲高回落”映射为上影线占比下限。'
            : '系统按上影线条件理解日K形态。',
      defaulted: threshold === 3,
    });
  }

  if (/收盘.*(?:靠近|接近).*高点|收在高位|收盘强|收盘靠近高点/.test(normalized)) {
    push({
      intentType: 'price_position',
      rawText: normalized,
      mappedFields: ['close_position_pct'],
      conditions: [
        condition('close_position_pct', 'gte', 70, '收盘位置 >= 70%'),
      ],
      supportStatus: 'inferred',
      explanation: '系统把“收盘靠近高点”默认理解为收盘位置不低于当日振幅区间的70%。',
      defaulted: true,
    });
  }

  const hasStrengthUpperBound = /还没涨太多|没涨太多|涨幅约束|(?:涨幅|强弱)[^，,。；;]{0,8}(?:不高于|小于|低于)/.test(normalized);
  const hasGenericOverheat = /不要过热|不过热/.test(normalized) && !/rsi\s*(?:6|14)?/i.test(normalized);
  if (hasStrengthUpperBound || hasGenericOverheat) {
    const threshold = extractNumber(normalized, [/(?:涨幅|强弱).{0,12}?(?:小于|不高于|<=|低于)\s*(\d+(?:\.\d+)?)%/], 20);
    push({
      intentType: 'momentum_strength',
      rawText: normalized,
      mappedFields: ['strength_20d_pct'],
      conditions: [
        condition('strength_20d_pct', 'lte', threshold, `20日强弱 <= ${threshold}%`),
      ],
      supportStatus: threshold === 20 ? 'inferred' : 'supported',
      explanation: threshold === 20
        ? '系统把“还没涨太多”默认理解为20日强弱不超过20%。'
        : '系统按用户给定涨幅上限约束20日强弱。',
      defaulted: threshold === 20,
    });
  } else if (/强势|动量|涨幅|强弱|突破/.test(normalized)) {
    const threshold = extractNumber(
      normalized,
      [/(?:20日|20天|二十日).{0,12}?(\d+(?:\.\d+)?)%/, /(?:涨幅|强弱).{0,12}?(\d+(?:\.\d+)?)%/],
      8
    );
    push({
      intentType: 'momentum_strength',
      rawText: normalized,
      mappedFields: ['strength_20d_pct'],
      conditions: [
        condition('strength_20d_pct', 'gte', threshold, `20日强弱 >= ${threshold}%`),
      ],
      supportStatus: threshold === 8 ? 'inferred' : 'supported',
      explanation: threshold === 8 ? '系统把“强势/动量”默认理解为20日强弱至少8%。' : '系统按用户给定强弱阈值映射。',
      defaulted: threshold === 8,
    });
  }

  if (/st|涨停|风控|排除/.test(lower)) {
    const conditions = [condition('is_st', 'eq', false, '排除 ST')];
    if (!/涨停也要|包含涨停|允许涨停/.test(normalized)) {
      conditions.push(condition('is_limit_up', 'eq', false, '排除当日涨停'));
    }
    push({
      intentType: 'risk_filter',
      rawText: normalized,
      mappedFields: conditions.map((item) => item.field),
      conditions,
      explanation: '系统按风控条件排除 ST 和不可交易边界。',
    });
  }

  if (!intents.some((item) => item.conditions.length) && !unsupportedTerms.length) {
    push({
      intentType: 'trend_alignment',
      rawText: normalized,
      mappedFields: ['ma5', 'ma10', 'ma20'],
      conditions: [
        condition('ma5', 'gte', null, 'MA5 >= MA10', 'ma10'),
        condition('ma10', 'gte', null, 'MA10 >= MA20', 'ma20'),
      ],
      supportStatus: 'inferred',
      explanation: '没有识别到明确指标词，默认按短中期均线多头生成可复核草稿。',
      defaulted: true,
    });
  }

  return intents;
}

export function parseStrategyIntent(params: ParseStrategyIntentParams): StrategyIntent[] {
  const prompt = normalizePrompt(params.prompt);
  const llmRaw = Array.isArray(params.llmIntents)
    ? params.llmIntents
    : Array.isArray(asRecord(params.llmIntents).intents)
      ? asRecord(params.llmIntents).intents as unknown[]
      : [];
  const llmIntents = llmRaw
    .map((item, index) => normalizeLlmIntent(item, index))
    .filter((item): item is StrategyIntent => Boolean(item));
  if (llmIntents.length) {
    const unsupportedTerms = extractUnsupportedTerms(prompt);
    if (unsupportedTerms.length && !llmIntents.some((item) => item.unsupportedTerms.length)) {
      llmIntents.push(intent({
        index: llmIntents.length,
        intentType: 'risk_filter',
        rawText: unsupportedTerms.join('、'),
        unsupportedTerms,
        supportStatus: 'unsupported',
        explanation: '服务端白名单校验识别到当前不支持的数据词，未映射到成交额。',
      }));
    }
    return llmIntents;
  }
  return parseRuleBasedStrategyIntent(prompt);
}

export function compileIntentToTechnicalSpec(params: CompileIntentParams): TechnicalScreenerDraft {
  const prompt = normalizePrompt(params.prompt);
  const conditions: TechnicalScreenerCondition[] = [];
  let minSampleCount = 60;
  let sortField: TechnicalScreenerSpec['sort']['field'] = 'score';

  for (const item of params.intents) {
    for (const candidate of item.conditions) {
      if (!ALLOWED_FIELD_SET.has(candidate.field)) continue;
      if (candidate.valueField && !ALLOWED_FIELD_SET.has(candidate.valueField)) continue;
      addCondition(conditions, candidate);
      if (candidate.field === 'ma60_slope_20d_pct' || candidate.valueField === 'ma60') {
        minSampleCount = Math.max(minSampleCount, 80);
      }
      if (candidate.field === 'ma120' || candidate.valueField === 'ma120' || candidate.field === 'close_to_ma120_pct') {
        minSampleCount = Math.max(minSampleCount, 120);
      }
      if (candidate.field === 'ma250' || candidate.valueField === 'ma250') {
        minSampleCount = Math.max(minSampleCount, 250);
      }
    }
    if (item.intentType === 'volume_expansion') {
      sortField = item.mappedFields.includes('volume_ratio_20d') ? 'volume_ratio_20d' : 'amount_ratio_20d';
    }
    if (item.intentType === 'ma_slope') sortField = item.mappedFields.includes('ma60_slope_20d_pct') ? 'ma60_slope_20d_pct' : 'ma20_slope_5d_pct';
    if (item.intentType === 'momentum_strength' && item.mappedFields.includes('strength_20d_pct')) {
      sortField = 'strength_20d_pct';
    }
    if (item.intentType === 'price_position') sortField = 'close_position_pct';
  }

  addCondition(conditions, condition('sample_count', 'gte', minSampleCount, `至少 ${minSampleCount} 根日K，保证指标可用`));
  if (!conditions.some((item) => item.field === 'is_st')) {
    addCondition(conditions, condition('is_st', 'eq', false, '排除 ST'));
  }
  if (!conditions.some((item) => item.field === 'is_limit_up')) {
    addCondition(conditions, condition('is_limit_up', 'eq', false, '排除当日涨停'));
  }

  const unsupportedTerms = Array.from(new Set(params.intents.flatMap((item) => item.unsupportedTerms)));
  const clarificationNeeded = params.intents.some((item) => item.clarificationNeeded);
  const warnings = [
    '系统先识别自然语言意图，再用服务端白名单字段编译策略 JSON；实际筛选由 market-data 后端执行。',
    '筛选结果只用于研究和复盘，不构成买卖建议。',
  ];
  if (unsupportedTerms.length) {
    warnings.unshift(`这些词当前未支持，未映射成其他指标：${unsupportedTerms.join('、')}`);
  }
  if (clarificationNeeded) {
    warnings.unshift('存在互相冲突或需要澄清的意图，请调整条件后再执行。');
  }

  const safeSortField = ALLOWED_SORT_FIELD_SET.has(sortField) ? sortField : 'score';
  return {
    prompt,
    generatedBy: params.intents.some((item) => item.source === 'llm') ? 'deepseek' : 'rule-template',
    fetchedAt: new Date().toISOString(),
    warnings,
    llmSystemPrompt: '',
    intents: params.intents,
    intentExplanations: explainIntentMapping(params.intents),
    unsupportedTerms,
    clarificationNeeded,
    spec: {
      name: prompt.length > 28 ? `${prompt.slice(0, 28)}...` : prompt,
      description: `由“意图识别 -> 指标映射”编译的日级技术选股策略：${prompt}`,
      timeframe: 'daily',
      adjustment: 'qfq',
      minSampleCount,
      excludeSt: true,
      excludeLimitUp: !/涨停也要|包含涨停|允许涨停/.test(prompt),
      conditions: conditions.slice(0, MAX_CONDITIONS),
      sort: {
        field: safeSortField,
        direction: 'desc',
      },
    },
  };
}

export function explainIntentMapping(intents: StrategyIntent[]) {
  return intents.map((item) => {
    if (item.unsupportedTerms.length) {
      return `${item.rawText}: 未支持 ${item.unsupportedTerms.join('、')}`;
    }
    const fields = item.mappedFields.length ? item.mappedFields.join(', ') : '无字段';
    return `${item.rawText}: ${item.explanation ?? '已映射'} (${fields})`;
  });
}

export function assertTechnicalScreenerField(field: string, context = 'field') {
  if (!ALLOWED_FIELD_SET.has(field)) {
    throw new Error(`Unsupported technical screener ${context}: ${field || '(empty)'}`);
  }
}
