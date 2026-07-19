#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const nextStandalone = path.join(rootDir, '.next', 'standalone');
const stageDir = path.join(rootDir, '.desktop-build', 'standalone');

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required desktop runtime artifact is missing: ${source}`);
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function main() {
  const resolvedBuildRoot = path.resolve(rootDir, '.desktop-build');
  const resolvedStage = path.resolve(stageDir);
  if (!resolvedStage.startsWith(`${resolvedBuildRoot}${path.sep}`)) {
    throw new Error(`Refusing to stage outside .desktop-build: ${resolvedStage}`);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  copyRequired(path.join(nextStandalone, 'server.js'), path.join(stageDir, 'server.js'));
  copyRequired(path.join(nextStandalone, '.next'), path.join(stageDir, '.next'));
  copyRequired(path.join(rootDir, '.next', 'static'), path.join(stageDir, '.next', 'static'));
  copyRequired(path.join(rootDir, 'public'), path.join(stageDir, 'public'));
  copyRequired(
    path.join(rootDir, 'node_modules', '@quantpilot', 'prisma-desktop-client'),
    path.join(stageDir, 'node_modules', '@quantpilot', 'prisma-desktop-client')
  );

  const desktopQueryEngine = path.join(
    stageDir,
    'node_modules',
    '@quantpilot',
    'prisma-desktop-client',
    'query_engine-windows.dll.node'
  );
  if (!fs.existsSync(desktopQueryEngine)) {
    throw new Error(`Desktop Prisma query engine is missing: ${desktopQueryEngine}`);
  }

  for (const relative of ['.claude', 'config']) {
    const source = path.join(rootDir, relative);
    if (fs.existsSync(source)) copyRequired(source, path.join(stageDir, relative));
  }

  const forbidden = fs.readdirSync(stageDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\.env(?:\.|$)/i.test(entry.name));
  if (forbidden.length) {
    throw new Error('Desktop standalone staging contains a forbidden environment file.');
  }
  console.log(`[desktop-stage] Prepared safe runtime at ${path.relative(rootDir, stageDir)}`);
}

try {
  main();
} catch (error) {
  console.error('[desktop-stage] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
