import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import {
  authenticateDesktopRequest,
  enforceRateLimit,
  readLimitedJson,
} from '@/lib/desktop-connection/server-auth';
import { connectionErrorResponse } from '@/lib/desktop-connection/responses';
import { diagnosticEventSchema, redactDiagnosticText } from '@/lib/desktop-connection/diagnostics';

const uploadSchema = z.object({
  consent: z.literal(true),
  events: z.array(diagnosticEventSchema).min(1).max(20),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const session = await authenticateDesktopRequest(request);
    const input = uploadSchema.parse(await readLimitedJson(request));
    if (input.events.some((event) => event.installationId !== session.installationId)) {
      return NextResponse.json({ error: 'Installation mismatch' }, { status: 403 });
    }
    enforceRateLimit(
      `diagnostics:${session.accountId}:${session.installationId}`,
      120,
      5 * 60 * 1000
    );
    await prisma.desktopDiagnosticEvent.createMany({
      data: input.events.map((event) => ({
        accountId: session.accountId,
        installationId: event.installationId,
        appVersion: event.appVersion,
        windowsVersion: event.windowsVersion,
        architecture: event.architecture,
        appSchemaVersion: event.appSchemaVersion,
        marketSchemaVersion: event.marketSchemaVersion,
        feature: event.feature,
        errorCode: event.errorCode,
        severity: event.severity,
        sanitizedStack: redactDiagnosticText(event.sanitizedStack),
        occurredAt: new Date(event.occurredAt),
        durationMs: event.durationMs,
      })),
    });
    return NextResponse.json({ accepted: input.events.length }, { status: 202 });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
