'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load, temporary } = require('./helpers');
const { atomicJSON } = require('../src/main/storage');

test('network override persists, restarts, and updates certificate, server and pairing together', async (t) => {
  const root = temporary(t);
  const configPath = path.join(root, 'config.json');
  atomicJSON(configPath, { token: 'preserved-token', settings: { maxHistory: 17 } });
  let interfaces = { Ethernet: [{ address: '192.168.1.10', family: 'IPv4' }], VPN: [{ address: '10.8.0.2', family: 'IPv4' }] };
  async function boot() {
    const app = new EventEmitter(), ipc = new Map(), errors = [];
    let controls, certIP, serverOptions, failSave = false, relaunches = 0, quits = 0;
    app.disableHardwareAcceleration = () => {};
    app.requestSingleInstanceLock = () => true;
    app.getPath = () => root;
    app.relaunch = () => { relaunches++; };
    app.quit = () => { quits++; app.emit('before-quit'); };
    class Window extends EventEmitter {
      constructor() { super(); this.webContents = new EventEmitter(); }
      loadFile() {}
    }
    const network = load('src/main/network.js', { os: { networkInterfaces: () => interfaces } });
    load('src/main/main.js', {
      electron: { app, BrowserWindow: Window, ipcMain: { handle: (key, fn) => ipc.set(key, fn) }, dialog: { showErrorBox: (_title, message) => errors.push(message) } },
      './network': { ...network, generateQRCode: async (url, token) => `${url}#${token}`, startMDNS() {}, stopMDNS() {} },
      './certificates': { generateCertificates: async (_root, ip) => { certIP = ip; return {}; } },
      './storage': { migrateData: () => root, atomicJSON: (file, value) => { if (failSave) throw new Error('Disk full'); atomicJSON(file, value); } },
      './clipboard-monitor': { configure() {}, startMonitoring() {}, stopMonitoring() {}, clearHistory() {}, onClipboardChange() {} },
      './file-manager': { createFileManager: () => ({}) },
      './tray': { createTray: (_window, _icon, value) => { controls = value; }, onPauseToggle() {} },
      './server': { createServer(_cert, options) {
        serverOptions = options;
        const httpsServer = new EventEmitter(); httpsServer.close = () => {};
        setImmediate(() => httpsServer.emit('listening'));
        return { httpsServer, wss: { clients: [], close() {} } };
      }, getConnectedDevices: () => [], onDeviceConnect() {}, onDeviceDisconnect() {}, onFileReceived() {} },
    }, { process });
    await app.listeners('ready')[0]();
    return { controls, ipc, errors, certIP, serverOptions, fail: () => { failSave = true; },
      get relaunches() { return relaunches; }, get quits() { return quits; } };
  }
  const first = await boot();
  assert.equal(first.certIP, '192.168.1.10');
  first.controls.select({ name: 'VPN', address: '10.8.0.2' });
  assert.equal(first.relaunches, 1);
  assert.equal(first.quits, 1);
  assert.equal(JSON.parse(fs.readFileSync(configPath)).token, 'preserved-token');
  const second = await boot();
  assert.equal(second.certIP, '10.8.0.2');
  assert.equal(second.serverOptions.hostnames[0], second.certIP);
  assert.equal(second.ipc.get('get-status')().ip, second.certIP);
  assert.equal(await second.ipc.get('get-qr-code')(), 'https://10.8.0.2:8443#preserved-token');
  assert.equal(second.ipc.get('get-settings')().maxHistory, 17);
  second.controls.select({ name: 'VPN', address: '10.8.0.2' });
  assert.equal(second.relaunches, 0);
  second.controls.select({ name: 'VPN', address: '10.8.0.99' });
  assert.match(second.errors.pop(), /no longer available/);
  assert.equal(second.relaunches, 0);
  second.fail(); second.controls.select(null);
  assert.match(second.errors.pop(), /Disk full/);
  assert.equal(second.relaunches, 0);
  assert.equal(second.controls.getState().preferred.name, 'VPN');
  assert.equal(JSON.parse(fs.readFileSync(configPath)).networkInterface.name, 'VPN');
  interfaces.VPN[0].address = '10.8.0.5';
  const renewed = await boot();
  assert.equal(renewed.certIP, '10.8.0.5');
  delete interfaces.VPN;
  const missing = await boot();
  assert.equal(missing.certIP, '192.168.1.10');
  assert.equal(missing.controls.getState().preferred.name, 'VPN');
  missing.controls.select(null);
  assert.equal(missing.relaunches, 1);
  const automatic = await boot();
  assert.equal(automatic.controls.getState().preferred, null);
  assert.equal(automatic.certIP, '192.168.1.10');
});
