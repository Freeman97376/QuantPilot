#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const ts = require('typescript');

const root = path.join(__dirname, '..', '..');
const moduleCache = new Map();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadTypeScriptModule(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath).exports;
  const moduleRecord = { exports: {} };
  moduleCache.set(absolutePath, moduleRecord);
  const output = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absolutePath,
  }).outputText;
  const execute = new Function('require', 'module', 'exports', '__filename', '__dirname', output);
  execute(require, moduleRecord, moduleRecord.exports, absolutePath, path.dirname(absolutePath));
  return moduleRecord.exports;
}

const requirements = [
  {
    file: 'src/lib/services/project.ts',
    includes: [
      'export function isSafeProjectId',
      'assertSafeProjectId(input.project_id)',
      'resolveManagedProjectPathForDeletion(',
      'fs.rm(managedProjectPath',
    ],
    excludes: ['fs.rm(project.repoPath'],
  },
  {
    file: 'src/lib/services/file-browser.ts',
    includes: ['fs.realpath(normalizedBase)', 'fs.realpath(resolvedTarget)', 'path.relative('],
  },
  {
    file: 'src/app/api/projects/[project_id]/artifact/route.ts',
    includes: ['isSafeProjectId(project_id)', 'fs.realpath(path.resolve(projectPath))', 'MAX_ARTIFACT_BYTES'],
  },
  {
    file: 'src/lib/services/git.ts',
    includes: ['function redactGitCredentials', "runGit(['push', '-u', remote, branch], repoPath, bearerToken"],
    excludes: ["['push', '--force']"],
  },
  {
    file: 'src/lib/services/git.ts',
    includes: ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'bearerToken'],
  },
  {
    file: 'src/app/api/assets/[project_id]/upload/route.ts',
    includes: ['isSafeProjectId(project_id)', 'validateImageBytes(imageBuffer, file.type)', 'readLimitedFormData(request, MAX_MULTIPART_BYTES)', 'absolute_path: uniqueName'],
  },
  {
    file: 'src/lib/services/github.ts',
    includes: ['bearerToken: token', 'remoteUrl: String(data.clone_url)'],
    excludes: ['authenticatedUrl'],
  },
  {
    file: 'src/app/api/assets/[project_id]/[filename]/route.ts',
    includes: ['resolveSafeAssetFile(', 'fs.realpath(candidatePath)', 'validateImageBytes(fileBuffer)'],
  },
  {
    file: 'src/app/api/assets/[project_id]/logo/route.ts',
    includes: ['isSafeProjectId(project_id)', "validateImageBytes(buffer, 'image/png')"],
  },
  {
    file: 'src/app/api/chat/[project_id]/pause/route.ts',
    includes: ['isSafeProjectId(project_id)'],
  },
  {
    file: 'next.config.js',
    excludes: ['skipRouteOutputTracing'],
  },
  {
    file: 'src/app/api/chat/[project_id]/act/route.ts',
    includes: [
      'resolveSafeAssetPath(',
      'fs.realpath(assetRoot)',
      'validateImageBytes(imageBuffer, mimeTypeCandidate)',
      'MAX_IMAGE_ATTACHMENTS',
      'readLimitedJson(request, MAX_CHAT_BODY_BYTES)',
      'resolveSafeAssetsPath(',
    ],
  },
  {
    file: 'src/proxy.ts',
    includes: [
      "DESKTOP_COOKIE_NAME = 'quantpilot_launch'",
      "process.env.QUANTPILOT_DESKTOP_SMOKE_TEST === '1'",
      "matcher: ['/api/:path*']",
    ],
  },
  {
    file: 'src/pages/api/ws/[projectId].ts',
    includes: ['isAuthorizedDesktopUpgrade(', 'isSafeProjectId(projectId)', 'originUrl.host === host'],
  },
  {
    file: 'src/app/api/projects/[project_id]/retry-initialization/route.ts',
    includes: ['executeChatAction(', 'isSafeProjectId(project_id)', "'http://quantpilot.internal/api/chat/action'"],
    excludes: ['request.url', 'fetch(actUrl'],
  },
  {
    file: 'src/lib/quant/notification-adapters.ts',
    includes: [
      'validateWebhookUrl(',
      "redirect: 'error'",
      "'qyapi.weixin.qq.com'",
      "'open.feishu.cn'",
      "'oapi.dingtalk.com'",
      "'discord.com'",
    ],
  },
  {
    file: 'electron/main.js',
    includes: [
      'sandbox: true',
      'httpOnly: true',
      'setWindowOpenHandler',
      "webContents.on('will-navigate'",
    ],
  },
  {
    file: 'services/market-data/src/quantpilot_market_data/api.py',
    includes: ['lifespan=lifespan', 'bootstrap_operation_lock = asyncio.Lock()'],
    excludes: ['@app.on_event(', 'bootstrap_locks:'],
  },
  {
    file: 'src/lib/quant/skills-admin.ts',
    includes: ['shell: false', "command.toLowerCase() === 'npm'"],
    excludes: ["shell: process.platform === 'win32'"],
  },
  {
    file: 'src/app/api/skills/route.ts',
    includes: ['readLimitedFormData(request, MAX_SKILL_PACKAGE_REQUEST_BYTES)', 'readLimitedJson(request, MAX_SKILL_JSON_REQUEST_BYTES)'],
  },
  {
    file: 'src/app/api/tokens/[...segments]/route.ts',
    excludes: ['getPlainServiceToken'],
  },
  {
    file: 'src/lib/services/env.ts',
    includes: ['assertSafeEnvKey(', 'assertSafeEnvValue('],
  },
  {
    file: 'src/lib/desktop-connection/server-auth.ts',
    includes: ['readBoundedJson(request, MAX_REQUEST_BYTES)', 'MAX_RATE_LIMIT_BUCKETS'],
  },
  {
    file: 'src/lib/services/preview.ts',
    includes: ['normalizeLoopbackPreviewUrl(', 'effectivePort,'],
  },
  {
    file: 'src/lib/services/tokens.ts',
    includes: [
      'token: null',
      'encryptServiceToken(normalizedToken)',
      'ensureEncryptedServerToken(',
      'decryptServiceToken(encryptedRecord.token)',
      'prisma.$transaction(async (transaction)',
      'await transaction.serviceToken.deleteMany({ where: { provider } })',
      'await deleteDesktopSecret(storedToken).catch(() => undefined)',
      'await Promise.allSettled(previous.map((record) => deleteDesktopSecret(record.token)))',
    ],
    excludes: ['if (isDesktopRuntime && previous) await deleteDesktopSecret(previous.token)'],
  },
  {
    file: 'scripts/build/run-server-build.js',
    includes: ["'generate', '--schema', 'prisma/schema.desktop.prisma'"],
  },
];

const failures = [];
for (const requirement of requirements) {
  const source = read(requirement.file);
  for (const expected of requirement.includes || []) {
    if (!source.includes(expected)) {
      failures.push(`${requirement.file}: missing required boundary: ${expected}`);
    }
  }
  for (const forbidden of requirement.excludes || []) {
    if (source.includes(forbidden)) {
      failures.push(`${requirement.file}: forbidden regression detected: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[security-boundaries] Failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const { normalizeLoopbackPreviewUrl } = loadTypeScriptModule('src/lib/security/preview-url.ts');
const previewBounds = { start: 4100, end: 4999 };
assert.equal(normalizeLoopbackPreviewUrl('http://127.0.0.1:4100/ready', previewBounds, 4100), 'http://127.0.0.1:4100/ready');
assert.equal(normalizeLoopbackPreviewUrl('http://localhost:4999', previewBounds), 'http://localhost:4999/');
for (const unsafeUrl of [
  'http://169.254.169.254:4100/latest/meta-data',
  'http://10.0.0.5:4100',
  'https://localhost:4100',
  'http://localhost',
  'http://localhost:4099',
  'http://user:pass@localhost:4100',
]) {
  assert.equal(normalizeLoopbackPreviewUrl(unsafeUrl, previewBounds), null, unsafeUrl);
}
assert.equal(normalizeLoopbackPreviewUrl('http://localhost:4101', previewBounds, 4100), null);

const savedEncryptionKey = process.env.ENCRYPTION_KEY;
try {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  const tokenCrypto = loadTypeScriptModule('src/lib/security/service-token-encryption.ts');
  const encrypted = tokenCrypto.encryptServiceToken('github-secret-contract-value');
  assert.notEqual(encrypted, 'github-secret-contract-value');
  assert.equal(tokenCrypto.decryptServiceToken(encrypted), 'github-secret-contract-value');
  const encryptedParts = encrypted.split(':');
  const tamperedCiphertext = Buffer.from(encryptedParts[3], 'base64url');
  tamperedCiphertext[0] ^= 0x01;
  encryptedParts[3] = tamperedCiphertext.toString('base64url');
  assert.throws(() => tokenCrypto.decryptServiceToken(encryptedParts.join(':')));
} finally {
  if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedEncryptionKey;
}

console.log('[security-boundaries] Project, file, image, Git, webhook, token, preview SSRF, desktop API, Electron, lifecycle, and command boundaries passed.');
