'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * QuickClip – Secure IPC Bridge (preload)
 *
 * Exposes a controlled API surface to the renderer process via
 * `window.quickclip`.  Every call either uses `ipcRenderer.invoke` (returning
 * a Promise) or `ipcRenderer.on` (returning a cleanup function).
 */
contextBridge.exposeInMainWorld('quickclip', {
  // ── Request / Response (Promise-based) ──────────────────────────────────────

  /** Fetch QR-code data-URL for device pairing. */
  getQRCode: () => ipcRenderer.invoke('get-qr-code'),

  /** Fetch current server / connection status. */
  getStatus: () => ipcRenderer.invoke('get-status'),

  /** Fetch clipboard history array. */
  getHistory: () => ipcRenderer.invoke('get-history'),
  copyHistoryItem: (id) => ipcRenderer.invoke('copy-history-item', id),

  /** Clear all clipboard history. */
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  /** Fetch persisted settings object. */
  getSettings: () => ipcRenderer.invoke('get-settings'),

  /** Persist updated settings object. */
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),

  /** Open the system file explorer at the given path. */
  showInExplorer: (filePath) => ipcRenderer.invoke('show-in-explorer', filePath),

  /** Fetch received files array. */
  getFiles: () => ipcRenderer.invoke('get-files'),

  /** Open a file by ID or path. */
  openFile: (pathOrId) => ipcRenderer.invoke('open-file', pathOrId),

  /** Get connection details (ip, port, token). */
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),

  /** Trigger CA certificate download / save dialog. */
  downloadCACert: () => ipcRenderer.invoke('download-ca-cert'),

  /** Open file dialog to select local PC files and share them with mobile devices. */
  selectAndSendFiles: () => ipcRenderer.invoke('select-and-send-files'),

  // ── Event Subscriptions (callback-based) ────────────────────────────────────

  /**
   * Subscribe to clipboard changes pushed from the main process.
   * @param {(data: object) => void} callback
   * @returns {() => void} Cleanup function that removes the listener.
   */
  onClipboardChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('clipboard-change', handler);
    return () => ipcRenderer.removeListener('clipboard-change', handler);
  },

  /**
   * Subscribe to device-connect events.
   * @param {(data: object) => void} callback
   * @returns {() => void} Cleanup function that removes the listener.
   */
  onDeviceConnect: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('device-connect', handler);
    return () => ipcRenderer.removeListener('device-connect', handler);
  },

  /**
   * Subscribe to device-disconnect events.
   * @param {(data: object) => void} callback
   * @returns {() => void} Cleanup function that removes the listener.
   */
  onDeviceDisconnect: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('device-disconnect', handler);
    return () => ipcRenderer.removeListener('device-disconnect', handler);
  },

  /**
   * Subscribe to file-received events.
   * @param {(data: object) => void} callback
   * @returns {() => void} Cleanup function that removes the listener.
   */
  onFileReceived: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('file-received', handler);
    return () => ipcRenderer.removeListener('file-received', handler);
  },
});
