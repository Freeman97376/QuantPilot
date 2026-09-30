import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProjectById, isSafeProjectId } from '@/lib/services/project';
import { ImageValidationError, MAX_IMAGE_BYTES, validateImageBytes } from '@/lib/security/image-files';
import { readLimitedJson, RequestBodyError } from '@/lib/security/request-body';
import { ensureSafeChildDirectory } from '@/lib/security/safe-filesystem';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);
const MAX_LOGO_BODY_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024 * 1024;


export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    if (!isSafeProjectId(project_id)) {
      return NextResponse.json({ success: false, error: 'Invalid project ID' }, { status: 400 });
    }
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const body = await readLimitedJson(request, MAX_LOGO_BODY_BYTES) as Record<string, unknown>;
    const b64 = typeof body?.b64_png === 'string' ? body.b64_png : null;
    if (!b64) {
      return NextResponse.json({ success: false, error: 'b64_png is required' }, { status: 400 });
    }

    const buffer = Buffer.from(b64, 'base64');
    validateImageBytes(buffer, 'image/png');
    const assetsPath = await ensureSafeChildDirectory(
      PROJECTS_DIR_ABSOLUTE,
      [project_id, 'assets'],
    );
    const logoPath = path.join(assetsPath, 'logo.png');
    await fs.writeFile(logoPath, buffer);

    return NextResponse.json({ success: true, path: 'assets/logo.png' });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (error instanceof ImageValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('[Assets Logo] Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to save logo',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
