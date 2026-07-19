import { prisma } from '@/lib/db/client';
import type { Prisma } from '@/lib/db/types';
import {
  deleteDesktopSecret,
  getDesktopSecret,
  putDesktopSecret,
} from '@/lib/desktop/secret-broker';
import { isDesktopRuntime, OFFICIAL_DESKTOP_SERVER_URL } from '@/lib/runtime/mode';

const KEY = 'desktop.official-connection';

interface ConnectionState {
  username: string;
  accessReference: string;
  refreshReference: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

function installationId(): string {
  const value = process.env.QUANTPILOT_INSTALLATION_ID?.trim();
  if (!value) throw new Error('Desktop installation identity is unavailable.');
  return value;
}

function parseState(value: unknown): ConnectionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.username !== 'string' || typeof raw.accessReference !== 'string' ||
    typeof raw.refreshReference !== 'string' || typeof raw.accessExpiresAt !== 'string' ||
    typeof raw.refreshExpiresAt !== 'string'
  ) return null;
  return raw as unknown as ConnectionState;
}

async function loadState(): Promise<ConnectionState | null> {
  const record = await prisma.platformSetting.findUnique({ where: { key: KEY } });
  return parseState(record?.value);
}

async function saveState(state: ConnectionState): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: state as unknown as Prisma.InputJsonValue },
    update: { value: state as unknown as Prisma.InputJsonValue },
  });
}

async function officialFetch(path: string, init?: RequestInit) {
  if (!OFFICIAL_DESKTOP_SERVER_URL.startsWith('https://')) {
    throw new Error('Official server connection requires HTTPS.');
  }
  return fetch(`${OFFICIAL_DESKTOP_SERVER_URL}${path}`, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
}

export async function connectOfficialServer(username: string, password: string) {
  if (!isDesktopRuntime) throw new Error('Official desktop connection is only available locally.');
  const response = await officialFetch('/api/desktop-connection/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, installationId: installationId() }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.accessToken !== 'string' || typeof payload.refreshToken !== 'string') {
    throw new Error(payload.error || '账号或密码错误');
  }
  const previous = await loadState();
  const accessReference = await putDesktopSecret(payload.accessToken, previous?.accessReference);
  const refreshReference = await putDesktopSecret(payload.refreshToken, previous?.refreshReference);
  const state: ConnectionState = {
    username: payload.username,
    accessReference,
    refreshReference,
    accessExpiresAt: payload.accessExpiresAt,
    refreshExpiresAt: payload.refreshExpiresAt,
  };
  await saveState(state);
  return publicStatus(state, 'connected');
}

async function refreshState(state: ConnectionState): Promise<ConnectionState> {
  const refreshToken = await getDesktopSecret(state.refreshReference);
  if (!refreshToken) throw new Error('Stored session is unavailable.');
  const response = await officialFetch('/api/desktop-connection/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, installationId: installationId() }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.accessToken !== 'string' || typeof payload.refreshToken !== 'string') {
    throw new Error('Session expired. Please sign in again.');
  }
  const next = {
    ...state,
    accessReference: await putDesktopSecret(payload.accessToken, state.accessReference),
    refreshReference: await putDesktopSecret(payload.refreshToken, state.refreshReference),
    accessExpiresAt: payload.accessExpiresAt,
    refreshExpiresAt: payload.refreshExpiresAt,
  };
  await saveState(next);
  return next;
}

function publicStatus(state: ConnectionState | null, status: string, error?: string) {
  return {
    serverUrl: OFFICIAL_DESKTOP_SERVER_URL,
    status,
    username: state?.username ?? null,
    accessExpiresAt: state?.accessExpiresAt ?? null,
    refreshExpiresAt: state?.refreshExpiresAt ?? null,
    error: error || null,
  };
}

export async function getOfficialConnectionStatus() {
  if (!isDesktopRuntime) return publicStatus(null, 'unavailable');
  let state = await loadState();
  if (!state) return publicStatus(null, 'disconnected');
  try {
    if (new Date(state.accessExpiresAt).getTime() <= Date.now() + 60_000) {
      state = await refreshState(state);
    }
    const accessToken = await getDesktopSecret(state.accessReference);
    if (!accessToken) return publicStatus(state, 'expired', 'Stored access token is unavailable.');
    const response = await officialFetch('/api/desktop-connection/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) return publicStatus(state, 'expired', 'Session expired.');
    if (!response.ok) return publicStatus(state, 'offline', `Official server returned ${response.status}.`);
    return publicStatus(state, 'connected');
  } catch (error) {
    return publicStatus(state, 'offline', error instanceof Error ? error.message : String(error));
  }
}

export async function getOfficialAccessToken(): Promise<{ token: string; state: ConnectionState } | null> {
  let state = await loadState();
  if (!state) return null;
  if (new Date(state.accessExpiresAt).getTime() <= Date.now() + 60_000) {
    state = await refreshState(state);
  }
  const token = await getDesktopSecret(state.accessReference);
  return token ? { token, state } : null;
}

export async function disconnectOfficialServer(): Promise<void> {
  const state = await loadState();
  if (!state) return;
  const accessToken = await getDesktopSecret(state.accessReference);
  if (accessToken) {
    await officialFetch('/api/desktop-connection/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => null);
  }
  await Promise.all([
    deleteDesktopSecret(state.accessReference),
    deleteDesktopSecret(state.refreshReference),
  ]);
  await prisma.platformSetting.deleteMany({ where: { key: KEY } });
}
