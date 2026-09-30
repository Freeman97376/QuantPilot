import fs from 'fs/promises';
import path from 'path';

export class UnsafeFilesystemPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeFilesystemPathError';
  }
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function canonicalDirectory(rootPath: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(rootPath));
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) {
    throw new UnsafeFilesystemPathError('Expected a directory.');
  }
  return resolved;
}

export async function ensureSafeChildDirectory(
  rootPath: string,
  segments: readonly string[],
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(rootPath);
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || path.basename(segment) !== segment) {
      throw new UnsafeFilesystemPathError('Directory path contains an unsafe segment.');
    }
    const candidate = path.join(current, segment);
    let stat = await fs.lstat(candidate).catch(() => null);
    if (!stat) {
      await fs.mkdir(candidate);
      stat = await fs.lstat(candidate);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeFilesystemPathError('Directory path must not contain symbolic links.');
    }
    const canonicalCandidate = await fs.realpath(candidate);
    if (!isPathInside(canonicalRoot, canonicalCandidate)) {
      throw new UnsafeFilesystemPathError('Directory path escapes its allowed root.');
    }
    current = canonicalCandidate;
  }
  return current;
}

export async function resolveSafeFileForWrite(
  rootPath: string,
  relativeFilePath: string,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(rootPath);
  const normalized = relativeFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(canonicalRoot, normalized);
  if (!isPathInside(canonicalRoot, candidate) || candidate === canonicalRoot) {
    throw new UnsafeFilesystemPathError('File path escapes its allowed root.');
  }

  const parentRelative = path.relative(canonicalRoot, path.dirname(candidate));
  const parentSegments = parentRelative === '' ? [] : parentRelative.split(path.sep);
  const canonicalParent = await ensureSafeChildDirectory(canonicalRoot, parentSegments);
  const safeCandidate = path.join(canonicalParent, path.basename(candidate));
  const existing = await fs.lstat(safeCandidate).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new UnsafeFilesystemPathError('File path must not be a symbolic link.');
  }
  return safeCandidate;
}
