import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  loadDesktopPreferences,
  updateDesktopPreferences,
} from '@/lib/desktop/preferences';
import { getRuntimeMode, isDesktopRuntime } from '@/lib/runtime/mode';
import { clearDiagnosticQueue } from '@/lib/desktop/diagnostic-queue';

const updateSchema = z.object({
  minuteDataPolicy: z.enum(['unset', 'enabled', 'disabled']).optional(),
  diagnosticsConsent: z.boolean().optional(),
}).strict();

export async function GET() {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    runtimeMode: getRuntimeMode(),
    preferences: await loadDesktopPreferences(),
  });
}

export async function PUT(request: NextRequest) {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid desktop preferences' }, { status: 400 });
  }
  const preferences = await updateDesktopPreferences(parsed.data);
  if (!preferences.diagnosticsConsent) await clearDiagnosticQueue();
  return NextResponse.json({ preferences });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
