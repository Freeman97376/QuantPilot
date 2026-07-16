#!/usr/bin/env node

process.env.QUANTPILOT_RUNTIME_MODE = 'server';

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const rootDir = path.join(__dirname, '..', '..');
const prisma = new PrismaClient();
const baseUrl = (process.env.QUANTPILOT_PUBLIC_URL || 'https://mantleofintelligence.com/smartstock')
  .replace(/\/+$/, '');
const apiBaseUrl = (
  process.env.QUANTPILOT_INTERNAL_URL ||
  `http://127.0.0.1:${process.env.WEB_PORT || '3000'}${process.env.NEXT_PUBLIC_BASE_PATH || '/smartstock'}`
).replace(/\/+$/, '');
const username = `qp_release_${Date.now()}`;
const firstPassword = `Qp!${crypto.randomBytes(18).toString('base64url')}`;
const secondPassword = `Qp!${crypto.randomBytes(18).toString('base64url')}`;
const installationId = crypto.randomUUID();
let accountId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runAccountCommand(command, password) {
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'scripts', 'admin', 'desktop-accounts.js'), command, username],
    {
      cwd: rootDir,
      env: { ...process.env, QUANTPILOT_DESKTOP_ACCOUNT_PASSWORD: password || '' },
      stdio: 'inherit',
      shell: false,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`desktop account ${command} failed.`);
}

async function request(pathname, options = {}) {
  return fetch(`${apiBaseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function login(password) {
  const response = await request('/api/desktop-connection/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, installationId }),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function cleanup() {
  if (!accountId) return;
  await prisma.$transaction([
    prisma.desktopDiagnosticEvent.deleteMany({ where: { accountId } }),
    prisma.desktopSession.deleteMany({ where: { accountId } }),
    prisma.desktopAccount.delete({ where: { id: accountId } }),
  ]).catch((error) => {
    console.error(`[desktop-connection-smoke] cleanup failed: ${error.message}`);
  });
}

async function main() {
  const protectedPage = await fetch(baseUrl, { redirect: 'manual' });
  assert(protectedPage.status === 401, `Expected Basic Auth 401 for ${baseUrl}; got ${protectedPage.status}.`);

  const protectedApi = await fetch(`${baseUrl}/api/config`, { redirect: 'manual' });
  assert(protectedApi.status === 401, `Expected Basic Auth 401 for /api/config; got ${protectedApi.status}.`);

  const capabilities = await fetch(`${baseUrl}/api/desktop-connection/capabilities`, { redirect: 'manual' });
  assert(capabilities.status === 200, `Capabilities returned ${capabilities.status}.`);

  const oversized = await fetch(`${baseUrl}/api/desktop-connection/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oversized: 'x'.repeat(70 * 1024) }),
  });
  assert(oversized.status === 413, `Expected oversized login 413; got ${oversized.status}.`);

  const invalid = await fetch(`${baseUrl}/api/desktop-connection/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `${username}_missing`, password: firstPassword, installationId }),
  });
  assert(invalid.status === 401, `Expected invalid login 401; got ${invalid.status}.`);

  runAccountCommand('create', firstPassword);
  const account = await prisma.desktopAccount.findUnique({ where: { usernameNormalized: username } });
  assert(account, 'CLI did not create the smoke account.');
  accountId = account.id;

  const firstLogin = await login(firstPassword);
  assert(firstLogin.response.status === 200, `Initial login returned ${firstLogin.response.status}.`);
  assert(firstLogin.body.accessToken && firstLogin.body.refreshToken, 'Initial login did not return both tokens.');

  const refreshed = await request('/api/desktop-connection/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: firstLogin.body.refreshToken, installationId }),
  });
  const refreshedBody = await refreshed.json().catch(() => ({}));
  assert(refreshed.status === 200 && refreshedBody.accessToken, `Refresh returned ${refreshed.status}.`);

  const diagnostic = await request('/api/desktop-connection/diagnostics', {
    method: 'POST',
    headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
    body: JSON.stringify({
      consent: true,
      events: [{
        appVersion: 'server-smoke',
        windowsVersion: 'Windows 11 smoke',
        architecture: 'x64',
        appSchemaVersion: 1,
        marketSchemaVersion: 1,
        installationId,
        feature: 'desktop-connection-smoke',
        errorCode: 'SMOKE_TEST',
        severity: 'info',
        sanitizedStack: 'Bearer secret-smoke-token C:\\Users\\SmokeUser\\private prompt=secret response=secret',
        occurredAt: new Date().toISOString(),
        durationMs: 1,
      }],
    }),
  });
  assert(diagnostic.status === 202, `Diagnostic upload returned ${diagnostic.status}.`);
  const stored = await prisma.desktopDiagnosticEvent.findFirst({
    where: { accountId, errorCode: 'SMOKE_TEST' },
    orderBy: { createdAt: 'desc' },
  });
  assert(stored?.sanitizedStack, 'Diagnostic smoke event was not stored.');
  assert(!stored.sanitizedStack.includes('secret-smoke-token'), 'Bearer token was not redacted.');
  assert(!stored.sanitizedStack.includes('SmokeUser'), 'Windows username/path was not redacted.');
  assert(!stored.sanitizedStack.includes('prompt=secret'), 'Prompt content was not redacted.');
  assert(!stored.sanitizedStack.includes('response=secret'), 'Response content was not redacted.');

  const logout = await request('/api/desktop-connection/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
    body: '{}',
  });
  assert(logout.status === 200, `Logout returned ${logout.status}.`);

  runAccountCommand('reset-password', secondPassword);
  const oldPasswordLogin = await login(firstPassword);
  assert(oldPasswordLogin.response.status === 401, 'Old password remained valid after reset.');
  const secondLogin = await login(secondPassword);
  assert(secondLogin.response.status === 200, `Login after password reset returned ${secondLogin.response.status}.`);

  runAccountCommand('revoke-sessions');
  const revokedMe = await request('/api/desktop-connection/me', {
    headers: { authorization: `Bearer ${secondLogin.body.accessToken}` },
  });
  assert(revokedMe.status === 401, `Revoked session returned ${revokedMe.status} from /me.`);

  runAccountCommand('disable');
  const disabledLogin = await login(secondPassword);
  assert(disabledLogin.response.status === 401, 'Disabled account was able to log in.');
  runAccountCommand('enable');
  const enabledLogin = await login(secondPassword);
  assert(enabledLogin.response.status === 200, 'Re-enabled account could not log in.');
  runAccountCommand('revoke-sessions');

  console.log('[desktop-connection-smoke] Basic Auth, size limit, session lifecycle, and redaction checks passed.');
}

main()
  .catch((error) => {
    console.error(`[desktop-connection-smoke] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
