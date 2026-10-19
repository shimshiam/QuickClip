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
      return { enforceAccess() {}, httpsServer, wss: { clients: [], close() {} } };
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
  assert.equal(first.options.devices.authenticate('preserved-token'), null);
  assert.equal(first.ipc.get('update-settings')({}, { syncText: false, syncImages: false, syncFiles: false, maxHistory: 3 }), true);
  assert.equal(first.options.policy.allows('text'), false);
  await assert.rejects(first.ipc.get('select-and-send-files')(), /disabled/);
  first.fail();
  assert.equal(first.ipc.get('update-settings')({}, { requirePasscode: true }), false);
  assert.equal(first.options.policy.get().requirePasscode, false);
  assert.equal(first.ipc.get('update-settings')({}, { syncText: true }), false);
  assert.equal(first.options.policy.allows('text'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'))).settings.syncText, false);
  first.app.emit('before-quit');
  const second = await boot();
  t.after(() => second.app.emit('before-quit'));
  assert.equal(second.ipc.get('get-settings')().maxHistory, 3);
  second.ipc.get('update-settings')({}, { syncText: true });
  const invitation = second.options.devices.invite();
  assert.equal(second.ipc.get('update-settings')({}, { requirePasscode: true, pairingPassword: 'My joining password! 42' }), true);
  assert.equal(second.ipc.get('get-settings')().requirePasscode, true);
  assert.equal(second.options.devices.pair(invitation.token, 'Phone'), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'))).settings.requirePasscode, true);
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json')));
  assert.ok(saved.pairingPasswordHash);
  assert.equal(JSON.stringify(saved).includes('My joining password! 42'), false);
  const third = await boot();
  t.after(() => third.app.emit('before-quit'));
  assert.equal(third.ipc.get('get-settings')().hasPairingPassword, true);
  assert.equal(third.ipc.get('get-settings')().pairingPasswordHash, undefined);
  const beforeChange = third.options.devices.invite(saved.pairingPasswordHash);
  assert.equal(third.ipc.get('update-settings')({}, { pairingPassword: 'Replacement! 99' }), true);
  assert.equal(third.options.devices.pair(beforeChange.token, 'Phone', 'My joining password! 42'), null);
  assert.equal(third.ipc.get('update-settings')({}, { pairingPassword: '' }), false);
  const kept = third.options.devices.pair(third.options.devices.invite().token, 'Keep phone');
  const removed = third.options.devices.pair(third.options.devices.invite().token, 'Remove tablet');
  const review = third.options.devices.list().map(device => ({ id: device.id, keep: device.id === kept.deviceId,
    originalPermissions: device.permissions, permissions: { ...device.permissions, write: false } }));
  assert.equal(third.ipc.get('update-settings')({}, { pairingPassword: 'Reviewed password', deviceReview: review }), true);
  assert.equal(third.options.devices.authenticate(removed.token), null);
  assert.equal(third.options.devices.allows(kept.deviceId, 'write'), false);
  const beforeFailure = JSON.parse(fs.readFileSync(path.join(data, 'config.json'))).pairingPasswordHash;
  third.fail();
  const failedReview = third.options.devices.list().map(device => ({ id: device.id, keep: false,
    originalPermissions: device.permissions, permissions: device.permissions }));
  assert.equal(third.ipc.get('update-settings')({}, { pairingPassword: 'Not saved', deviceReview: failedReview }), false);
  assert.equal(third.options.devices.authenticate(kept.token), kept.deviceId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'))).pairingPasswordHash, beforeFailure);
  second.pause(true); assert.equal(second.options.policy.allows('text'), false);
  second.pause(false); assert.equal(second.options.policy.allows('text'), true);
});
