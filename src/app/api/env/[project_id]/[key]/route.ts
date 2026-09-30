import { NextRequest, NextResponse } from 'next/server';
import { updateEnvVar, deleteEnvVar } from '@/lib/services/env';
import { readLimitedJson, RequestBodyError } from '@/lib/security/request-body';

const MAX_ENV_REQUEST_BYTES = 80 * 1024;

interface RouteContext {
  params: Promise<{ project_id: string; key: string }>;
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, key } = await params;
    const body = await readLimitedJson(request, MAX_ENV_REQUEST_BYTES) as Record<string, unknown>;
    if (typeof body?.value !== 'string') {
      return NextResponse.json(
        { success: false, error: 'value must be a string' },
        { status: 400 },
      );
    }

    const updated = await updateEnvVar(project_id, key, body.value);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'Environment variable not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Environment variable '${key}' updated`,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.startsWith('Environment variable')) {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    console.error('[Env API] Failed to update env var:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update environment variable',
        message,
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, key } = await params;
    const deleted = await deleteEnvVar(project_id, key);
    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Environment variable not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Environment variable '${key}' deleted`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.startsWith('Environment variable')) {
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }
    console.error('[Env API] Failed to delete env var:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete environment variable',
        message,
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
