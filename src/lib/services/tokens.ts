import { prisma } from '@/lib/db/client';
import { isDesktopRuntime } from '@/lib/runtime/mode';
import {
  deleteDesktopSecret,
  getDesktopSecret,
  putDesktopSecret,
} from '@/lib/desktop/secret-broker';
import {
  decryptServiceToken,
  encryptServiceToken,
  isEncryptedServiceToken,
} from '@/lib/security/service-token-encryption';

const SUPPORTED_PROVIDERS = ['github', 'supabase', 'vercel', 'deepseek'] as const;
export type ServiceProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface ServiceTokenRecord {
  id: string;
  provider: ServiceProvider;
  name: string;
  token: string | null;
  created_at: string;
  last_used: string | null;
}

const MAX_SERVICE_TOKEN_LENGTH = 16 * 1024;
const MAX_SERVICE_TOKEN_NAME_LENGTH = 128;

function assertProvider(provider: string): asserts provider is ServiceProvider {
  if (!SUPPORTED_PROVIDERS.includes(provider as ServiceProvider)) {
    throw new Error('Invalid provider');
  }
}

function toResponse(model: {
  id: string;
  provider: string;
  name: string;
  token: string;
  createdAt: Date;
  lastUsed: Date | null;
}): ServiceTokenRecord {
  return {
    id: model.id,
    provider: model.provider as ServiceProvider,
    name: model.name,
    token: null,
    created_at: model.createdAt.toISOString(),
    last_used: model.lastUsed ? model.lastUsed.toISOString() : null,
  };
}

async function ensureEncryptedServerToken<T extends { id: string; token: string }>(
  record: T,
): Promise<T> {
  if (isDesktopRuntime || isEncryptedServiceToken(record.token)) return record;
  const encryptedToken = encryptServiceToken(record.token);
  await prisma.serviceToken.update({
    where: { id: record.id },
    data: { token: encryptedToken },
  });
  return { ...record, token: encryptedToken };
}

export async function createServiceToken(
  provider: string,
  token: string,
  name: string,
): Promise<ServiceTokenRecord> {
  assertProvider(provider);

  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new Error('Token cannot be empty');
  }
  if (normalizedToken.length > MAX_SERVICE_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalizedToken)) {
    throw new Error('Token must be a single-line value no longer than 16384 characters');
  }
  const normalizedName = name.trim();
  if (normalizedName.length > MAX_SERVICE_TOKEN_NAME_LENGTH || /[\r\n\u0000]/u.test(normalizedName)) {
    throw new Error('Token name must be a single-line value no longer than 128 characters');
  }

  const previous = isDesktopRuntime
    ? await prisma.serviceToken.findMany({ where: { provider } })
    : [];
  const storedToken = isDesktopRuntime
    ? await putDesktopSecret(normalizedToken)
    : encryptServiceToken(normalizedToken);

  let stored;
  try {
    stored = await prisma.$transaction(async (transaction) => {
      await transaction.serviceToken.deleteMany({ where: { provider } });
      return transaction.serviceToken.create({
        data: {
          provider,
          name: normalizedName || `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Token`,
          token: storedToken,
        },
      });
    });
  } catch (error) {
    if (isDesktopRuntime) {
      await deleteDesktopSecret(storedToken).catch(() => undefined);
    }
    throw error;
  }

  if (isDesktopRuntime) {
    await Promise.allSettled(previous.map((record) => deleteDesktopSecret(record.token)));
  }

  return toResponse(stored);
}

export async function getServiceToken(provider: string): Promise<ServiceTokenRecord | null> {
  assertProvider(provider);

  const record = await prisma.serviceToken.findFirst({
    where: { provider },
    orderBy: { createdAt: 'desc' },
  });

  return record ? toResponse(await ensureEncryptedServerToken(record)) : null;
}

export async function deleteServiceToken(tokenId: string): Promise<boolean> {
  try {
    const record = await prisma.serviceToken.findUnique({ where: { id: tokenId } });
    if (!record) return false;
    await prisma.serviceToken.delete({
      where: { id: tokenId },
    });
    if (isDesktopRuntime) {
      await deleteDesktopSecret(record.token).catch(() => undefined);
    }
    return true;
  } catch (error) {
    return false;
  }
}

export async function getPlainServiceToken(provider: string): Promise<string | null> {
  assertProvider(provider);

  const record = await prisma.serviceToken.findFirst({
    where: { provider },
  });

  if (!record) {
    return null;
  }

  if (isDesktopRuntime) return getDesktopSecret(record.token);
  const encryptedRecord = await ensureEncryptedServerToken(record);
  return decryptServiceToken(encryptedRecord.token);
}

export async function touchServiceToken(provider: string): Promise<void> {
  assertProvider(provider);

  await prisma.serviceToken.updateMany({
    where: { provider },
    data: { lastUsed: new Date() },
  });
}
