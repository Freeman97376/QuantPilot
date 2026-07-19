#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  backupMarketDatabaseForVersion,
  initializeDesktopDataDirectory,
} = require('../../electron/desktop-data');

const rootDir = path.resolve(__dirname, '..', '..');
const testDir = fs.mkdtempSync(path.join(rootDir, '.tmp-desktop-upgrade-'));

function assertInsideRoot(target) {
  const relative = path.relative(rootDir, target);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

try {
  const dataPaths = initializeDesktopDataDirectory(testDir);
  const original = Buffer.from('existing-duckdb-fixture');
  fs.writeFileSync(dataPaths.marketDatabasePath, original);

  const backupPath = backupMarketDatabaseForVersion(dataPaths, '2.1.0-alpha.3');
  assert(backupPath, 'first start of a version must create a market database backup');
  assert.deepStrictEqual(fs.readFileSync(backupPath), original);
  assert.deepStrictEqual(fs.readFileSync(dataPaths.marketDatabasePath), original);
  assert.strictEqual(
    backupMarketDatabaseForVersion(dataPaths, '2.1.0-alpha.3'),
    null,
    'the same version must not create duplicate backups'
  );
  assert.strictEqual(
    fs.readdirSync(dataPaths.backupsDir).filter((name) => name.endsWith('.duckdb')).length,
    1
  );
  console.log('[desktop-data] upgrade backup contract passed');
} finally {
  assertInsideRoot(testDir);
  fs.rmSync(testDir, { recursive: true, force: true });
}
