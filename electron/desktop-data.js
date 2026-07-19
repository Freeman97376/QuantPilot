const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIRECTORIES = ['cache', 'workspaces', 'backups', 'logs'];

function initializeDesktopDataDirectory(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const directory of DIRECTORIES) {
    fs.mkdirSync(path.join(baseDir, directory), { recursive: true });
  }

  const installationPath = path.join(baseDir, 'installation-id');
  let installationId = '';
  try {
    installationId = fs.readFileSync(installationPath, 'utf8').trim();
  } catch {
    installationId = crypto.randomUUID();
    fs.writeFileSync(installationPath, installationId, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    baseDir,
    appDatabasePath: path.join(baseDir, 'app.db'),
    marketDatabasePath: path.join(baseDir, 'market.duckdb'),
    cacheDir: path.join(baseDir, 'cache'),
    workspacesDir: path.join(baseDir, 'workspaces'),
    backupsDir: path.join(baseDir, 'backups'),
    logsDir: path.join(baseDir, 'logs'),
    installationId,
  };
}

function sqliteUrl(filePath) {
  return `file:${filePath.replace(/\\/g, '/')}`;
}

function backupDatabase(dataPaths) {
  if (!fs.existsSync(dataPaths.appDatabasePath)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataPaths.backupsDir, `app-${stamp}.db`);
  fs.copyFileSync(dataPaths.appDatabasePath, backupPath);
  return backupPath;
}

function backupMarketDatabaseForVersion(dataPaths, version) {
  if (!fs.existsSync(dataPaths.marketDatabasePath)) {
    return null;
  }
  const safeVersion = String(version || 'unknown').replace(/[^a-z0-9._-]/gi, '-');
  const markerPath = path.join(dataPaths.baseDir, `.market-backup-${safeVersion}.json`);
  if (fs.existsSync(markerPath)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataPaths.backupsDir, `market-${safeVersion}-${stamp}.duckdb`);
  const backupTempPath = `${backupPath}.tmp`;
  const markerTempPath = `${markerPath}.tmp`;
  try {
    fs.copyFileSync(dataPaths.marketDatabasePath, backupTempPath);
    fs.renameSync(backupTempPath, backupPath);
    fs.writeFileSync(
      markerTempPath,
      JSON.stringify({ version: safeVersion, backupPath, createdAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    fs.renameSync(markerTempPath, markerPath);
  } catch (error) {
    if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath);
    if (fs.existsSync(markerTempPath)) fs.unlinkSync(markerTempPath);
    throw error;
  }
  return backupPath;
}

function applyDesktopMigrations(dataPaths, migrationsDir) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Desktop migrations are missing: ${migrationsDir}`);
  }

  // Electron 42 embeds a Node runtime with node:sqlite. Keeping migration
  // execution in the main process avoids shipping the Prisma CLI to users.
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const backupPath = backupDatabase(dataPaths);
  const database = new DatabaseSync(dataPaths.appDatabasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    database.exec(
      'CREATE TABLE IF NOT EXISTS _quantpilot_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
    );
    const appliedRows = database.prepare('SELECT name FROM _quantpilot_migrations').all();
    const applied = new Set(appliedRows.map((row) => row.name));
    const migrations = fs.readdirSync(migrationsDir)
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort();

    for (const name of migrations) {
      if (applied.has(name)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(sql);
        database.prepare(
          'INSERT INTO _quantpilot_migrations (name, applied_at) VALUES (?, ?)'
        ).run(name, new Date().toISOString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    database.close();
    if (backupPath) {
      fs.copyFileSync(backupPath, dataPaths.appDatabasePath);
    }
    throw new Error(
      `Desktop database migration failed. The application database was restored from backup. ${error instanceof Error ? error.message : error}`
    );
  }
  database.close();
}

module.exports = {
  applyDesktopMigrations,
  backupMarketDatabaseForVersion,
  initializeDesktopDataDirectory,
  sqliteUrl,
};
