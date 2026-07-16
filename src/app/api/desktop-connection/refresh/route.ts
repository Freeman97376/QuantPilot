import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readLimitedJson, refreshDesktopSession } from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';

const schema = z.object({
  refreshToken: z.string().min(1),
  installationId: z.string().uuid(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const input = schema.parse(await readLimitedJson(request));
    return NextResponse.json(
      await refreshDesktopSession(input.refreshToken, input.installationId)
    );
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
