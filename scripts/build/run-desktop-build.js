#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.join(__dirname, '..', '..');
const prismaCli = require.resolve('prisma/build/index.js');
const buildDir = path.join(rootDir, '.desktop-build');
const migrationsDir = path.join(buildDir, 'migrations');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status ?? 'unknown'}`);
  }
  return result.stdout || '';
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('The first desktop release supports Windows x64 only.');
  }
  fs.mkdirSync(migrationsDir, { recursive: true });
  const env = {
    QUANTPILOT_RUNTIME_MODE: 'desktop',
    QUANTPILOT_DEPLOYMENT: 'desktop',
    QUANTPILOT_STANDALONE_BUILD: '1',
    QUANTPILOT_SKIP_ROUTE_TRACING: '0',
    NEXT_PUBLIC_BASE_PATH: '',
    NEXT_PUBLIC_API_BASE: '',
    NEXT_PUBLIC_RUNTIME_MODE: 'desktop',
    DESKTOP_DATABASE_URL: 'file:./prisma/data/desktop-build.db',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  run(process.execPath, [prismaCli, 'generate', '--schema', 'prisma/schema.desktop.prisma'], { env });
  const initialSql = run(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      'prisma/schema.desktop.prisma',
      '--script',
    ],
    { env, capture: true }
  );
  fs.writeFileSync(path.join(migrationsDir, '0001_initial.sql'), initialSql, 'utf8');

  run(process.execPath, [path.join(__dirname, 'run-build.js'), '--standalone'], { env });
  run(process.execPath, [path.join(rootDir, 'scripts', 'desktop', 'stage-standalone.js')], { env });
  run(process.execPath, [path.join(rootDir, 'scripts', 'desktop', 'build-sidecar.js')], { env });

  const electronBuilder = require.resolve('electron-builder/out/cli/cli.js');
  const builderArgs = [
    electronBuilder,
    '--config',
    path.join(rootDir, 'electron-builder.config.js'),
    '--win',
    '--x64',
  ];
  if (process.argv.includes('--publish')) {
    builderArgs.push('--publish', 'always');
  }
  run(process.execPath, builderArgs, { env });

  const packagedDesktopQueryEngine = path.join(
    rootDir,
    'dist',
    'win-unpacked',
    'resources',
    'standalone',
    'node_modules',
    '@quantpilot',
    'prisma-desktop-client',
    'query_engine-windows.dll.node'
  );
  if (!fs.existsSync(packagedDesktopQueryEngine)) {
    throw new Error(`Packaged desktop Prisma query engine is missing: ${packagedDesktopQueryEngine}`);
  }

  const packagedPytz = path.join(
    rootDir,
    'dist',
    'win-unpacked',
    'resources',
    'sidecar',
    '_internal',
    'pytz',
    '__init__.py'
  );
  if (!fs.existsSync(packagedPytz)) {
    throw new Error(`Packaged desktop pytz runtime is missing: ${packagedPytz}`);
  }
}

try {
  main();
} catch (error) {
  console.error('[desktop-build] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
