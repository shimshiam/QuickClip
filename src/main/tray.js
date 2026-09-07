'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');

// ── Module state ────────────────────────────────────────────────────────────────
let tray = null;
let isPaused = false;
let pauseToggleCallbacks = [];
let networkControls = null;

// ── createTray ──────────────────────────────────────────────────────────────────
/**
 * Creates the system-tray icon, context menu, and click behaviour.
 *
 * @param {Electron.BrowserWindow} mainWindow
 * @param {string} iconPath – Path to the tray icon image (e.g. assets/tray-icon.jpg)
 * @returns {Electron.Tray}
 */
function createTray(mainWindow, iconPath, network = null) {
  networkControls = network;
  try {
    let icon;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        throw new Error('Icon file is empty or not found');
      }
    } catch (_err) {
      // Fallback: create a tiny 16×16 blue square icon
      console.warn('[Tray] Icon not found at', iconPath, '— using fallback icon');
      const size = 16;
      const channels = 4; // RGBA
      const buf = Buffer.alloc(size * size * channels);
      for (let i = 0; i < size * size; i++) {
        buf[i * channels + 0] = 0x33;  // R
        buf[i * channels + 1] = 0x99;  // G
        buf[i * channels + 2] = 0xff;  // B
        buf[i * channels + 3] = 0xff;  // A
      }
      icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
    }

    tray = new Tray(icon);
    tray.setToolTip('QuickClip - No devices');

    // Build context menu
    _rebuildMenu(mainWindow);
    // Refresh addresses each time the native menu opens.
    tray.on('right-click', () => _rebuildMenu(mainWindow));

    // Click on tray → toggle main window visibility
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    console.log('[Tray] System tray created');
    return tray;
  } catch (err) {
    console.error('[Tray] Failed to create tray:', err.message);
    return null;
  }
}

// ── _rebuildMenu (private) ──────────────────────────────────────────────────────
function _rebuildMenu(mainWindow) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show QuickClip',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume Sync' : 'Pause Sync',
      click: () => {
        isPaused = !isPaused;
        _rebuildMenu(mainWindow);           // Refresh the label
        pauseToggleCallbacks.forEach((cb) => {
          try { cb(isPaused); } catch (e) { console.error('[Tray] Pause toggle callback error:', e.message); }
        });
      },
    },
    { type: 'separator' },
    ...(networkControls ? [{ label: 'Network Interface', submenu: networkMenu() }, { type: 'separator' }] : []),
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function networkMenu() {
  const { candidates, preferred, activeIP } = networkControls.getState();
  const selected = candidates.find((entry) => entry.name === preferred?.name && entry.address === preferred?.address)
    || candidates.find((entry) => entry.name === preferred?.name);
  return [
    { label: `Current address: ${activeIP}`, enabled: false },
    { label: 'Changing restarts QuickClip; finish transfers first', enabled: false },
    { type: 'separator' },
    { label: 'Automatic', type: 'radio', checked: !preferred, click: () => networkControls.select(null) },
    ...candidates.map((entry) => ({
      label: `${entry.name.replace(/&/g, '&&')} (${entry.address})`, type: 'radio', checked: entry === selected,
      click: () => networkControls.select({ name: entry.name, address: entry.address }),
    })),
    ...(preferred && !selected ? [{ label: `${preferred.name.replace(/&/g, '&&')} (unavailable; using automatic)`, type: 'radio', checked: true, enabled: false }] : []),
  ];
}

// ── updateTooltip ───────────────────────────────────────────────────────────────
/**
 * Update the tray tooltip text.
 * @param {string} text
 */
function updateTooltip(text) {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.setToolTip(text);
    } catch (err) {
      console.error('[Tray] Failed to update tooltip:', err.message);
    }
  }
}

// ── showBalloon ─────────────────────────────────────────────────────────────────
/**
 * Display a balloon / toast notification from the tray.
 * @param {string} title
 * @param {string} content
 */
function showBalloon(title, content) {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({
        title,
        content,
        iconType: 'info',
      });
    } catch (err) {
      console.error('[Tray] Failed to show balloon:', err.message);
    }
  }
}

// ── onPauseToggle ───────────────────────────────────────────────────────────────
/**
 * Register a callback that fires whenever the user toggles Pause / Resume Sync.
 * @param {(paused: boolean) => void} callback
 */
function onPauseToggle(callback) {
  if (typeof callback === 'function') {
    pauseToggleCallbacks.push(callback);
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────────
module.exports = {
  createTray,
  updateTooltip,
  showBalloon,
  onPauseToggle,
};
