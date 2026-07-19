import type { PrismaClient as ServerPrismaClient } from '@prisma/client';
import { getRuntimeMode } from '@/lib/runtime/mode';

// Prisma Client singleton pattern for Next.js
// Prevents multiple instances in development (hot reload)

type PrismaClientConstructor = new (
  options?: ConstructorParameters<typeof ServerPrismaClient>[0]
) => ServerPrismaClient;

function loadPrismaClient(): PrismaClientConstructor {
  if (getRuntimeMode() === 'desktop') {
    // Kept behind the database boundary so business modules never import a
    // build-specific generated client.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@quantpilot/prisma-desktop-client').PrismaClient as PrismaClientConstructor;
  }
  // Keep both generated clients behind the runtime boundary. A top-level
  // @prisma/client import executes the server client before desktop mode can
  // select its SQLite client in the packaged application.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@prisma/client').PrismaClient as PrismaClientConstructor;
}

const RuntimePrismaClient = loadPrismaClient();
const globalForPrisma = global as unknown as { prisma?: ServerPrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new RuntimePrismaClient({
    log:
      process.env.NODE_ENV === 'development' && process.env.PRISMA_QUERY_LOG === '1'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
