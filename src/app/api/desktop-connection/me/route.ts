import { NextRequest, NextResponse } from 'next/server';
import { authenticateDesktopRequest } from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';

export async function GET(request: NextRequest) {
  try {
    const session = await authenticateDesktopRequest(request);
    return NextResponse.json({
      username: session.account.usernameNormalized,
      installationId: session.installationId,
      accessExpiresAt: session.accessExpiresAt.toISOString(),
      refreshExpiresAt: session.refreshExpiresAt.toISOString(),
      diagnosticsSupported: true,
    });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
