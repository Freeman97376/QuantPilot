import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProjectById, isSafeProjectId } from '@/lib/services/project';
import { ImageValidationError, validateImageBytes } from '@/lib/security/image-files';
import { ensureSafeChildDirectory } from '@/lib/security/safe-filesystem';

interface RouteContext {
  params: Promise<{ project_id: string; filename: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

async function resolveSafeAssetFile(projectId: string, filename: string): Promise<string | null> {
  if (!SAFE_FILENAME_PATTERN.test(filename)) return null;
  const assetsDir = await ensureSafeChildDirectory(
    PROJECTS_DIR_ABSOLUTE,
    [projectId, 'assets'],
  );
  const candidatePath = path.resolve(assetsDir, filename);
  const [realAssetsDir, realFilePath] = await Promise.all([
    fs.realpath(assetsDir).catch(() => null),
    fs.realpath(candidatePath).catch(() => null),
  ]);
  if (!realAssetsDir || !realFilePath) return null;

  const relativePath = path.relative(realAssetsDir, realFilePath);
  if (
    relativePath.startsWith('..')
    || path.isAbsolute(relativePath)
    || relativePath === ''
  ) {
    return null;
  }
  return realFilePath;
}


export async function GET(_request: Request, { params }: RouteContext) {
  const { project_id, filename } = await params;
  if (!isSafeProjectId(project_id)) {
    return NextResponse.json({ success: false, error: 'Invalid asset path' }, { status: 400 });
  }


  try {

    console.log('📸 Asset serving request:', {
      project_id,
      filename,
      projectsDir: PROJECTS_DIR,
      userAgent: _request.headers.get('user-agent')
    });

    const project = await getProjectById(project_id);
    if (!project) {
      console.log('📸 Asset serving failed: Project not found:', project_id);
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const filePath = await resolveSafeAssetFile(project_id, filename);
    if (!filePath) {
      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }
    console.log('📸 Checking file path:', {
      filePath,
      exists: await fs.access(filePath).then(() => true).catch(() => false)
    });

    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      console.log('📸 Asset serving failed: File not found:', {
        filePath,
        fileStat,
        projectAssetsDir: path.join(PROJECTS_DIR, project_id, 'assets')
      });

      // Check if assets directory exists
      const assetsDir = path.join(PROJECTS_DIR_ABSOLUTE, project_id, 'assets');
      const assetsDirExists = await fs.access(assetsDir).then(() => true).catch(() => false);
      console.log('📸 Assets directory exists:', assetsDirExists);

      // List files in assets directory if it exists
      if (assetsDirExists) {
        try {
          const files = await fs.readdir(assetsDir);
          console.log('📸 Files in assets directory:', files);
        } catch (error) {
          console.log('📸 Failed to list assets directory files:', error);
        }
      }

      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }

    const fileBuffer = await fs.readFile(filePath);
    const imageType = validateImageBytes(fileBuffer);
    const response = new NextResponse(fileBuffer as unknown as BodyInit);
    response.headers.set('Content-Type', imageType.mimeType);
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');

    console.log('📸 Asset serving success:', {
      filename,
      size: fileBuffer.length,
      contentType: imageType.mimeType,
      project_id
    });

    return response;
  } catch (error) {
    if (error instanceof ImageValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 415 });
    }
    console.error('[Assets Get] Failed:', error);
    console.error('[Assets Get] Error details:', {
      project_id,
      filename,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load image',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
