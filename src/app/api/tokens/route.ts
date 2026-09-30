import { NextRequest } from 'next/server';
import { createServiceToken } from '@/lib/services/tokens';
import { readLimitedJson, RequestBodyError } from '@/lib/security/request-body';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

const MAX_TOKEN_REQUEST_BYTES = 32 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = await readLimitedJson(request, MAX_TOKEN_REQUEST_BYTES) as Record<string, unknown>;
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const name = typeof body?.name === 'string' ? body.name : '';

    const record = await createServiceToken(provider, token, name);
    return createSuccessResponse(record, 201);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return handleApiError(error, 'Tokens API', 'Failed to save token');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
