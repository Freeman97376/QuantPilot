#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const targets = [
  path.join(rootDir, 'dist'),
  path.join(rootDir, '.desktop-build'),
];

function assertInsideRoot(target) {
  const relative = path.relative(rootDir, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside the repository: ${target}`);
  }
}

function cleanDesktopArtifacts() {
  for (const target of targets) {
    assertInsideRoot(target);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[desktop-clean] removed ${path.relative(rootDir, target)}`);
  }
}

if (require.main === module) {
  cleanDesktopArtifacts();
}

module.exports = { cleanDesktopArtifacts };
