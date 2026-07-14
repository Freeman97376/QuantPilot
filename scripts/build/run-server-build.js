#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const rootDir = path.join(__dirname, '..', '..');
const configuredEnvFile = process.env.QUANTPILOT_SERVER_ENV_FILE || '.env.production';
const envFile = path.isAbsolute(configuredEnvFile)
  ? configuredEnvFile
  : path.join(rootDir, configuredEnvFile);

if (!fs.existsSync(envFile)) {
  console.error(`[server-build] Missing environment file: ${envFile}`);
  console.error('[server-build] Copy deploy/server/quantpilot.env.example to .env.production first.');
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
for (const [key, value] of Object.entries(parsed)) {
  process.env[key] = value;
}
process.env.NODE_ENV = 'production';
process.env.QUANTPILOT_DEPLOYMENT = 'server';

console.log(
  `[server-build] Building for basePath ${process.env.NEXT_PUBLIC_BASE_PATH || '(root)'} using ${path.relative(rootDir, envFile)}`
);

const result = spawnSync(process.execPath, [path.join(__dirname, 'run-build.js')], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error('[server-build] Failed to start build:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
