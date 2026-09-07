'use strict';

// Isolated real-Electron smoke check. Never reads or writes the user's clipboard,
// uses temporary certificates/data, and creates only hidden windows.
const { app, BrowserWindow, session, nativeImage, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { load } = require('./helpers');
const { createPolicy } = require('../src/main/settings');
const { generateCertificates } = require('../src/main/certificates');
const api = require('../src/main/server');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quickclip-electron-test-'));
app.setPath('userData', path.join(root, 'electron'));
app.disableHardwareAcceleration();
let server, phone, desktop;
let text = '', image = nativeImage.createEmpty();
const isolatedElectron = { nativeImage, shell: {}, clipboard: {
  readText: () => text, readImage: () => image,
  writeText: (value) => { text = value; image = nativeImage.createEmpty(); },
  writeImage: (value) => { image = value; text = ''; },
} };
let pollClipboard;
const monitor = load('src/main/clipboard-monitor.js', { electron: isolatedElectron }, {
  setInterval: (callback) => { pollClipboard = callback; return 1; }, clearInterval() {},
});
const policy = createPolicy();
const fileManager = load('src/main/file-manager.js', { electron: isolatedElectron }).createFileManager(root);

async function eventually(window, expression) {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UI condition not met: ${expression}`);
}

app.whenReady().then(async () => {
  monitor.configure({ dataDir: root, syncPolicy: policy });
  monitor.startMonitoring();
  image = nativeImage.createFromBitmap(Buffer.alloc(400 * 300 * 4, 200), { width: 400, height: 300 });
  pollClipboard(); pollClipboard();
  assert.equal(monitor.getHistory().length, 1);
  image = nativeImage.createFromBitmap(Buffer.alloc(400 * 300 * 4, 100), { width: 400, height: 300 });
  pollClipboard();
  assert.equal(monitor.getHistory().length, 2);
  monitor.clearHistory(); image = nativeImage.createEmpty(); pollClipboard();
  const cert = await generateCertificates(root, '127.0.0.1');
  server = api.createServer(cert, { port: 0, dataDir: root, token: 'smoke-token', fileManager,
    policy, getHistoryFn: monitor.getHistory, getImagePathFn: monitor.getImagePath, writeToClipboardFn: monitor.writeToClipboard });
  await once(server.httpsServer, 'listening');
  const base = `https://127.0.0.1:${server.httpsServer.address().port}`;
  const errors = [];
  const isolatedSession = session.fromPartition('quickclip-smoke');
  isolatedSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3));
  phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { session: isolatedSession, backgroundThrottling: false } });
  phone.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await phone.loadURL(`${base}/#ip=127.0.0.1&port=${server.httpsServer.address().port}&token=smoke-token`);
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected'");
  await phone.webContents.executeJavaScript(`
    window.smokeCopied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['phone smoke text'], {type:'text/plain'}) }],
      writeText: async (value) => { window.smokeCopied = value; },
      write: async (items) => { window.smokeCopied = await (await items[0].getType('image/png')).arrayBuffer(); }
    } });
    document.querySelector('#btn-send-clipboard').click();
  `);
  await eventually(phone, "document.querySelector('#delivery-status').textContent === 'Sent to Windows'");
  assert.equal(text, 'phone smoke text');

  const png = nativeImage.createFromBitmap(Buffer.alloc(400 * 300 * 4, 200), { width: 400, height: 300 }).toPNG();
  const result = monitor.writeToClipboard({ type: 'image', content: png }, 'local');
  assert.equal(result.ok, true, result.error);
  api.broadcastClipboard(monitor.getHistory()[0]);
  await eventually(phone, "!!document.querySelector('.image-thumb img')");
  await phone.webContents.executeJavaScript("document.querySelector('.image-thumb').closest('.item-card').click()");
  await eventually(phone, 'window.smokeCopied instanceof ArrayBuffer');
  const copiedPNG = Buffer.from(await phone.webContents.executeJavaScript('Array.from(new Uint8Array(window.smokeCopied))'));
  assert.deepEqual(nativeImage.createFromBuffer(copiedPNG).toBitmap(), nativeImage.createFromBuffer(png).toBitmap());

  await phone.webContents.executeJavaScript(`
    navigator.clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([Uint8Array.from(${JSON.stringify([...png])})], {type:'image/png'}) }];
    document.querySelector('#btn-send-clipboard').click();
  `);
  await eventually(phone, "document.querySelector('#delivery-status').textContent === 'Sent to Windows'");
  assert.deepEqual(image.toBitmap(), nativeImage.createFromBuffer(png).toBitmap());
  // Validate malformed-but-PNG-shaped bytes using the real decoder too.
  const broken = Buffer.from(png.subarray(0, 24));
  assert.equal(monitor.writeToClipboard({ type: 'image', content: broken }).ok, false);

  policy.pause(true); api.broadcastSettings();
  await eventually(phone, "document.querySelector('#btn-send-file').disabled && document.querySelector('#status-text').textContent.includes('paused')");
  policy.pause(false); api.broadcastSettings();
  await eventually(phone, "!document.querySelector('#btn-send-file').disabled");
  await phone.reload();
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected' && !!document.querySelector('.image-thumb img')");
  assert.equal(await phone.webContents.executeJavaScript("getComputedStyle(document.querySelector('#retry-clipboard')).display"), 'none');
  assert.equal(await phone.webContents.executeJavaScript("document.querySelector('#btn-send-clipboard').disabled"), false);

  // Desktop exercises the production preload and renderer with an isolated IPC backend.
  const handlers = {
    'get-qr-code': () => '', 'get-status': () => ({ ip: '127.0.0.1', port: 8443, deviceCount: 1 }),
    'get-history': monitor.getHistory, 'get-files': () => [], 'get-settings': policy.get,
    'get-server-info': () => ({ token: 'smoke-token' }),
    'copy-history-item': (_event, id) => monitor.copyHistoryItem(id),
    'update-settings': (_event, settings) => { policy.update(settings); monitor.trimHistory(); return true; },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  desktop = new BrowserWindow({ show: false, width: 520, height: 740, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  desktop.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await desktop.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await eventually(desktop, "!!document.querySelector('.clip-copy-btn')");
  await desktop.webContents.executeJavaScript("document.querySelector('.clip-copy-btn').click()");
  await eventually(desktop, "document.body.textContent.includes('Copied to clipboard!')");
  await desktop.webContents.executeJavaScript("document.querySelector('[data-tab=clipboard]').click()");
  await eventually(desktop, "document.querySelector('#panel-clipboard').classList.contains('active') && !document.querySelector('#panel-pair').classList.contains('active')");
  // Wait for existing card-entry animations before capturing the visible layout.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const out = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'phone.png'), (await phone.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'desktop.png'), (await desktop.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log('PASS: native pixel change detection and PNG decoding, phone text/image acknowledgements, full-resolution Copy, pause/resume, reload hydration, desktop preload and Copy.');
}).then(() => finish(0), (err) => { console.error(err); finish(1); });

function finish(code) {
  if (phone) phone.destroy(); if (desktop) desktop.destroy();
  monitor.stopMonitoring(); monitor.clearHistory();
  if (server) {
    for (const client of server.wss.clients) client.terminate();
    server.wss.close(); server.httpsServer.close();
  }
  // Electron may hold its cache files until exit; retain this uniquely named
  // temporary directory rather than forcing deletion of live files.
  app.exit(code);
}
