const { hashPassword } = require('../src/main/pairing-password');
const customPassword = 'My joining password! 42';
'use strict';

// Isolated real-Electron smoke check. Startup compatibility reads the real
// clipboard without logging or changing it. Transfers use a fake clipboard,
// temporary certificates/data, and hidden windows.
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
  for (let i = 0; i < 200; i++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UI condition not met: ${expression}`);
}

app.whenReady().then(async () => {
  // The transport tests below use a fake clipboard. Check the actual API too:
  // Electron 44 made reads asynchronous and removed readImage/writeImage.
  const realElectron = require('electron');
  for (const method of ['readText', 'writeText', 'readImage', 'writeImage']) {
    assert.equal(typeof realElectron.clipboard[method], 'function', `Unsupported clipboard API: ${method}`);
  }
  assert.equal(typeof realElectron.clipboard.readText(), 'string', 'Clipboard reads must be synchronous');
  const startupMonitor = load('src/main/clipboard-monitor.js', { electron: realElectron }, {
    setInterval: () => 1, clearInterval() {},
  });
  startupMonitor.configure({ dataDir: path.join(root, 'startup'), syncPolicy: policy });
  startupMonitor.startMonitoring();
  startupMonitor.stopMonitoring();
  assert.equal(startupMonitor.getHistory().length, 0);
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
  server = api.createServer(cert, { port: 0, dataDir: root, fileManager,
    policy, getHistoryFn: monitor.getHistory, getImagePathFn: monitor.getImagePath, writeToClipboardFn: monitor.writeToClipboard });
  await once(server.httpsServer, 'listening');
  const base = `https://127.0.0.1:${server.httpsServer.address().port}`;
  const errors = [];
  const isolatedSession = session.fromPartition('quickclip-smoke');
  isolatedSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3));
  phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true, session: isolatedSession, backgroundThrottling: false } });
  phone.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const protectedInvitation = server.devices.invite(hashPassword(customPassword));
  await phone.loadURL(base + '/');
  await eventually(phone, "document.querySelector('#overlay-status').textContent.includes('Scan QR')");
  await phone.loadURL(`${base}/#invitation=${protectedInvitation.token}`);
  await eventually(phone, "!document.querySelector('#pairing-form').hidden");
  await eventually(phone, `(() => {
    const overlay = document.querySelector('#connection-overlay');
    const input = document.querySelector('#pairing-passcode');
    const style = getComputedStyle(overlay), rect = input.getBoundingClientRect();
    return style.display !== 'none' && Number(style.opacity) === 1 && style.pointerEvents !== 'none'
      && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  })()`);
  fs.mkdirSync(path.resolve(__dirname, '../.test-output'), { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 400));
  fs.writeFileSync(path.resolve(__dirname, '../.test-output/phone-password.png'), (await phone.webContents.capturePage()).toPNG());
  await phone.webContents.executeJavaScript('window.location.reload()');
  await eventually(phone, "!document.querySelector('#pairing-form').hidden");
  assert.equal(server.devices.list().length, 0);
  const wrongPasscode = customPassword === '000000' ? '111111' : '000000';
  await phone.webContents.executeJavaScript(`document.querySelector('#pairing-passcode').value = '${wrongPasscode}'; document.querySelector('#pairing-form').requestSubmit()`);
  await eventually(phone, "document.querySelector('#pairing-error').textContent.includes('Incorrect')");
  assert.equal(server.devices.list().length, 0);
  await phone.webContents.executeJavaScript(`document.querySelector('#pairing-passcode').value = '${customPassword}'; document.querySelector('#pairing-form').requestSubmit()`);
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected'");
  assert.equal(await phone.webContents.executeJavaScript("getComputedStyle(document.querySelector('#connection-overlay')).display"), 'none');
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
  let savedPasswordHash = '';
  const handlers = {
    'get-qr-code': async () => {
      const invitation = server.devices.invite(policy.get().requirePasscode ? savedPasswordHash : '');
      const qr = await require('../src/main/network').generateQRCode(base, invitation.token);
      return qr;
    }, 'get-status': () => ({ ip: '127.0.0.1', port: 8443, deviceCount: 1 }),
    'get-history': monitor.getHistory, 'get-files': () => fileManager.listFiles(), 'get-settings': () => ({ ...policy.get(), hasPairingPassword: !!savedPasswordHash }),
    'get-server-info': () => ({}),
    'get-trusted-devices': () => server.devices.list().map(device => ({ ...device,
      connected: api.getConnectedDevices().some(client => client.deviceId === device.id) })),
    'set-device-permissions': (_event, id, patch) => server.devices.updatePermissions(id, patch),
    'revoke-device': (_event, id) => server.devices.revoke(id),
    'disconnect-all': () => server.devices.revokeAll(),
    'copy-history-item': (_event, id) => monitor.copyHistoryItem(id),
    'update-settings': (_event, settings) => { if (settings.pairingPassword) savedPasswordHash = hashPassword(settings.pairingPassword); policy.update(settings); server.enforceAccess(); monitor.trimHistory(); return true; },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  desktop = new BrowserWindow({ show: false, width: 520, height: 740, webPreferences: {
    offscreen: true, preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  desktop.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await desktop.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await eventually(desktop, "!!document.querySelector('.clip-copy-btn')");
  await desktop.webContents.executeJavaScript("document.querySelector('#requirePasscode').click()");
  await eventually(desktop, "!document.querySelector('#pairingPasswordForm').hidden");
  await desktop.webContents.executeJavaScript("document.querySelector('#pairingPassword').value = 'My joining password! 42'; document.querySelector('#pairingPasswordForm').requestSubmit()");
  await eventually(desktop, "document.querySelector('#pairingPasswordStatus').textContent.includes('Password saved') && !document.querySelector('#requirePasscode').disabled");
  assert.equal(policy.get().requirePasscode, true);
  fs.mkdirSync(path.resolve(__dirname, '../.test-output'), { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 4000));
  fs.writeFileSync(path.resolve(__dirname, '../.test-output/pairing-passcode.png'), (await desktop.webContents.capturePage()).toPNG());
  await desktop.webContents.executeJavaScript("document.documentElement.classList.add('dark-mode')");
  await new Promise(resolve => setTimeout(resolve, 400));
  fs.writeFileSync(path.resolve(__dirname, '../.test-output/pairing-password-dark.png'), (await desktop.webContents.capturePage()).toPNG());
  await desktop.webContents.executeJavaScript("document.documentElement.classList.remove('dark-mode')");
  await desktop.webContents.executeJavaScript("document.querySelector('#requirePasscode').click()");
  await eventually(desktop, "document.querySelector('#pairingPasswordForm').hidden && !document.querySelector('#requirePasscode').disabled");
  assert.equal(policy.get().requirePasscode, false);
  await desktop.webContents.executeJavaScript("document.querySelector('.clip-copy-btn').click()");
  await eventually(desktop, "document.querySelector('.clip-copy-btn').textContent === 'Copied ✓'");
  await desktop.webContents.executeJavaScript("document.querySelector('[data-tab=clipboard]').click()");
  await eventually(desktop, "document.querySelector('#panel-clipboard').classList.contains('active') && !document.querySelector('#panel-pair').classList.contains('active')");
  // Wait for existing card-entry animations before capturing the visible layout.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const out = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'phone.png'), (await phone.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'desktop.png'), (await desktop.webContents.capturePage()).toPNG());
  await desktop.webContents.executeJavaScript("document.querySelector('[data-tab=settings]').click()");
  await eventually(desktop, "document.querySelector('#trustedDevices').textContent.includes('Remove')");
  await eventually(desktop, "document.querySelector('#panel-settings').classList.contains('active')");
  await desktop.webContents.executeJavaScript("document.querySelector('#trustedDevices').scrollIntoView({block:'start'})");
  await new Promise((resolve) => setTimeout(resolve, 600));
  fs.writeFileSync(path.join(out, 'security-settings.png'), (await desktop.webContents.capturePage()).toPNG());
  const deviceId = server.devices.list()[0].id;
  // Documentation captures use the real renderers and isolated sample content.
  monitor.clearHistory();
  monitor.writeToClipboard({ type: 'text', content: 'Project notes\nReview the mockups and share the final files.' }, 'local');
  api.broadcastClipboard(monitor.getHistory()[0]);
  const sampleFile = fileManager.saveFile(Buffer.from('Review the mockups and share the final files.'), 'Project notes.txt');
  api.broadcastFileAvailable(sampleFile);
  await phone.reload();
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected' && document.body.textContent.includes('Project notes')");
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(out, 'phone-clipboard-current.png'), (await phone.webContents.capturePage()).toPNG());
  await phone.webContents.executeJavaScript("document.querySelector('[data-tab=files]').click()");
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(out, 'phone-files-current.png'), (await phone.webContents.capturePage()).toPNG());
  await phone.webContents.executeJavaScript("document.querySelector('[data-tab=clipboard]').click()");
  desktop.setSize(720, 760);
  await desktop.reload();
  await eventually(desktop, "document.body.textContent.includes('Project notes')");
  for (const tab of ['clipboard', 'files', 'settings']) {
    if (tab === 'settings') desktop.setSize(620, 1180);
    await desktop.webContents.executeJavaScript(`document.querySelector('[data-tab=${tab}]').click()`);
    await new Promise(resolve => setTimeout(resolve, 600));
    fs.writeFileSync(path.join(out, 'windows-' + tab + '-current.png'), (await desktop.webContents.capturePage()).toPNG());
  }
  desktop.setSize(520, 740);
  await desktop.webContents.executeJavaScript("document.querySelector('[data-tab=pair]').click(); document.querySelector('.connection-badge').click()");
  await new Promise(resolve => setTimeout(resolve, 600));
  fs.writeFileSync(path.join(out, 'windows-devices-current.png'), (await desktop.webContents.capturePage()).toPNG());
  await desktop.webContents.executeJavaScript("document.querySelector('#deviceDrawer').close(); document.querySelector('[data-tab=settings]').click()");
  // Restore the image fixture needed by permission regression checks below.
  monitor.writeToClipboard({ type: 'image', content: png }, 'local');
  api.broadcastClipboard(monitor.getHistory()[0]);
  const permissions = patch => desktop.webContents.executeJavaScript(`window.quickclip.setDevicePermissions(${JSON.stringify(deviceId)}, ${JSON.stringify(patch)})`);
  await permissions({ view: false });
  await eventually(phone, "document.querySelectorAll('.item-card').length === 0 && document.querySelector('#status-text').textContent === 'Connected'");
  assert.equal(await phone.webContents.executeJavaScript("document.querySelector('#btn-send-clipboard').disabled"), false);
  await permissions({ view: true, write: false });
  await eventually(phone, "!!document.querySelector('.image-thumb img') && document.querySelector('#btn-send-clipboard').disabled");
  await permissions({ write: true });
  await eventually(phone, "!document.querySelector('#btn-send-clipboard').disabled");
  // Simulate a lost connection before Windows changes View. No close code can
  // tell the phone to clear its history, and reconnect must still stay empty.
  for (const client of server.wss.clients) client.terminate();
  server.devices.updatePermissions(deviceId, { view: false });
  await eventually(phone, "document.querySelectorAll('.item-card').length === 0");
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected'");
  assert.equal(await phone.webContents.executeJavaScript("document.querySelectorAll('.item-card').length"), 0);
  await permissions({ view: true });
  await eventually(phone, "!!document.querySelector('.image-thumb img')");
  await desktop.webContents.executeJavaScript("document.querySelector('#settingRemoteAccess').click()");
  await eventually(phone, "document.body.textContent.includes('Access is off on Windows')");
  assert.equal(await phone.webContents.executeJavaScript("document.querySelectorAll('.item-card').length"), 0);
  await desktop.webContents.executeJavaScript("document.querySelector('#settingRemoteAccess').click()");
  await eventually(phone, "document.querySelector('#status-text').textContent === 'Connected'");
  await desktop.webContents.executeJavaScript("document.querySelector('#trustedDevices .device-remove').click()");
  await eventually(phone, "document.body.textContent.includes('Device access was removed')");
  assert.equal(await phone.webContents.executeJavaScript("localStorage.getItem('quickclip_device_token')"), null);
  assert.deepEqual(errors, []);
  console.log('PASS: native pixel change detection and PNG decoding, phone text/image acknowledgements, full-resolution Copy, pause/resume, reload hydration, desktop preload and Copy, pairing, remote-access blocking, reenabling, and device revocation.');
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
