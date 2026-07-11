import { NextRequest } from 'next/server';
import { createErrorResponse, createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  buildDeepSeekStrategyIntents,
  buildDeepSeekTechnicalScreenerDraft,
  compileStrategyIntentsDraft,
} from '@/lib/quant/smart-strategy';
import { runTechnicalScreener } from '@/lib/quant/strategies';

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

    return createErrorResponse('Unsupported smart strategy action', undefined, 400);
  } catch (error) {
    return handleApiError(error, 'SmartStrategy', 'Failed to run smart strategy');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
