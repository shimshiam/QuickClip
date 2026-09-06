'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

// Disable GPU acceleration to prevent renderer crashes
app.disableHardwareAcceleration();

// ── Internal modules ────────────────────────────────────────────────────────────
const { createTray, updateTooltip, showBalloon, onPauseToggle } = require('./tray');
const {
  startMonitoring,
  stopMonitoring,
  getHistory,
  clearHistory,
  onClipboardChange,
  writeToClipboard,
  configure,
  getImagePath,
  copyHistoryItem,
  trimHistory,
} = require('./clipboard-monitor');
const {
  createServer,
  broadcastClipboard,
  broadcastFileAvailable,
  getConnectedDevices,
  onDeviceConnect,
  onDeviceDisconnect,
  onFileReceived,
  broadcastSettings,
  broadcastRaw,
} = require('./server');
const { generateCertificates } = require('./certificates');
const {
  getLocalIP,
  generateQRCode,
  generatePairingToken,
  startMDNS,
  stopMDNS,
} = require('./network');
const { createFileManager } = require('./file-manager');
const { createPolicy, validateSettings } = require('./settings');
const { migrateData, atomicJSON } = require('./storage');

// ── Constants ───────────────────────────────────────────────────────────────────
const LEGACY_DATA_DIR = path.join(__dirname, '..', '..', 'data');
let DATA_DIR;
let CONFIG_PATH;
const DEFAULT_PORT = 8443;
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');

// ── State ───────────────────────────────────────────────────────────────────────
let mainWindow = null;
let config = null;
let serverInfo = { ip: '127.0.0.1', port: DEFAULT_PORT, token: '' };
let fileManager = null;
let syncPolicy;
let runningServer;

// ── Config persistence ──────────────────────────────────────────────────────────

function loadConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const loaded = JSON.parse(raw);
      loaded.settings = validateSettings(loaded.settings);
      if (typeof loaded.token !== 'string' || !loaded.token) throw new Error('Missing pairing token');
      return loaded;
    }
  } catch (err) {
    console.error('[Main] Failed to load config:', err.message);
    throw err;
  }

  // First-run defaults
  const defaults = {
    token: generatePairingToken(),
    port: DEFAULT_PORT,
    settings: {
      syncText: true,
      syncImages: true,
      syncFiles: true,
      maxHistory: 50,
      autoStart: false,
    },
  };
  saveConfig(defaults);
  return defaults;
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicJSON(CONFIG_PATH, cfg);
  } catch (err) {
    console.error('[Main] Failed to save config:', err.message);
    throw err;
  }
}

// ── Single instance lock ────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  console.log('[Main] Another instance is running — quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Create the main window ──────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 740,
    minWidth: 480,
    minHeight: 600,
    resizable: true,
    frame: true,
    transparent: false,
    show: false,
    title: 'QuickClip',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.jpg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Window] Failed to load:', code, desc);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Window] Content loaded successfully');
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Window] Renderer process gone:', details.reason);
  });

  // Close to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('ready-to-show', () => {
    console.log('[Window] ready-to-show fired — displaying window');
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
    }
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────────

function registerIPCHandlers() {
  ipcMain.handle('copy-history-item', (_event, id) => copyHistoryItem(id));
  ipcMain.handle('get-qr-code', async () => {
    try {
      const url = `https://${serverInfo.ip}:${serverInfo.port}`;
      return await generateQRCode(url, serverInfo.token);
    } catch (err) {
      console.error('[IPC] get-qr-code error:', err.message);
      return '';
    }
  });

  ipcMain.handle('get-status', () => {
    const devices = getConnectedDevices();
    return {
      connected: devices.length > 0,
      connectedDevices: devices.length,
      deviceCount: devices.length,
      ip: serverInfo.ip,
      localIP: serverInfo.ip,
      port: serverInfo.port,
      serverUrl: `https://${serverInfo.ip}:${serverInfo.port}`,
    };
  });

  ipcMain.handle('get-history', () => {
    try {
      return getHistory();
    } catch (err) {
      console.error('[IPC] get-history error:', err.message);
      return [];
    }
  });

  ipcMain.handle('clear-history', () => {
    try {
      clearHistory();
      broadcastRaw(JSON.stringify({ type: 'history-changed' }));
      return true;
    } catch (err) {
      console.error('[IPC] clear-history error:', err.message);
      return false;
    }
  });

  ipcMain.handle('get-settings', () => {
    return config.settings || {};
  });

  ipcMain.handle('update-settings', (_event, settings) => {
    try {
      const validated = validateSettings(settings, config.settings);
      const nextConfig = { ...config, settings: validated };
      saveConfig(nextConfig);
      config = nextConfig;
      syncPolicy.update(validated);
      trimHistory();
      broadcastSettings();
      broadcastRaw(JSON.stringify({ type: 'history-changed' }));
      return true;
    } catch (err) {
      console.error('[IPC] update-settings error:', err.message);
      return false;
    }
  });

  ipcMain.handle('get-files', () => {
    try {
      return fileManager ? fileManager.listFiles() : [];
    } catch (err) {
      console.error('[IPC] get-files error:', err.message);
      return [];
    }
  });

  ipcMain.handle('open-file', async (_event, filePathOrId) => {
    try {
      if (fileManager) {
        const allFiles = fileManager.listFiles();
        const found = allFiles.find(f => f.id === filePathOrId || f.path === filePathOrId);
        if (found) {
          await fileManager.openFile(found.id);
          return true;
        }
      }
      console.warn('[IPC] open-file rejected unauthorized path or unknown file:', filePathOrId);
      return false;
    } catch (err) {
      console.error('[IPC] open-file error:', err.message);
      return false;
    }
  });

  ipcMain.handle('get-server-info', () => {
    return { ...serverInfo };
  });

  ipcMain.handle('show-in-explorer', (_event, filePathOrId) => {
    try {
      if (fileManager) {
        const allFiles = fileManager.listFiles();
        const found = allFiles.find(f => f.id === filePathOrId || f.path === filePathOrId);
        if (found) {
          fileManager.revealFile(found.id);
          return true;
        }
      }
      console.warn('[IPC] show-in-explorer rejected unauthorized path:', filePathOrId);
      return false;
    } catch (err) {
      console.error('[IPC] show-in-explorer error:', err.message);
      return false;
    }
  });

  ipcMain.handle('download-ca-cert', async () => {
    try {
      const caPath = path.join(DATA_DIR, 'certs', 'ca.crt');
      if (!fs.existsSync(caPath)) {
        console.error('[IPC] CA cert not found at:', caPath);
        return false;
      }
      const { dialog } = require('electron');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save QuickClip CA Certificate',
        defaultPath: path.join(app.getPath('downloads'), 'QuickClip-CA.crt'),
        filters: [
          { name: 'Certificates', extensions: ['crt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return false;
      fs.copyFileSync(caPath, result.filePath);
      shell.showItemInFolder(result.filePath);
      return true;
    } catch (err) {
      console.error('[IPC] download-ca-cert error:', err.message);
      return false;
    }
  });

  ipcMain.handle('select-and-send-files', async () => {
    syncPolicy.assert('file');
    try {
      if (!fileManager) return [];
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Files to Share with Mobile Devices',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return [];
      }
      syncPolicy.assert('file');
      const sentFiles = [];
      for (const filePath of result.filePaths) {
        try {
          const entry = fileManager.saveDesktopFile(filePath);
          sentFiles.push(entry);
          broadcastFileAvailable(entry);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-received', entry);
          }
        } catch (fileErr) {
          console.error('[IPC] Failed to save/send file:', filePath, fileErr.message);
        }
      }
      if (sentFiles.length > 0) {
        showBalloon('QuickClip', `Shared ${sentFiles.length} file(s) with mobile devices`);
      }
      return sentFiles;
    } catch (err) {
      console.error('[IPC] select-and-send-files error:', err.message);
      return [];
    }
  });
}

// ── Event forwarding (main → renderer) ──────────────────────────────────────────

function setupEventForwarding() {
  // Clipboard changes (local) → renderer + broadcast to devices
  onClipboardChange((item) => {
    // Forward to renderer UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-change', item);
    }

    // Broadcast to connected WebSocket clients (only local changes)
    if (item.source === 'local') {
      broadcastClipboard(item);
    }
  });

  // Device connect/disconnect → renderer + tray tooltip
  onDeviceConnect((device) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('device-connect', device);
    }
    const count = getConnectedDevices().length;
    updateTooltip(count > 0 ? `QuickClip - ${count} device(s) connected` : 'QuickClip - No devices');
    showBalloon('QuickClip', `Device connected (${device.address})`);
  });

  onDeviceDisconnect((device) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('device-disconnect', device);
    }
    const count = getConnectedDevices().length;
    updateTooltip(count > 0 ? `QuickClip - ${count} device(s) connected` : 'QuickClip - No devices');
  });

  // File received from device → renderer + balloon
  onFileReceived((fileEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-received', fileEntry);
    }
    showBalloon('QuickClip', `File received: ${fileEntry.name}`);
  });

  // Pause / Resume sync from tray
  onPauseToggle((paused) => {
    syncPolicy.pause(paused);
    broadcastSettings();
    if (paused) {
      stopMonitoring();
      console.log('[Main] Sync paused by user');
    } else {
      startMonitoring();
      console.log('[Main] Sync resumed by user');
    }
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────────

app.on('ready', async () => {
  if (!gotLock) return;
  try {
    console.log('[Main] App ready — initializing…');

    // 1. Load / create config
    DATA_DIR = migrateData(LEGACY_DATA_DIR, path.join(app.getPath('userData'), 'runtime'));
    CONFIG_PATH = path.join(DATA_DIR, 'config.json');
    config = loadConfig();
    syncPolicy = createPolicy(config.settings);
    configure({ dataDir: DATA_DIR, syncPolicy });
    const localIP = getLocalIP();
    const port = config.port || DEFAULT_PORT;
    serverInfo = { ip: localIP, port, token: config.token };

    // 2. Generate TLS certificates
    const certData = await generateCertificates(DATA_DIR, localIP);

    // 3. Create file manager
    fileManager = createFileManager(DATA_DIR);

    // 4. Start HTTPS + WS server
    runningServer = createServer(certData, {
      port,
      token: config.token,
      dataDir: DATA_DIR,
      fileManager,
      getHistoryFn: getHistory,
      writeToClipboardFn: writeToClipboard,
      getImagePathFn: getImagePath,
      policy: syncPolicy,
      hostnames: [localIP, '127.0.0.1', 'localhost'],
    });
    await new Promise((resolve, reject) => {
      runningServer.httpsServer.once('listening', resolve);
      runningServer.httpsServer.once('error', reject);
    });

    // 5. Start clipboard monitoring
    startMonitoring();

    // 6. Create the hidden main window
    createMainWindow();

    // 7. Register IPC handlers
    registerIPCHandlers();

    // 8. Wire up event forwarding
    setupEventForwarding();

    // 9. Create system tray
    createTray(mainWindow, ICON_PATH);

    // 10. Advertise via mDNS
    startMDNS(port);

    console.log(`[Main] QuickClip running at https://${localIP}:${port}`);
  } catch (err) {
    console.error('[Main] Fatal initialisation error:', err);
    dialog.showErrorBox('QuickClip could not start', `${err.message}\nYour original data has been preserved.`);
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuiting = true;
  stopMonitoring();
  clearHistory();
  if (runningServer) {
    for (const client of runningServer.wss.clients) client.terminate();
    runningServer.wss.close();
    runningServer.httpsServer.close();
  }
  stopMDNS();
});

app.on('window-all-closed', () => {
  // On Windows, keep the app running in the tray
  // (app.quit() is NOT called here on purpose)
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});
