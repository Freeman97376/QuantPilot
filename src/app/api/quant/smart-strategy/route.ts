import { NextRequest } from 'next/server';
import { createErrorResponse, createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  buildDeepSeekStrategyIntents,
  buildDeepSeekTechnicalScreenerDraft,
  compileStrategyIntentsDraft,
} from '@/lib/quant/smart-strategy';
import { runTechnicalScreener } from '@/lib/quant/strategies';
import type { StrategyDataProfileId } from '@/lib/quant/strategies';
import { refreshStrategyData } from '@/lib/quant/strategy-data-refresh';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'draft') {
      return createSuccessResponse(
        await buildDeepSeekTechnicalScreenerDraft({
          prompt: String(body.prompt ?? ''),
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        }),
        201
      );
    }

    if (action === 'parse-intent') {
      return createSuccessResponse(
        await buildDeepSeekStrategyIntents({
          prompt: String(body.prompt ?? ''),
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      );
    }

    if (action === 'compile') {
      if (!Array.isArray(body.intents)) {
        return createErrorResponse('compile action requires intents[]', undefined, 400);
      }
      return createSuccessResponse(
        compileStrategyIntentsDraft({
          prompt: String(body.prompt ?? ''),
          intents: body.intents,
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      );
    }

    if (action === 'run') {
      return createSuccessResponse(
        await runTechnicalScreener({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          tradeDate: typeof body.tradeDate === 'string' ? body.tradeDate : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          spec: body.spec,
          timeoutMs: 15_000,
        })
      );
    }

    if (action === 'prepare-analysis') {
      const symbols = Array.isArray(body.symbols)
        ? body.symbols.map(String).map((symbol: string) => symbol.trim()).filter(Boolean)
        : [];
      if (!symbols.length || symbols.length > 20) {
        return createErrorResponse('prepare-analysis requires 1-20 candidate symbols', undefined, 400);
      }
      const allowedProfiles = new Set<StrategyDataProfileId>([
        'minute1_entry',
        'minute1_momentum',
        'minute1_pattern',
        'minute5_confirm',
        'minute_backtest',
      ]);
      const profile = String(body.profile ?? '') as StrategyDataProfileId;
      if (!allowedProfiles.has(profile)) {
        return createErrorResponse('prepare-analysis requires a minute data profile', undefined, 400);
      }
      if (!body.spec || typeof body.spec !== 'object') {
        return createErrorResponse(
          'prepare-analysis requires the daily screener spec that produced the candidates',
          undefined,
          400
        );
      }
      const dailyResult = await runTechnicalScreener({
        universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
        tradeDate: typeof body.tradeDate === 'string' ? body.tradeDate : undefined,
        limit: typeof body.limit === 'number' ? body.limit : 20,
        spec: body.spec,
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
      return createSuccessResponse(
        await refreshStrategyData({
          profile,
          symbols,
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          force: body.force === true,
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
