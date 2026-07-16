import { NextRequest, NextResponse } from 'next/server';
import { revokeDesktopSession } from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';

export async function POST(request: NextRequest) {
  try {
    await revokeDesktopSession(request);
    return NextResponse.json({ revoked: true });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
