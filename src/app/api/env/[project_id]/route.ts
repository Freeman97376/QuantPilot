import { NextRequest, NextResponse } from 'next/server';
import { listEnvVars, createEnvVar, serializeEnvVarForClient } from '@/lib/services/env';
import { readLimitedJson, RequestBodyError } from '@/lib/security/request-body';

const MAX_ENV_REQUEST_BYTES = 80 * 1024;

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const envVars = await listEnvVars(project_id);
    return NextResponse.json(envVars.map(serializeEnvVarForClient));
  } catch (error) {
    console.error('[Env API] Failed to fetch env vars:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch environment variables',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const body = await readLimitedJson(request, MAX_ENV_REQUEST_BYTES) as Record<string, unknown>;
    if (!body?.key || typeof body.key !== 'string') {
      return NextResponse.json(
        { success: false, error: 'key is required' },
        { status: 400 },
      );
    }
    if (typeof body.value !== 'string') {
      return NextResponse.json(
        { success: false, error: 'value must be a string' },
        { status: 400 },
      );
    }

    const record = await createEnvVar(project_id, {
      key: body.key,
      value: body.value,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      varType:
        typeof body.var_type === 'string'
          ? body.var_type
          : typeof body.varType === 'string'
            ? body.varType
            : undefined,
      isSecret:
        typeof body.is_secret === 'boolean'
          ? body.is_secret
          : typeof body.isSecret === 'boolean'
            ? body.isSecret
            : undefined,
      description:
        typeof body.description === 'string' || body.description === null
          ? body.description
          : undefined,
    });

    return NextResponse.json({ success: true, data: serializeEnvVarForClient(record) }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[Env API] Failed to create env var:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('already exists')
      ? 409
      : message.startsWith('Environment variable')
        ? 400
        : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create environment variable',
        message,
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
