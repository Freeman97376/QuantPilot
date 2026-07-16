#!/usr/bin/env node

const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const rootDir = path.join(__dirname, '..', '..');
const serviceDir = path.join(rootDir, 'services', 'market-data');
const uv = os.platform() === 'win32' ? 'uv.exe' : 'uv';

const args = [
  'run',
  '--project', serviceDir,
  '--with', 'pyinstaller>=6.15',
  'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'quantpilot-market-data',
  '--distpath', path.join(serviceDir, 'dist'),
  '--workpath', path.join(rootDir, '.desktop-build', 'pyinstaller-work'),
  '--specpath', path.join(rootDir, '.desktop-build'),
  '--collect-all', 'duckdb',
  path.join(serviceDir, 'sidecar_entry.py'),
];

const result = spawnSync(uv, args, {
  cwd: rootDir,
  env: { ...process.env, PYTHONUTF8: '1' },
  stdio: 'inherit',
  shell: false,
});
if (result.error) {
  console.error('[sidecar-build] Failed to start uv:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
