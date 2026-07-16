import { prisma } from '@/lib/db/client';
import { Prisma } from '@/lib/db/types';

export type MinuteDataPolicy = 'unset' | 'enabled' | 'disabled';

export interface DesktopPreferences {
  minuteDataPolicy: MinuteDataPolicy;
  diagnosticsConsent: boolean;
}

const KEY = 'desktop.preferences';
const DEFAULTS: DesktopPreferences = {
  minuteDataPolicy: 'unset',
  diagnosticsConsent: false,
};

function parsePreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULTS;
  const raw = value as Record<string, unknown>;
  const minuteDataPolicy =
    raw.minuteDataPolicy === 'enabled' || raw.minuteDataPolicy === 'disabled'
      ? raw.minuteDataPolicy
      : 'unset';
  return {
    minuteDataPolicy,
    diagnosticsConsent: raw.diagnosticsConsent === true,
  };
}

export async function loadDesktopPreferences(): Promise<DesktopPreferences> {
  const record = await prisma.platformSetting.findUnique({ where: { key: KEY } });
  return parsePreferences(record?.value);
}

export async function updateDesktopPreferences(
  update: Partial<DesktopPreferences>
): Promise<DesktopPreferences> {
  const current = await loadDesktopPreferences();
  const next: DesktopPreferences = {
    minuteDataPolicy: update.minuteDataPolicy ?? current.minuteDataPolicy,
    diagnosticsConsent: update.diagnosticsConsent ?? current.diagnosticsConsent,
  };
  await prisma.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}
