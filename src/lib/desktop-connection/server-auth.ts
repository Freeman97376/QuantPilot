import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { isServerRuntime } from '@/lib/runtime/mode';
import {
  readLimitedJson as readBoundedJson,
  RequestBodyError,
} from '@/lib/security/request-body';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const MAX_REQUEST_BYTES = 64 * 1024;

export class DesktopConnectionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function assertServerConnectionApi(): void {
  if (!isServerRuntime) {
    throw new DesktopConnectionError('Not found', 404);
  }
}

export function normalizeUsername(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 64) {
    throw new DesktopConnectionError('Username must contain 3-64 characters.');
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new DesktopConnectionError('Username may contain letters, numbers, dot, underscore, and hyphen.');
  }
  return normalized;
}

export function assertPassword(value: string): void {
  if (value.length < 12 || value.length > 128) {
    throw new DesktopConnectionError('Password must contain 12-128 characters.');
  }
}

export function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  return hash(password, {
    // 2 is Argon2id. Avoid importing the package's ambient const enum because
    // this project compiles with isolatedModules enabled.
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

function issueOpaqueToken(prefix: 'at' | 'rt'): string {
  return `qp_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function readLimitedJson(request: NextRequest): Promise<unknown> {
  try {
    return await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      throw new DesktopConnectionError(error.message, error.status);
    }
    throw error;
  }
}

async function recordFailedLogin(accountId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const account = await tx.desktopAccount.findUnique({ where: { id: accountId } });
        if (!account) return;
        const failedLoginCount = account.failedLoginCount + 1;
        await tx.desktopAccount.update({
          where: { id: accountId },
          data: {
            failedLoginCount,
            lockedUntil:
              failedLoginCount >= MAX_FAILED_LOGINS
                ? new Date(Date.now() + LOCKOUT_MS)
                : account.lockedUntil,
          },
        });
      }, { isolationLevel: 'Serializable' });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export async function loginDesktopAccount(params: {
  username: string;
  password: string;
  installationId: string;
}) {
  assertServerConnectionApi();
  const usernameNormalized = normalizeUsername(params.username);
  assertPassword(params.password);
  const account = await prisma.desktopAccount.findUnique({ where: { usernameNormalized } });

  if (!account) {
    // Perform an Argon2id operation for nonexistent accounts to reduce the
    // usefulness of timing differences for username enumeration.
    await hashPassword(params.password);
    throw new DesktopConnectionError('账号或密码错误', 401);
  }
  if (
    account.status !== 'active' ||
    (account.lockedUntil && account.lockedUntil.getTime() > Date.now())
  ) {
    throw new DesktopConnectionError('账号或密码错误', 401);
  }

  const passwordValid = await verify(account.passwordHash, params.password).catch(() => false);
  if (!passwordValid) {
    await recordFailedLogin(account.id);
    throw new DesktopConnectionError('账号或密码错误', 401);
  }

  const accessToken = issueOpaqueToken('at');
  const refreshToken = issueOpaqueToken('rt');
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  await prisma.$transaction([
    prisma.desktopAccount.update({
      where: { id: account.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    }),
    prisma.desktopSession.create({
      data: {
        accountId: account.id,
        accessTokenHash: tokenHash(accessToken),
        refreshTokenHash: tokenHash(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
        installationId: params.installationId,
        tokenVersion: account.tokenVersion,
      },
    }),
  ]);

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    username: account.usernameNormalized,
  };
}

export function bearerToken(request: NextRequest): string {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    throw new DesktopConnectionError('Unauthorized', 401);
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new DesktopConnectionError('Unauthorized', 401);
  return token;
}

export async function authenticateDesktopRequest(request: NextRequest) {
  assertServerConnectionApi();
  const session = await prisma.desktopSession.findUnique({
    where: { accessTokenHash: tokenHash(bearerToken(request)) },
    include: { account: true },
  });
  if (
    !session || session.revokedAt || session.accessExpiresAt.getTime() <= Date.now() ||
    session.account.status !== 'active' || session.tokenVersion !== session.account.tokenVersion
  ) {
    throw new DesktopConnectionError('Unauthorized', 401);
  }
  return session;
}

export async function refreshDesktopSession(refreshToken: string, installationId: string) {
  assertServerConnectionApi();
  const session = await prisma.desktopSession.findUnique({
    where: { refreshTokenHash: tokenHash(refreshToken) },
    include: { account: true },
  });
  if (
    !session || session.revokedAt || session.refreshExpiresAt.getTime() <= Date.now() ||
    session.installationId !== installationId || session.account.status !== 'active' ||
    session.tokenVersion !== session.account.tokenVersion
  ) {
    throw new DesktopConnectionError('Unauthorized', 401);
  }

  const nextAccessToken = issueOpaqueToken('at');
  const nextRefreshToken = issueOpaqueToken('rt');
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await prisma.desktopSession.update({
    where: { id: session.id },
    data: {
      accessTokenHash: tokenHash(nextAccessToken),
      refreshTokenHash: tokenHash(nextRefreshToken),
      accessExpiresAt,
      refreshExpiresAt,
    },
  });
  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

export async function revokeDesktopSession(request: NextRequest): Promise<void> {
  const session = await authenticateDesktopRequest(request);
  await prisma.desktopSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
}

type LimitBucket = { count: number; resetAt: number };
const rateLimits = new Map<string, LimitBucket>();
const MAX_RATE_LIMIT_BUCKETS = 10_000;

function pruneRateLimits(now: number): void {
  for (const [key, bucket] of rateLimits) {
    if (bucket.resetAt <= now) rateLimits.delete(key);
  }
  while (rateLimits.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimits.keys().next().value as string | undefined;
    if (!oldestKey) break;
    rateLimits.delete(oldestKey);
  }
}

export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  if (rateLimits.size >= MAX_RATE_LIMIT_BUCKETS) pruneRateLimits(now);
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new DesktopConnectionError('Too many requests', 429);
  }
}

export function requestIp(request: NextRequest): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded?.at(-1) || 'unknown';
}
