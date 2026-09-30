#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.join(__dirname, '..', '..');
const marketDataDir = path.join(rootDir, 'services', 'market-data');
const uv = process.platform === 'win32' ? 'uv.exe' : 'uv';
const pytestRoot = path.join(marketDataDir, '.test-tmp');
const pytestBase = path.join(pytestRoot, `release-${process.pid}-${Date.now()}`);
fs.mkdirSync(pytestRoot, { recursive: true });
process.on('exit', () => {
  const relative = path.relative(marketDataDir, pytestBase);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    fs.rmSync(pytestBase, { recursive: true, force: true });
    if (fs.existsSync(pytestRoot) && fs.readdirSync(pytestRoot).length === 0) {
      fs.rmdirSync(pytestRoot);
    }
  }
});
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('[release-check] npm_execpath is missing. Run this check through `npm run release:check`.');
  process.exit(1);
}

function npmCheck(name, args) {
  return { name, command: process.execPath, args: [npmCli, ...args] };
}

const checks = [
  npmCheck('generate server Prisma client', ['run', 'prisma:generate:server']),
  npmCheck('full dependency audit', ['audit', '--audit-level=high']),
  npmCheck('production dependency audit', ['audit', '--omit=dev', '--audit-level=moderate']),
  npmCheck('eslint', ['run', 'lint']),
  npmCheck('type check', ['run', 'type-check']),
  npmCheck('skill package integrity', ['run', 'check:skills']),
  npmCheck('backend architecture', ['run', 'check:backend-architecture']),
  npmCheck('module boundaries', ['run', 'check:module-boundaries']),
  npmCheck('service catalog', ['run', 'check:service-catalog']),
  npmCheck('smart strategy contract', ['run', 'check:smart-strategy']),
  npmCheck('security boundaries', ['run', 'check:security-boundaries']),
  npmCheck('desktop data upgrade contract', ['run', 'check:desktop-data']),
  npmCheck('quant guardrails', ['run', 'check:quant-guardrails']),
  npmCheck('benchmark coverage', ['run', 'check:benchmark-coverage']),
  { name: 'market-data lint', command: uv, args: ['run', 'ruff', 'check', '.'], cwd: marketDataDir },
  {
    name: 'market-data tests',
    command: uv,
    args: ['run', 'pytest', '-q', '-p', 'no:cacheprovider', '--basetemp', pytestBase],
    cwd: marketDataDir,
  },
];

if (process.env.QUANTPILOT_REQUIRE_DOCKER_CHECK === '1') {
  checks.push({ name: 'Docker Compose config', command: 'docker', args: ['compose', 'config', '--quiet'] });
}

for (const check of checks) {
  console.log(`\n[release-check] ${check.name}`);
  const result = spawnSync(check.command, check.args, {
    cwd: check.cwd || rootDir,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`[release-check] Failed to start ${check.command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[release-check] ${check.name} failed with exit code ${result.status}.`);
    process.exit(result.status || 1);
  }
}

console.log('\n[release-check] All release checks passed.');
