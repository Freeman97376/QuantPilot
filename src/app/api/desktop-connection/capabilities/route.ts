import { NextResponse } from 'next/server';
import { assertServerConnectionApi } from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';

export async function GET() {
  try {
    assertServerConnectionApi();
    return NextResponse.json({
      apiVersion: 1,
      authentication: 'username-password',
      registration: false,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      diagnostics: {
        supported: true,
        defaultEnabled: false,
        accountLinked: true,
        retentionDays: 30,
        maxEventBytes: 65_536,
      },
      features: {
        projectSync: false,
        strategySync: false,
        marketDataProxy: false,
        llmProxy: false,
        license: false,
      },
    });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
