import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getProjectById, isSafeProjectId } from '@/lib/services/project';
import { withBasePath } from '@/lib/config/public-paths';
import {
  ImageValidationError,
  MAX_IMAGE_BYTES,
  validateImageBytes,
} from '@/lib/security/image-files';
import { readLimitedFormData, RequestBodyError } from '@/lib/security/request-body';
import { ensureSafeChildDirectory } from '@/lib/security/safe-filesystem';

const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

function resolveAssetsPath(projectId: string): Promise<string> {
  return ensureSafeChildDirectory(PROJECTS_DIR_ABSOLUTE, [projectId, 'assets']);
}

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
    const formData = await readLimitedFormData(request, MAX_MULTIPART_BYTES);
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'File field is required' }, { status: 400 });
    }

    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Image size must be between 1 byte and 10 MB' },
        { status: 413 }
      );
    }
    const imageBuffer = Buffer.from(await file.arrayBuffer());
    const imageType = validateImageBytes(imageBuffer, file.type);

    const projectAssetsPath = await resolveAssetsPath(project_id);

    const originalName = file.name || 'image.png';
    const uniqueName = `${randomUUID()}${imageType.extension}`;
    const absolutePath = path.join(projectAssetsPath, uniqueName);
    const resolvedAbsolutePath = path.resolve(absolutePath);

    await fs.writeFile(resolvedAbsolutePath, imageBuffer);

    let hostPublicPath: string | null = null;
    let projectPublicPath: string | null = null;
    let publicUrl: string | null = null;
    try {
      const rootUploadsDir = await ensureSafeChildDirectory(
        /*turbopackIgnore: true*/ process.cwd(),
        ['public', 'uploads'],
      );
      const hostDestination = path.join(rootUploadsDir, uniqueName);
      try {
        await fs.access(hostDestination);
      } catch {
        await fs.copyFile(resolvedAbsolutePath, hostDestination);
      }
      hostPublicPath = hostDestination;
      publicUrl = withBasePath(`/uploads/${uniqueName}`);
    } catch (copyError) {
      console.warn('[Assets Upload] Failed to mirror asset into application public/uploads:', copyError);
    }

    try {
      const projectRoot = project.repoPath
        ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(/*turbopackIgnore: true*/ process.cwd(), project.repoPath))
        : path.join(PROJECTS_DIR_ABSOLUTE, project_id);
      const uploadsDir = await ensureSafeChildDirectory(projectRoot, ['public', 'uploads']);
      projectPublicPath = path.join(uploadsDir, uniqueName);
      try {
        await fs.access(projectPublicPath);
      } catch {
        await fs.copyFile(resolvedAbsolutePath, projectPublicPath);
      }
    } catch (copyError) {
      console.warn('[Assets Upload] Failed to mirror asset into project public/uploads:', copyError);
      projectPublicPath = null;
      if (!hostPublicPath) {
        publicUrl = null;
      }
    }

    return NextResponse.json({
      success: true,
      path: `assets/${uniqueName}`,
      absolute_path: uniqueName,
      filename: uniqueName,
      original_filename: originalName,
      public_path: publicUrl,
      public_url: publicUrl,
    });
  } catch (error) {
    console.error('[Assets Upload] Failed:', error);
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof ImageValidationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to upload image',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
