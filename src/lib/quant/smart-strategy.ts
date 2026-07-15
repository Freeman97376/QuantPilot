import type {
  SmartStrategyRuntimeStatus,
  StrategyDataProfileId,
  StrategyIntent,
  TechnicalScreenerDraft,
} from '@/lib/quant/strategy-types';
import { SMART_STRATEGY_MAX_PROMPT_LENGTH } from '@/lib/quant/strategy-types';
import {
  compileIntentToTechnicalSpec,
  parseStrategyIntent,
  TECHNICAL_SCREENER_ALLOWED_FIELDS,
  TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS,
} from '@/lib/quant/strategy-intent';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_DEFAULT_TIMEOUT_MS = 30_000;
const DEEPSEEK_MAX_OUTPUT_TOKENS = 2_048;

const TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT = `You are QuantPilot's A-share daily technical screener intent parser.
Return only JSON. Do not return SQL, code, markdown, investment advice, or direct buy/sell instructions.
The JSON must use this shape:
{
  "dataProfile": "daily_eod" | "daily_live_5m" | "minute1_entry" | "minute1_momentum" | "minute1_pattern" | "minute5_confirm" | "minute_backtest",
  "intents": [
    {
      "intentType": "trend_alignment" | "ma_slope" | "volume_expansion" | "candlestick_shape" | "momentum_strength" | "risk_filter" | "price_position",
      "confidence": number,
      "rawText": string,
      "mappedFields": string[],
      "conditions": [
        {
          "field": string,
          "operator": "gt" | "gte" | "lt" | "lte" | "eq" | "between",
          "value": number | boolean | string | null,
          "valueField": string | null,
          "upperValue": number | null,
          "label": string
        }
      ],
      "unsupportedTerms": string[],
      "clarificationNeeded": boolean,
      "supportStatus": "supported" | "inferred" | "unsupported" | "needs_clarification",
      "explanation": string,
      "defaulted": boolean
    }
  ]
}
Allowed fields: ${TECHNICAL_SCREENER_ALLOWED_FIELDS.join(', ')}.
Allowed sort fields: ${TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS.join(', ')}.
Mappings: "不要长上影线" => upper_shadow_pct <= 3; "收盘靠近高点" => close_position_pct >= 70; "放量" => amount_ratio_20d >= 1.5; "均线多头" => ma5 >= ma10 and ma10 >= ma20; "趋势向上" => trend alignment, not slope; "斜率大于 X" => ma20_slope_5d_pct or ma60_slope_20d_pct.
If the user says slope is large without a MA, default to ma20_slope_5d_pct and set supportStatus to inferred.
Unsupported terms such as 资金流, 主力, 大单, 盘口, KDJ, BOLL, ATR must be returned in unsupportedTerms and must not be silently mapped to amount or volume.
If conditions conflict, such as asking for long upper shadow and avoiding long upper shadow, set clarificationNeeded true.`;

type DeepSeekChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  model?: string;
  usage?: Record<string, unknown>;
};

type SmartStrategyDraftParams = {
  prompt: string;
  universeId?: string;
  limit?: number;
};

type StrategyIntentParseResult = {
  prompt: string;
  intents: StrategyIntent[];
  generatedBy: TechnicalScreenerDraft['generatedBy'];
  model?: string | null;
  usage?: Record<string, unknown> | null;
  fetchedAt: string;
  warnings: string[];
  llmSystemPrompt: string;
  recommendedDataProfile: StrategyDataProfileId;
};

const STRATEGY_DATA_PROFILES = new Set<StrategyDataProfileId>([
  'daily_eod',
  'daily_live_5m',
  'minute1_entry',
  'minute1_momentum',
  'minute1_pattern',
  'minute5_confirm',
  'minute_backtest',
]);

function inferStrategyDataProfile(prompt: string): StrategyDataProfileId {
  const compact = prompt.replace(/\s+/g, '');
  if (/分钟.{0,8}(回测|复盘)|回测.{0,8}分钟/.test(compact)) return 'minute_backtest';
  if (/5分钟|五分钟/.test(compact)) return 'minute5_confirm';
  if (/(1分钟|一分钟).{0,12}(形态|走势|结构)|(形态|走势|结构).{0,12}(1分钟|一分钟)/.test(compact)) {
    return 'minute1_pattern';
  }
  if (/(1分钟|一分钟).{0,12}(动量|强弱)|(动量|强弱).{0,12}(1分钟|一分钟)/.test(compact)) {
    return 'minute1_momentum';
  }
  if (/1分钟|一分钟|入场|买点/.test(compact)) return 'minute1_entry';
  if (/盘中|实时|当日放量|动态日K/.test(compact)) return 'daily_live_5m';
  return 'daily_eod';
}

function parseDataProfile(value: unknown, prompt: string): StrategyDataProfileId {
  return typeof value === 'string' && STRATEGY_DATA_PROFILES.has(value as StrategyDataProfileId)
    ? value as StrategyDataProfileId
    : inferStrategyDataProfile(prompt);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeEndpoint(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const value = trimmed || DEEPSEEK_DEFAULT_BASE_URL;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('DEEPSEEK_BASE_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('DEEPSEEK_BASE_URL must use HTTP or HTTPS.');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('DEEPSEEK_BASE_URL must not contain embedded credentials.');
  }
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/chat/completions')) {
    endpoint.pathname = `${pathname}/chat/completions`.replace(/^\/\//, '/');
  }
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

function getDeepSeekConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured. Add it to .env.local to use Smart Strategy.');
  }
  const timeoutRaw = Number(process.env.DEEPSEEK_TIMEOUT_MS?.trim());
  return {
    apiKey,
    endpoint: normalizeEndpoint(process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL),
    model: process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEEPSEEK_DEFAULT_TIMEOUT_MS,
  };
}

function getOptionalDeepSeekConfig() {
  try {
    return getDeepSeekConfig();
  } catch {
    return null;
  }
}

export function getSmartStrategyRuntimeStatus(): SmartStrategyRuntimeStatus {
  const config = getOptionalDeepSeekConfig();
  return {
    configured: Boolean(config),
    provider: config ? 'deepseek' : 'rule-template',
    model: config?.model ?? null,
    fallbackAvailable: true,
  };
}

function providerErrorSummary(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') return 'DeepSeek 请求超时';
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 180) || 'DeepSeek 暂时不可用';
}

function buildRuleParseResult(
  prompt: string,
  warning: string
): StrategyIntentParseResult {
  return {
    prompt,
    intents: parseStrategyIntent({ prompt }),
    generatedBy: 'rule-template',
    model: null,
    usage: null,
    fetchedAt: new Date().toISOString(),
    warnings: [warning],
    llmSystemPrompt: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT,
    recommendedDataProfile: inferStrategyDataProfile(prompt),
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
    }
    throw new Error('DeepSeek did not return valid JSON.');
  }
}

export async function buildDeepSeekStrategyIntents(
  params: SmartStrategyDraftParams
): Promise<StrategyIntentParseResult> {
  const prompt = params.prompt.trim().replace(/\s+/g, ' ');
  if (!prompt) throw new Error('Please enter a smart strategy description.');
  if (prompt.length > SMART_STRATEGY_MAX_PROMPT_LENGTH) {
    throw new Error(`Smart strategy description must be ${SMART_STRATEGY_MAX_PROMPT_LENGTH} characters or fewer.`);
  }

  const config = getOptionalDeepSeekConfig();
  if (!config) {
    return buildRuleParseResult(
      prompt,
      '未配置可用的 DeepSeek 连接；已自动切换为本地确定性意图解析，仍可生成并复核策略。'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Universe: ${params.universeId || 'default'}\nTop N: ${params.limit ?? 20}\nUser strategy: ${prompt}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
        stream: false,
        thinking: { type: 'disabled' },
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`DeepSeek API ${response.status}: ${body.slice(0, 260)}`);
    }

    const completion = await response.json() as DeepSeekChatCompletion;
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned an empty intent parse result.');

    const parsed = parseJsonObject(content);
    return {
      prompt,
      intents: parseStrategyIntent({ prompt, llmIntents: parsed }),
      generatedBy: 'deepseek',
      model: completion.model || config.model,
      usage: completion.usage ?? null,
      fetchedAt: new Date().toISOString(),
      warnings: [
        'DeepSeek 只负责解析意图；最终白名单策略 JSON 由 QuantPilot 服务端确定性编译。',
      ],
      llmSystemPrompt: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT,
      recommendedDataProfile: parseDataProfile(parsed.dataProfile, prompt),
    };
  } catch (error) {
    return buildRuleParseResult(
      prompt,
      `DeepSeek 暂时不可用，已自动降级为本地确定性解析。原因：${providerErrorSummary(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function compileStrategyIntentsDraft(params: {
  prompt: string;
  intents: unknown[];
  universeId?: string;
  limit?: number;
}): TechnicalScreenerDraft {
  const intents = parseStrategyIntent({
    prompt: params.prompt,
    llmIntents: { intents: params.intents },
  });
  const draft = compileIntentToTechnicalSpec({
    ...params,
    intents,
  });
  return {
    ...draft,
    llmSystemPrompt: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT,
    recommendedDataProfile: inferStrategyDataProfile(params.prompt),
  };
}

export async function buildDeepSeekTechnicalScreenerDraft(
  params: SmartStrategyDraftParams
): Promise<TechnicalScreenerDraft> {
  const parsed = await buildDeepSeekStrategyIntents(params);
  const draft = compileStrategyIntentsDraft({
    prompt: parsed.prompt,
    intents: parsed.intents,
    universeId: params.universeId,
    limit: params.limit,
  });
  return {
    ...draft,
    generatedBy: parsed.generatedBy,
    model: parsed.model,
    usage: parsed.usage ?? null,
    fetchedAt: parsed.fetchedAt,
    warnings: [...parsed.warnings, ...draft.warnings],
    llmSystemPrompt: parsed.llmSystemPrompt,
    recommendedDataProfile: parsed.recommendedDataProfile,
  };
}
