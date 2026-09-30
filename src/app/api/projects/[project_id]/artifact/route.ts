import fs from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getProjectById, isSafeProjectId } from '@/lib/services/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

class ArtifactPathError extends Error {}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.json') return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function resolveProjectPath(projectId: string, repoPath?: string | null) {
  if (repoPath) {
    return path.isAbsolute(repoPath) ? repoPath : path.resolve(/*turbopackIgnore: true*/ process.cwd(), repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
}

async function resolveSafeArtifactPath(projectPath: string, relativePath: string): Promise<string | null> {
  const root = await fs.realpath(path.resolve(projectPath)).catch(() => null);
  if (!root) {
    return null;
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(root, normalizedRelativePath);
  const resolved = await fs.realpath(candidate).catch(() => null);
  if (!resolved) {
    return null;
  }

  const relative = path.relative(root, resolved);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new ArtifactPathError('Path traversal is not allowed');
  }

  return resolved;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    if (!isSafeProjectId(project_id)) {
      return NextResponse.json({ success: false, error: 'Invalid project ID' }, { status: 400 });
    }

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const artifactPath = new URL(request.url).searchParams.get('path');
    if (!artifactPath) {
      return NextResponse.json({ success: false, error: 'path query parameter is required' }, { status: 400 });
    }

    const projectPath = resolveProjectPath(project_id, project.repoPath);
    const absolutePath = await resolveSafeArtifactPath(projectPath, artifactPath);
    if (!absolutePath) {
      return NextResponse.json({ success: false, error: 'Artifact not found' }, { status: 404 });
    }
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ success: false, error: 'Artifact not found' }, { status: 404 });
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Artifact exceeds the 20 MB download limit' },
        { status: 413 },
      );
    }

    const body = await fs.readFile(absolutePath);
    const response = new NextResponse(body as unknown as BodyInit);
    response.headers.set('Content-Type', contentType(absolutePath));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('[API] Failed to read project artifact:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to read project artifact',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
