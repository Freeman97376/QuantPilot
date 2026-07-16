import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../../../package.json';
import { loadDesktopPreferences } from '@/lib/desktop/preferences';
import { getOfficialAccessToken } from '@/lib/desktop/official-connection';
import { diagnosticEventSchema, redactDiagnosticText } from '@/lib/desktop-connection/diagnostics';
import { OFFICIAL_DESKTOP_SERVER_URL } from '@/lib/runtime/mode';

const MAX_EVENTS = 200;
const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;

type DiagnosticEvent = ReturnType<typeof diagnosticEventSchema.parse>;
interface QueueState {
  events: DiagnosticEvent[];
  attempts: number;
  nextAttemptAt: string | null;
}

function queuePath(): string {
  const baseDir = process.env.QUANTPILOT_APP_DATA_DIR?.trim();
  if (!baseDir) throw new Error('Desktop data directory is unavailable.');
  return path.join(baseDir, 'cache', 'diagnostics-queue.json');
}

async function readQueue(): Promise<QueueState> {
  try {
    const parsed = JSON.parse(await fs.readFile(queuePath(), 'utf8')) as QueueState;
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      attempts: Number.isInteger(parsed.attempts) ? parsed.attempts : 0,
      nextAttemptAt: typeof parsed.nextAttemptAt === 'string' ? parsed.nextAttemptAt : null,
    };
  } catch {
    return { events: [], attempts: 0, nextAttemptAt: null };
  }
}

async function writeQueue(queue: QueueState): Promise<void> {
  const target = queuePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(queue), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function clearDiagnosticQueue(): Promise<void> {
  await fs.rm(queuePath(), { force: true });
}

export async function enqueueDiagnostic(input: {
  feature: string;
  errorCode: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
  stack?: string;
  durationMs?: number;
}): Promise<number> {
  const preferences = await loadDesktopPreferences();
  if (!preferences.diagnosticsConsent) {
    await clearDiagnosticQueue();
    return 0;
  }
  const event = diagnosticEventSchema.parse({
    appVersion: packageJson.version,
    windowsVersion: os.release(),
    architecture: 'x64',
    appSchemaVersion: 1,
    marketSchemaVersion: 1,
    installationId: process.env.QUANTPILOT_INSTALLATION_ID,
    feature: input.feature,
    errorCode: input.errorCode,
    severity: input.severity,
    sanitizedStack: redactDiagnosticText(input.stack) || undefined,
    occurredAt: new Date().toISOString(),
    durationMs: input.durationMs,
  });
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
    throw new Error('Diagnostic event exceeds 64KB after redaction.');
  }
  const queue = await readQueue();
  queue.events.push(event);
  queue.events = queue.events.slice(-MAX_EVENTS);
  while (Buffer.byteLength(JSON.stringify(queue), 'utf8') > MAX_QUEUE_BYTES && queue.events.length) {
    queue.events.shift();
  }
  await writeQueue(queue);
  return queue.events.length;
}

export async function flushDiagnosticQueue(): Promise<{ queued: number; uploaded: number }> {
  const preferences = await loadDesktopPreferences();
  if (!preferences.diagnosticsConsent) {
    await clearDiagnosticQueue();
    return { queued: 0, uploaded: 0 };
  }
  const queue = await readQueue();
  if (!queue.events.length) return { queued: 0, uploaded: 0 };
  if (queue.nextAttemptAt && new Date(queue.nextAttemptAt).getTime() > Date.now()) {
    return { queued: queue.events.length, uploaded: 0 };
  }
  const credentials = await getOfficialAccessToken().catch(() => null);
  if (!credentials) return { queued: queue.events.length, uploaded: 0 };
  const batch = queue.events.slice(0, 20);
  try {
    const response = await fetch(`${OFFICIAL_DESKTOP_SERVER_URL}/api/desktop-connection/diagnostics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.token}`,
      },
      body: JSON.stringify({ consent: true, events: batch }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Official server returned ${response.status}.`);
    queue.events.splice(0, batch.length);
    queue.attempts = 0;
    queue.nextAttemptAt = null;
    await writeQueue(queue);
    return { queued: queue.events.length, uploaded: batch.length };
  } catch {
    queue.attempts += 1;
    const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(queue.attempts, 10));
    queue.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    await writeQueue(queue);
    return { queued: queue.events.length, uploaded: 0 };
  }
}

export async function diagnosticQueueStatus() {
  const queue = await readQueue();
  return { queued: queue.events.length, bytes: Buffer.byteLength(JSON.stringify(queue), 'utf8') };
}
