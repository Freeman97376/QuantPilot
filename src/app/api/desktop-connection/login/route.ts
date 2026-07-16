import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  enforceRateLimit,
  loginDesktopAccount,
  readLimitedJson,
  requestIp,
} from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';

const schema = z.object({
  username: z.string(),
  password: z.string(),
  installationId: z.string().uuid(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    enforceRateLimit(`login:${requestIp(request)}`, 10, 15 * 60 * 1000);
    const input = schema.parse(await readLimitedJson(request));
    return NextResponse.json(await loginDesktopAccount(input));
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
