import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createErrorResponse, createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  buildDeepSeekStrategyIntents,
  buildDeepSeekTechnicalScreenerDraft,
  compileStrategyIntentsDraft,
} from '@/lib/quant/smart-strategy';
import { SMART_STRATEGY_MAX_PROMPT_LENGTH } from '@/lib/quant/strategy-types';
import {
  TECHNICAL_SCREENER_ALLOWED_FIELDS,
  TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS,
} from '@/lib/quant/strategy-intent';
import {
  bootstrapStrategyMarketData,
  controlStrategyIngestionJob,
  getSmartStrategyPageData,
  runTechnicalScreener,
} from '@/lib/quant/strategies';
import type { StrategyDataProfileId } from '@/lib/quant/strategies';
import { refreshStrategyData } from '@/lib/quant/strategy-data-refresh';
import {
  consumeMinuteAnalysisEstimate,
  createMinuteAnalysisEstimate,
} from '@/lib/quant/analysis-estimates';

const promptSchema = z.string()
  .trim()
  .min(1, '请输入策略描述')
  .max(SMART_STRATEGY_MAX_PROMPT_LENGTH, `策略描述不能超过 ${SMART_STRATEGY_MAX_PROMPT_LENGTH} 个字符`);
const universeIdSchema = z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  z.string().trim().min(1).max(120).optional()
);
const limitSchema = z.number().int().min(1).max(100).optional();
const tradeDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '交易日期必须使用 YYYY-MM-DD 格式')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }, '交易日期不是有效的日历日期')
  .optional();
const minuteProfileSchema = z.enum([
  'minute1_entry',
  'minute1_momentum',
  'minute1_pattern',
  'minute5_confirm',
  'minute_backtest',
]);
const technicalConditionSchema = z.object({
  field: z.enum(TECHNICAL_SCREENER_ALLOWED_FIELDS),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'between']),
  value: z.union([z.number().finite(), z.boolean(), z.string().max(120), z.null()]).optional(),
  valueField: z.enum(TECHNICAL_SCREENER_ALLOWED_FIELDS).nullable().optional(),
  upperValue: z.number().finite().nullable().optional(),
  label: z.string().max(180).nullable().optional(),
}).strict().superRefine((condition, context) => {
  const hasValue = condition.value !== null && condition.value !== undefined && condition.value !== '';
  if (!condition.valueField && !hasValue) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: '没有引用其他字段时必须提供比较值',
    });
  }
  if (condition.valueField && hasValue) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: '字段比较和值比较只能选择一种',
    });
  }
  if (condition.operator === 'between') {
    if (condition.valueField || typeof condition.value !== 'number') {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'between 条件必须提供数值下限，不能引用其他字段',
      });
    }
    if (condition.upperValue === null || condition.upperValue === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['upperValue'],
        message: 'between 条件必须提供上限',
      });
    } else if (typeof condition.value === 'number' && condition.upperValue < condition.value) {
      context.addIssue({
        code: 'custom',
        path: ['upperValue'],
        message: 'between 条件上限不能小于下限',
      });
    }
  } else if (condition.upperValue !== null && condition.upperValue !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['upperValue'],
      message: '只有 between 条件可以提供上限',
    });
  }
});
const technicalSpecSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1_000).nullable().optional(),
  timeframe: z.literal('daily'),
  adjustment: z.enum(['qfq', 'hfq', 'none']),
  minSampleCount: z.number().int().min(1).max(2_000),
  excludeSt: z.boolean(),
  excludeLimitUp: z.boolean(),
  conditions: z.array(technicalConditionSchema).min(1).max(24),
  sort: z.object({
    field: z.enum(TECHNICAL_SCREENER_ALLOWED_SORT_FIELDS),
    direction: z.enum(['asc', 'desc']),
  }).strict(),
}).strict();

function minuteFingerprintInput(input: {
  symbols: string[];
  profile: string;
  universeId?: string;
  tradeDate?: string;
  limit?: number;
  spec: unknown;
  force?: boolean;
}) {
  return {
    symbols: input.symbols.map((symbol) => symbol.toUpperCase()),
    profile: input.profile,
    universeId: input.universeId ?? null,
    tradeDate: input.tradeDate ?? null,
    limit: input.limit ?? null,
    spec: input.spec,
    force: input.force === true,
  };
}

function invalidRequest(message: string) {
  return createErrorResponse('智能策略请求参数无效', message, 400);
}

function firstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}：` : '';
  return `${path}${issue?.message ?? '参数格式不正确'}`;
}

async function ensureUniverseReady(
  universeId: string | undefined,
  allowReadySubset: boolean
) {
  const pageData = await getSmartStrategyPageData();
  const universe = pageData.research.universes.find((item) => item.id === universeId)
    ?? pageData.research.universes.find((item) => item.id === pageData.research.primaryUniverseId)
    ?? pageData.research.universes[0];
  if (!universe || universe.memberCount <= 0) {
    return createErrorResponse(
      '股票池没有真实证券数据',
      '请先在当前页面点击“导入全 A 股并开始补数”。',
      409
    );
  }
  if (universe.readyCount <= 0) {
    return createErrorResponse(
      '本地日线尚未就绪',
      '补数已经启动时请等待首批完成；任务进度会在当前页面自动刷新。',
      409
    );
  }
  if (!allowReadySubset && universe.readyCount < universe.memberCount) {
    return createErrorResponse(
      '所选股票池仍在补数',
      `当前 ${universe.readyCount}/${universe.memberCount} 支已就绪。请等待全部完成，或在页面明确开启“仅筛选已就绪标的”。`,
      409
    );
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'data-status') {
      return createSuccessResponse(await getSmartStrategyPageData());
    }

    if (action === 'initialize-market-data') {
      const input = z.object({ universeId: universeIdSchema }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      const bootstrap = await bootstrapStrategyMarketData({
        universeId: input.data.universeId,
        timeoutMs: 10_000,
      });
      return createSuccessResponse({
        catalogJobId: bootstrap.catalogJobId,
        catalogStatus: bootstrap.catalogStatus,
        historyJobId: bootstrap.historyJobId,
        reusedExistingJob: bootstrap.reusedExistingJob,
        state: await getSmartStrategyPageData(),
      }, 202);
    }

    if (action === 'control-data-task') {
      const input = z.object({
        jobId: z.string().trim().min(1).max(180),
        taskAction: z.enum(['pause', 'resume', 'stop']),
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      await controlStrategyIngestionJob({
        jobId: input.data.jobId,
        action: input.data.taskAction,
        reason: 'smart-strategy-workbench',
      });
      return createSuccessResponse(await getSmartStrategyPageData());
    }

    if (action === 'draft') {
      const input = z.object({
        prompt: promptSchema,
        universeId: universeIdSchema,
        limit: limitSchema,
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      return createSuccessResponse(
        await buildDeepSeekTechnicalScreenerDraft({
          prompt: input.data.prompt,
          universeId: input.data.universeId,
          limit: input.data.limit,
        }),
        201
      );
    }

    if (action === 'parse-intent') {
      const input = z.object({
        prompt: promptSchema,
        universeId: universeIdSchema,
        limit: limitSchema,
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      return createSuccessResponse(
        await buildDeepSeekStrategyIntents({
          prompt: input.data.prompt,
          universeId: input.data.universeId,
          limit: input.data.limit,
        })
      );
    }

    if (action === 'compile') {
      const input = z.object({
        prompt: promptSchema,
        intents: z.array(z.unknown()).min(1).max(24),
        universeId: universeIdSchema,
        limit: limitSchema,
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      return createSuccessResponse(
        compileStrategyIntentsDraft({
          prompt: input.data.prompt,
          intents: input.data.intents,
          universeId: input.data.universeId,
          limit: input.data.limit,
        })
      );
    }

    if (action === 'run') {
      const input = z.object({
        universeId: universeIdSchema,
        tradeDate: tradeDateSchema,
        limit: limitSchema,
        allowReadySubset: z.boolean().optional(),
        spec: technicalSpecSchema,
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      const readinessError = await ensureUniverseReady(
        input.data.universeId,
        input.data.allowReadySubset === true
      );
      if (readinessError) return readinessError;
      return createSuccessResponse(
        await runTechnicalScreener({
          universeId: input.data.universeId,
          tradeDate: input.data.tradeDate,
          limit: input.data.limit,
          spec: input.data.spec,
          timeoutMs: 15_000,
        })
      );
    }

    if (action === 'estimate-analysis') {
      const input = z.object({
        symbols: z.array(
          z.string().trim().min(1).max(48).regex(/^[A-Za-z0-9._:-]+$/, 'Invalid symbol')
        ).min(1).max(20),
        profile: minuteProfileSchema,
        universeId: universeIdSchema,
        tradeDate: tradeDateSchema,
        limit: limitSchema,
        spec: technicalSpecSchema,
        force: z.boolean().optional(),
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      const { symbols, profile, universeId, tradeDate, limit, spec } = input.data;
      const dailyResult = await runTechnicalScreener({
        universeId,
        tradeDate,
        limit: limit ?? 20,
        spec,
        timeoutMs: 15_000,
      });
      const dailyCandidates = new Set(dailyResult.candidates.map((candidate) => candidate.symbol));
      const rejectedSymbols = symbols.filter((symbol: string) => !dailyCandidates.has(symbol));
      if (rejectedSymbols.length) {
        return createErrorResponse(
          `minute analysis only accepts current daily screener candidates: ${rejectedSymbols.join(', ')}`,
          undefined,
          409
        );
      }
      return createSuccessResponse(await createMinuteAnalysisEstimate({
        fingerprintInput: minuteFingerprintInput(input.data),
        profile: profile as StrategyDataProfileId,
        symbols,
      }));
    }

    if (action === 'prepare-analysis') {
      const input = z.object({
        symbols: z.array(
          z.string().trim().min(1).max(48).regex(/^[A-Za-z0-9._:-]+$/, '标的代码格式不正确')
        ).min(1).max(20),
        profile: minuteProfileSchema,
        universeId: universeIdSchema,
        tradeDate: tradeDateSchema,
        limit: limitSchema,
        spec: technicalSpecSchema,
        force: z.boolean().optional(),
        estimateId: z.string().uuid(),
        confirmed: z.literal(true),
      }).safeParse(body);
      if (!input.success) return invalidRequest(firstIssue(input.error));
      const { symbols, profile, universeId, tradeDate, limit, spec, force, estimateId, confirmed } = input.data;
      const dailyResult = await runTechnicalScreener({
        universeId,
        tradeDate,
        limit: limit ?? 20,
        spec,
        timeoutMs: 15_000,
      });
      const dailyCandidates = new Set(dailyResult.candidates.map((candidate) => candidate.symbol));
      const rejectedSymbols = symbols.filter((symbol: string) => !dailyCandidates.has(symbol));
      if (rejectedSymbols.length) {
        return createErrorResponse(
          `minute analysis only accepts current daily screener candidates: ${rejectedSymbols.join(', ')}`,
          undefined,
          409
        );
      }
      await consumeMinuteAnalysisEstimate({
        estimateId,
        confirmed,
        fingerprintInput: minuteFingerprintInput(input.data),
      });
      return createSuccessResponse(
        await refreshStrategyData({
          profile: profile as StrategyDataProfileId,
          symbols,
          universeId,
          force: force === true,
          estimateId,
        })
      );
    }

    return createErrorResponse('Unsupported smart strategy action', undefined, 400);
  } catch (error) {
    return handleApiError(error, 'SmartStrategy', 'Failed to run smart strategy');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
