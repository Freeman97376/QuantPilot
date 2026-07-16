import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  clearDiagnosticQueue,
  diagnosticQueueStatus,
  enqueueDiagnostic,
  flushDiagnosticQueue,
} from '@/lib/desktop/diagnostic-queue';
import { isDesktopRuntime } from '@/lib/runtime/mode';

const eventSchema = z.object({
  feature: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  errorCode: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  severity: z.enum(['info', 'warning', 'error', 'fatal']),
  stack: z.string().max(32_768).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
}).strict();

export async function GET() {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(await diagnosticQueueStatus());
}

export async function POST(request: NextRequest) {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const input = eventSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: 'Invalid diagnostic event' }, { status: 400 });
  try {
    await enqueueDiagnostic(input.data);
    return NextResponse.json(await flushDiagnosticQueue(), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE() {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await clearDiagnosticQueue();
  return NextResponse.json({ queued: 0 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
