import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

class GitError extends Error {
  constructor(message: string, readonly output?: string) {
    super(message);
    this.name = 'GitError';
  }
}

const DEFAULT_GITIGNORE_ENTRIES = [
  '# Dependencies',
  'node_modules/',
  '',
  '# Next.js build output',
  '.next/',
  'out/',
  '',
  '# Build artifacts',
  'dist/',
  'build/',
  '.turbo/',
  '',
  '# Environment files',
  '.env',
  '.env.*',
  '',
  '# Misc',
  '.DS_Store',
  '.git-backup-*',
  '.vercel/',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  'pnpm-debug.log*',
];

function redactGitCredentials(value: string): string {
  return value.replace(/(https?:\/\/)[^@\s/'"]+@/giu, '$1***@');
}

function redactKnownSecrets(value: string, secrets: readonly string[] = []): string {
  return secrets.reduce(
    (redacted, secret) => secret ? redacted.split(secret).join('[redacted]') : redacted,
    value,
  );
}

function ensureGitignore(repoPath: string) {
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${DEFAULT_GITIGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return;
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const existingLines = existing.split(/\r?\n/);
  const normalized = new Set(existingLines.map((line) => line.trim()));

  const additions = DEFAULT_GITIGNORE_ENTRIES.filter((entry) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      // always allow blank lines to keep grouping but avoid duplicating consecutive blanks
      return (
        existingLines.length === 0 ||
        existingLines[existingLines.length - 1].trim().length !== 0
      );
    }
    return !normalized.has(trimmed);
  });

  if (additions.length === 0) {
    return;
  }

  const trimmedExisting = existing.replace(/\s+$/u, '');
  const separator = trimmedExisting.length > 0 ? '\n\n' : '';
  const nextContents = `${trimmedExisting}${separator}${additions.join('\n')}\n`;
  fs.writeFileSync(gitignorePath, nextContents, 'utf8');
}

function runGit(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string | undefined>; secrets?: readonly string[] } = {},
): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 20, // allow larger git output before hitting ENOBUFS
    env: { ...process.env, ...options.env },
  });

  if (result.error) {
    throw new GitError(
      `Git command failed: ${redactKnownSecrets(redactGitCredentials(result.error.message), options.secrets)}`,
      redactKnownSecrets(redactGitCredentials(result.stderr || result.stdout || ''), options.secrets) || undefined
    );
  }

  if (result.status !== 0) {
    const output =
      (typeof result.stderr === 'string' && result.stderr.trim().length > 0
        ? result.stderr
        : typeof result.stdout === 'string'
        ? result.stdout
        : undefined);
    throw new GitError(
      `Git command failed: git ${redactKnownSecrets(redactGitCredentials(args.join(' ')), options.secrets)}`,
      output ? redactKnownSecrets(redactGitCredentials(output), options.secrets) : undefined
    );
  }

  return result.stdout.trim();
}

function untrackIgnoredPaths(repoPath: string) {
  const pathsToUntrack = ['node_modules', '.next', 'dist', 'build', 'out', '.turbo', '.vercel'];
  for (const entry of pathsToUntrack) {
    runGit(['rm', '-r', '--cached', '--ignore-unmatch', entry], repoPath);
  }
}

export function ensureGitConfig(repoPath: string, name: string, email: string) {
  runGit(['config', '--local', 'user.name', name], repoPath);
  runGit(['config', '--local', 'user.email', email], repoPath);
}

export function initializeMainBranch(repoPath: string) {
  try {
    runGit(['rev-parse', 'HEAD'], repoPath);
  } catch {
    try {
      runGit(['commit', '--allow-empty', '-m', 'Initial commit'], repoPath);
    } catch (error) {
      throw error;
    }
  }

  try {
    const currentBranch = runGit(['branch', '--show-current'], repoPath);
    if (currentBranch !== 'main') {
      runGit(['branch', '-M', 'main'], repoPath);
    }
  } catch {
    try {
      runGit(['checkout', '-b', 'main'], repoPath);
    } catch {
      // ignore
    }
  }
}

export function addOrUpdateRemote(repoPath: string, remoteName: string, remoteUrl: string) {
  try {
    const existing = runGit(['remote', 'get-url', remoteName], repoPath);
    if (existing !== remoteUrl) {
      runGit(['remote', 'set-url', remoteName, remoteUrl], repoPath);
    }
  } catch {
    runGit(['remote', 'add', remoteName, remoteUrl], repoPath);
  }
}

export function commitAll(repoPath: string, message: string) {
  try {
    untrackIgnoredPaths(repoPath);
    runGit(['add', '-A'], repoPath);
    runGit(['commit', '-m', message], repoPath);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.output && error.output.includes('nothing to commit')) {
      return false;
    }
    throw error;
  }
}

export function pushToRemote(
  repoPath: string,
  remoteName = 'origin',
  branch = 'main',
  options: { remoteUrl?: string; bearerToken?: string } = {},
) {
  const remote = options.remoteUrl || remoteName;
  const bearerToken = options.bearerToken?.trim();
  if (bearerToken && /[\r\n]/u.test(bearerToken)) {
    throw new GitError('Git bearer token contains invalid control characters.');
  }
  runGit(['push', '-u', remote, branch], repoPath, bearerToken
    ? {
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${bearerToken}`,
          GIT_TERMINAL_PROMPT: '0',
        },
        secrets: [bearerToken],
      }
    : { env: { GIT_TERMINAL_PROMPT: '0' } });
}

export function ensureGitRepository(repoPath: string) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    runGit(['init'], repoPath);
  }
  ensureGitignore(repoPath);
}
