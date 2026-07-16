const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const { autoUpdater } = require('electron-updater');
const {
  applyDesktopMigrations,
  initializeDesktopDataDirectory,
  sqliteUrl,
} = require('./desktop-data');
const { startSecretBroker } = require('./secret-store');
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow = null;
let nextServerProcess = null;
let sidecarProcess = null;
let secretBroker = null;
let productionUrl = null;
let shuttingDown = false;
let desktopData = null;
const launchToken = crypto.randomBytes(32).toString('base64url');

const rootDir = path.join(__dirname, '..');
const standaloneDir = app.isPackaged
  ? path.join(process.resourcesPath, 'standalone')
  : path.join(rootDir, '.next', 'standalone');
const preloadPath = path.join(__dirname, 'preload.js');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
app.setPath('userData', path.join(localAppData, 'QuantPilot'));

function waitForUrl(targetUrl, timeoutMs = 30_000, intervalMs = 200, headers = {}) {
  const { protocol } = new URL(targetUrl);
  const requester = protocol === 'https:' ? https : http;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = requester
        .get(targetUrl, { headers }, (response) => {
          response.resume();
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
            resolve();
            return;
          }
          if (Date.now() - start >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${targetUrl}`));
          } else {
            setTimeout(poll, intervalMs);
          }
        })
        .on('error', () => {
          if (Date.now() - start >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${targetUrl}`));
          } else {
            setTimeout(poll, intervalMs);
          }
        });

      request.setTimeout(intervalMs, () => request.destroy());
    };

    poll();
  });
}

function checkPortAvailability(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => {
        resolve(false);
      })
      .once('listening', () => {
        tester
          .once('close', () => resolve(true))
          .close();
      })
      .listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort = 3000, maxAttempts = 50) {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1, port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const available = await checkPortAvailability(port);
    if (available) {
      return port;
    }
  }

  throw new Error(
    `Failed to find available port starting at ${startPort}.`
  );
}

function ensureStandaloneArtifacts() {
  const serverPath = path.join(standaloneDir, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      'The Next.js standalone server file is missing. Run `npm run build` and try again.'
    );
  }
  return serverPath;
}

async function startProductionServer() {
  if (productionUrl) {
    return productionUrl;
  }

  const serverPath = ensureStandaloneArtifacts();
  const startPort =
    Number.parseInt(process.env.WEB_PORT || process.env.PORT || '3000', 10) || 3000;
  const port = await findAvailablePort(startPort);
  const url = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: app.isPackaged
      ? [path.join(process.resourcesPath, 'app.asar', 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter)
      : process.env.NODE_PATH,
    QUANTPILOT_RUNTIME_MODE: 'desktop',
    QUANTPILOT_DEPLOYMENT: 'desktop',
    DESKTOP_DATABASE_URL: sqliteUrl(desktopData.appDatabasePath),
    QUANTPILOT_APP_DATA_DIR: desktopData.baseDir,
    QUANTPILOT_WORKSPACES_DIR: desktopData.workspacesDir,
    QUANTPILOT_MARKET_API_URL: process.env.QUANTPILOT_MARKET_API_URL,
    QUANTPILOT_CLICKHOUSE_ENABLED: '0',
    QUANTPILOT_OBSERVABILITY_ENABLED: '0',
    QUANTPILOT_REDIS_CACHE_ENABLED: '0',
    QUANTPILOT_SECRET_BROKER_URL: secretBroker.url,
    QUANTPILOT_LAUNCH_TOKEN: launchToken,
    QUANTPILOT_INSTALLATION_ID: desktopData.installationId,
  };

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: standaloneDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });

  nextServerProcess.on('exit', (code, signal) => {
    if (!shuttingDown && typeof code === 'number' && code !== 0) {
      console.error(`⚠️  Next.js server exited with code ${code} (signal: ${signal ?? 'n/a'}).`);
    }
    nextServerProcess = null;
  });

  await waitForUrl(url).catch((error) => {
    console.error('❌ The Next.js production server failed to start.');
    throw error;
  });

  productionUrl = url;
  return productionUrl;
}

function sidecarExecutable() {
  if (isDev) {
    return {
      command: process.platform === 'win32' ? 'uv.exe' : 'uv',
      args: ['run', '--project', path.join(rootDir, 'services', 'market-data'), 'quantpilot-market-api'],
      cwd: rootDir,
    };
  }
  const executable = process.platform === 'win32'
    ? 'quantpilot-market-data.exe'
    : 'quantpilot-market-data';
  return {
    command: path.join(process.resourcesPath, 'sidecar', executable),
    args: [],
    cwd: path.join(process.resourcesPath, 'sidecar'),
  };
}

async function startMarketSidecar() {
  const port = isDev ? 8000 : await findAvailablePort(8100);
  if (isDev && !(await checkPortAvailability(port))) {
    throw new Error('Desktop development requires local port 8000 for the market-data sidecar.');
  }
  const target = sidecarExecutable();
  const healthUrl = `http://127.0.0.1:${port}/health`;
  sidecarProcess = spawn(target.command, target.args, {
    cwd: target.cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      QUANTPILOT_RUNTIME_MODE: 'desktop',
      QUANTPILOT_MARKET_HOST: '127.0.0.1',
      QUANTPILOT_MARKET_PORT: String(port),
      QUANTPILOT_STARTUP_TOKEN: launchToken,
      QUANTPILOT_MARKET_DB_PATH: desktopData.marketDatabasePath,
      QUANTPILOT_MARKET_CACHE_DIR: desktopData.cacheDir,
      QUANTPILOT_APP_DATA_DIR: desktopData.baseDir,
      QUANTPILOT_CLICKHOUSE_ENABLED: '0',
      QUANTPILOT_OBSERVABILITY_ENABLED: '0',
      QUANTPILOT_REDIS_CACHE_ENABLED: '0',
    },
  });
  sidecarProcess.stdout.on('data', (chunk) => process.stdout.write(`[market-data] ${chunk}`));
  sidecarProcess.stderr.on('data', (chunk) => process.stderr.write(`[market-data] ${chunk}`));
  sidecarProcess.on('exit', (code, signal) => {
    sidecarProcess = null;
    if (!shuttingDown) {
      const message = `The local market-data service stopped (code ${code ?? 'n/a'}, signal ${signal ?? 'n/a'}).`;
      console.error(message);
      dialog.showErrorBox('QuantPilot local service stopped', `${message}\n\nSee ${desktopData.logsDir} for diagnostics.`);
    }
  });
  sidecarProcess.once('error', (error) => {
    console.error('Failed to start market-data sidecar:', error);
  });
  await waitForUrl(healthUrl, 45_000, 250, {
    'X-QuantPilot-Startup-Token': launchToken,
  });
  process.env.QUANTPILOT_MARKET_API_URL = `http://127.0.0.1:${port}`;
}

function stopProductionServer() {
  if (nextServerProcess && !nextServerProcess.killed) {
    nextServerProcess.kill('SIGTERM');
    nextServerProcess = null;
  }
  productionUrl = null;
}

function stopSidecar() {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill('SIGTERM');
  }
  sidecarProcess = null;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#111827',
    titleBarStyle: os.platform() === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const startUrl = isDev
    ? process.env.ELECTRON_START_URL || `http://localhost:${process.env.WEB_PORT || '3000'}`
    : await startProductionServer();

  let loadError = null;
  try {
    await mainWindow.loadURL(startUrl);
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Failed to load start URL in Electron window:', loadError);
  }

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('🪟 Main window ready-to-show – displaying window.');
      mainWindow.show();
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('🪟 Main window did-finish-load – displaying window.');
      mainWindow.show();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`❌ Failed to load ${validatedURL || startUrl}: [${errorCode}] ${errorDescription}`);
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('🪟 Showing fallback window after load failure.');
      mainWindow.show();
    }
  });

  if (loadError && mainWindow) {
    console.log('🪟 Showing window despite load error.');
    mainWindow.show();
  }

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.log('🪟 Timed show fallback – displaying window.');
      mainWindow.show();
    }
  }, 1500);

  if (isDev && process.env.ELECTRON_DEBUG_TOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('ping', async () => 'pong');
  ipcMain.handle('desktop-runtime-info', async () => ({
    mode: 'desktop',
    version: app.getVersion(),
    installationId: desktopData?.installationId || null,
    officialServerUrl: 'https://mantleofintelligence.com/smartstock',
  }));
}

function setupSingleInstanceLock() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  return true;
}

app.disableHardwareAcceleration();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  shuttingDown = true;
  stopProductionServer();
  stopSidecar();
  secretBroker?.server.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((error) => {
      console.error('❌ Failed to recreate the main window.');
      console.error(error instanceof Error ? error.stack || error.message : error);
    });
  }
});

if (setupSingleInstanceLock()) {
  app
    .whenReady()
    .then(async () => {
      desktopData = initializeDesktopDataDirectory(app.getPath('userData'));
      if (!isDev) {
        applyDesktopMigrations(
          desktopData,
          path.join(process.resourcesPath, 'desktop-migrations')
        );
      }
      secretBroker = await startSecretBroker({
        baseDir: desktopData.baseDir,
        launchToken,
      });
      registerIpcHandlers();
      if (!process.env.QUANTPILOT_MARKET_API_URL) {
        await startMarketSidecar();
      }
      await createMainWindow();
      if (!isDev) {
        autoUpdater.checkForUpdatesAndNotify().catch((error) => {
          console.warn('Automatic update check failed:', error instanceof Error ? error.message : error);
        });
      }
    })
    .catch((error) => {
      console.error('❌ An error occurred while initializing the Electron app.');
      console.error(error instanceof Error ? error.stack || error.message : error);
      app.quit();
    });
}
