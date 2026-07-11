import type {
  StrategyIntent,
  TechnicalScreenerDraft,
} from '@/lib/quant/strategy-types';
import {
  compileIntentToTechnicalSpec,
  parseStrategyIntent,
  TECHNICAL_SCREENER_ALLOWED_FIELDS,
  TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS,
} from '@/lib/quant/strategy-intent';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_DEFAULT_TIMEOUT_MS = 30_000;

const TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT = `You are QuantPilot's A-share daily technical screener intent parser.
Return only JSON. Do not return SQL, code, markdown, investment advice, or direct buy/sell instructions.
The JSON must use this shape:
{
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
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeEndpoint(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return `${DEEPSEEK_DEFAULT_BASE_URL}/chat/completions`;
  return trimmed.endsWith('/v1')
    ? `${trimmed}/chat/completions`
    : `${trimmed}/chat/completions`;
}

function getDeepSeekConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured. Add it to .env.local to use Smart Strategy.');
  }
  const timeoutRaw = Number(process.env.DEEPSEEK_TIMEOUT_MS?.trim());
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
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

  const config = getOptionalDeepSeekConfig();
  if (!config) {
    return {
      prompt,
      intents: parseStrategyIntent({ prompt }),
      generatedBy: 'rule-template',
      model: null,
      usage: null,
      fetchedAt: new Date().toISOString(),
      warnings: [
        'DEEPSEEK_API_KEY is not configured; QuantPilot used the deterministic intent parser for this draft.',
      ],
      llmSystemPrompt: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(normalizeEndpoint(config.baseUrl), {
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
        'DeepSeek only parsed intent; QuantPilot service code compiled the final whitelist strategy JSON.',
      ],
      llmSystemPrompt: TECHNICAL_SCREENER_LLM_SYSTEM_PROMPT,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`DeepSeek API timeout after ${config.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function compileStrategyIntentsDraft(params: {
  prompt: string;
  intents: StrategyIntent[];
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
  };
}
