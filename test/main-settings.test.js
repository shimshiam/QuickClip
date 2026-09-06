'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load, temporary, fakeElectron } = require('./helpers');
const { atomicJSON } = require('../src/main/storage');

test('application startup, IPC settings persistence, failure rollback and tray pause', async (t) => {
  const root = temporary(t), data = path.join(root, 'runtime');
  fs.mkdirSync(data);
  atomicJSON(path.join(data, 'config.json'), { token: 'preserved-token', port: 8443, settings: { maxHistory: 50 } });
  async function boot() {
    const electron = fakeElectron();
    const monitor = load('src/main/clipboard-monitor.js', { electron });
    const app = new EventEmitter();
    app.disableHardwareAcceleration = () => {};
    app.requestSingleInstanceLock = () => true;
    app.getPath = () => root;
    app.quit = () => app.emit('before-quit');
    const ipc = new Map();
    let options, pauseCallback, failSave = false;
    class Window extends EventEmitter {
      constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = () => {}; }
      loadFile() {} isDestroyed() { return false; }
    }
    const server = { createServer(_certs, supplied) {
      options = supplied;
      const httpsServer = new EventEmitter(); httpsServer.close = () => {};
      setImmediate(() => httpsServer.emit('listening'));
      return { httpsServer, wss: { clients: [], close() {} } };
    }, broadcastClipboard() {}, broadcastFileAvailable() {}, getConnectedDevices: () => [],
    onDeviceConnect() {}, onDeviceDisconnect() {}, onFileReceived() {}, broadcastSettings() {}, broadcastRaw() {} };
    load('src/main/main.js', {
      electron: { ...electron, app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
        dialog: { showErrorBox: (_title, message) => assert.fail(message), showOpenDialog: async () => ({ canceled: true }) } },
      './clipboard-monitor': monitor, './server': server,
      './file-manager': load('src/main/file-manager.js', { electron }),
      './storage': { migrateData: () => data, atomicJSON: (file, value) => { if (failSave) throw new Error('Simulated disk failure'); atomicJSON(file, value); } },
      './certificates': { generateCertificates: async () => ({}) },
      './network': { getLocalIP: () => '127.0.0.1', generatePairingToken: () => 'unused', startMDNS() {}, stopMDNS() {} },
      './tray': { createTray() {}, updateTooltip() {}, showBalloon() {}, onPauseToggle: (cb) => { pauseCallback = cb; } },
    }, { process });
    await app.listeners('ready')[0]();
    return { app, ipc, monitor, options, pause: (value) => pauseCallback(value), fail: () => { failSave = true; } };
  }
  const first = await boot();
  t.after(() => first.app.emit('before-quit'));
  assert.equal(first.options.token, 'preserved-token');
  assert.equal(first.ipc.get('update-settings')({}, { syncText: false, syncImages: false, syncFiles: false, maxHistory: 3 }), true);
  assert.equal(first.options.policy.allows('text'), false);
  await assert.rejects(first.ipc.get('select-and-send-files')(), /disabled/);
  first.fail();
  assert.equal(first.ipc.get('update-settings')({}, { syncText: true }), false);
  assert.equal(first.options.policy.allows('text'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'))).settings.syncText, false);
  first.app.emit('before-quit');
  const second = await boot();
  t.after(() => second.app.emit('before-quit'));
  assert.equal(second.ipc.get('get-settings')().maxHistory, 3);
  second.ipc.get('update-settings')({}, { syncText: true });
  second.pause(true); assert.equal(second.options.policy.allows('text'), false);
  second.pause(false); assert.equal(second.options.policy.allows('text'), true);
});
