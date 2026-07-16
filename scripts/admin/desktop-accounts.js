#!/usr/bin/env node

process.env.QUANTPILOT_RUNTIME_MODE = 'server';

const readline = require('readline');
const { PrismaClient } = require('@prisma/client');
const { Algorithm, hash } = require('@node-rs/argon2');

const prisma = new PrismaClient();

function normalizeUsername(value) {
  const username = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Username must be 3-64 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  return username;
}

async function readPassword() {
  if (process.env.QUANTPILOT_DESKTOP_ACCOUNT_PASSWORD) {
    return process.env.QUANTPILOT_DESKTOP_ACCOUNT_PASSWORD;
  }
  return new Promise((resolve) => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    terminal._writeToOutput = function writeMuted(text) {
      if (!this.muted) this.output.write(text);
    };
    terminal.question('Password (12-128 characters): ', (answer) => {
      terminal.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    terminal.muted = true;
  });
}

async function passwordHash() {
  const password = await readPassword();
  if (password.length < 12 || password.length > 128) {
    throw new Error('Password must contain 12-128 characters.');
  }
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

async function main() {
  const [command, rawUsername] = process.argv.slice(2);
  if (command === 'list') {
    const accounts = await prisma.desktopAccount.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        usernameNormalized: true,
        status: true,
        failedLoginCount: true,
        lockedUntil: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    console.table(accounts);
    return;
  }
  if (command === 'cleanup-diagnostics') {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await prisma.desktopDiagnosticEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    console.log(`Deleted ${result.count} diagnostic events older than 30 days.`);
    return;
  }
  const usernameNormalized = normalizeUsername(rawUsername);
  const account = await prisma.desktopAccount.findUnique({ where: { usernameNormalized } });

  if (command === 'create') {
    if (account) throw new Error('Account already exists.');
    await prisma.desktopAccount.create({
      data: { usernameNormalized, passwordHash: await passwordHash() },
    });
    console.log(`Created desktop account: ${usernameNormalized}`);
    return;
  }
  if (!account) throw new Error('Account does not exist.');

  if (command === 'enable') {
    await prisma.desktopAccount.update({
      where: { id: account.id },
      data: { status: 'active', failedLoginCount: 0, lockedUntil: null },
    });
    console.log(`Enabled desktop account: ${usernameNormalized}`);
    return;
  }
  if (command === 'disable') {
    await prisma.$transaction(async (tx) => {
      await tx.desktopAccount.update({
        where: { id: account.id },
        data: { status: 'disabled', tokenVersion: { increment: 1 } },
      });
      await tx.desktopSession.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    console.log(`Disabled desktop account and revoked sessions: ${usernameNormalized}`);
    return;
  }
  if (command === 'reset-password') {
    const nextHash = await passwordHash();
    await prisma.$transaction(async (tx) => {
      await tx.desktopAccount.update({
        where: { id: account.id },
        data: {
          passwordHash: nextHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.desktopSession.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    console.log(`Reset password and revoked sessions: ${usernameNormalized}`);
    return;
  }
  if (command === 'revoke-sessions') {
    await prisma.$transaction([
      prisma.desktopAccount.update({
        where: { id: account.id },
        data: { tokenVersion: { increment: 1 } },
      }),
      prisma.desktopSession.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    console.log(`Revoked sessions: ${usernameNormalized}`);
    return;
  }
  throw new Error(
    'Usage: npm run desktop:accounts -- <create|list|disable|enable|reset-password|revoke-sessions|cleanup-diagnostics> [username]'
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
