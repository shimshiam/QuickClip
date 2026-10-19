'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDeviceStore } = require('../src/main/devices');
const { createPolicy } = require('../src/main/settings');
const { assertSafeFile } = require('../src/main/file-safety');
const { load, temporary, fakeElectron, pngHeader } = require('./helpers');

test('pairing invitations expire, work once, persist only credential hashes and support revocation', (t) => {
  const root = temporary(t); let now = 1000;
  const devices = createDeviceStore(root, () => now);
  const old = devices.invite(); const invite = devices.invite();
  assert.equal(devices.pair(old.token, 'Old'), null);
  assert.equal(devices.pair('wrong', 'Wrong'), null);
  now += 5 * 60000;
  assert.equal(devices.pair(invite.token, 'Expired'), null);
  const fresh = devices.invite();
  const first = devices.pair(fresh.token, 'Phone');
  assert.equal(devices.pair(fresh.token, 'Replay'), null);
  assert.equal(devices.authenticate(first.token), first.deviceId);
  assert.equal(fs.readFileSync(path.join(root, 'devices.json'), 'utf8').includes(first.token), false);
  assert.equal(createDeviceStore(root).authenticate(first.token), first.deviceId);
  const second = devices.pair(devices.invite().token, 'Tablet');
  devices.revoke(first.deviceId);
  assert.equal(devices.authenticate(first.token), null);
  assert.equal(devices.authenticate(second.token), second.deviceId);
  const pending = devices.invite(); devices.revokeAll();
  assert.equal(devices.authenticate(second.token), null);
  assert.equal(devices.pair(pending.token, 'Replay'), null);
});

test('clipboard expiry deletes image bytes and blocks copying expired history while paused', (t) => {
  const root = temporary(t); let now = Date.now();
  const policy = createPolicy({ clipboardTtlMinutes: 1 });
  const monitor = load('src/main/clipboard-monitor.js', { electron: fakeElectron() }, {
    Date: class extends Date { static now() { return now; } },
  });
  monitor.configure({ dataDir: root, syncPolicy: policy });
  monitor.writeToClipboard({ type: 'text', content: 'private' });
  monitor.writeToClipboard({ type: 'image', content: pngHeader });
  const entries = monitor.getHistory(); const image = entries.find((entry) => entry.type === 'image');
  const imagePath = monitor.getImagePath(image.id);
  assert.ok(fs.existsSync(imagePath)); policy.pause(true); now += 60000;
  assert.equal(monitor.getImagePath(image.id), null);
  assert.equal(fs.existsSync(imagePath), false);
  assert.equal(monitor.getHistory().length, 0);
  assert.equal(monitor.copyHistoryItem(entries[1].id).ok, false);
});

test('expired file shares disappear remotely without deleting saved or original files', (t) => {
  const root = temporary(t); let now = Date.now();
  const manager = load('src/main/file-manager.js', { electron: fakeElectron() }, {
    Date: class extends Date { static now() { return now; } },
  }).createFileManager(root, createPolicy({ fileTtlHours: 1 }));
  const original = path.join(root, 'original.txt'); fs.writeFileSync(original, 'private');
  const file = manager.saveDesktopFile(original);
  assert.ok(manager.sharedFile(file.id)); now += 3600000;
  assert.equal(manager.sharedFile(file.id), null);
  assert.equal(manager.listSharedFiles().length, 0);
  assert.ok(manager.getFile(file.id));
  manager.deleteFile(file.id);
  assert.equal(fs.readFileSync(original, 'utf8'), 'private');
});

test('storage quota counts temporary files and in-flight reservations; free disk reserve is enforced', (t) => {
  const root = temporary(t); let available = 1024 * 1024 * 1024;
  const manager = load('src/main/file-manager.js', { electron: fakeElectron(),
    fs: { ...fs, statfsSync: () => ({ bavail: available, bsize: 1 }) },
  }).createFileManager(root, createPolicy({ storageQuotaMB: 500 }));
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.writeFileSync(path.join(root, 'tmp', 'partial'), '1234');
  const release = manager.reserveCapacity(499 * 1024 * 1024);
  assert.throws(() => manager.reserveCapacity(1024 * 1024), /quota/);
  release(); release(); manager.assertCapacity(1024 * 1024);
  available = 256 * 1024 * 1024;
  assert.throws(() => manager.saveFile(Buffer.from('a'), 'safe.txt'), /disk space/);
});

test('dangerous file types and misleading names are blocked, including opening legacy files', async (t) => {
  for (const name of ['RUN.EXE', 'script.ps1', 'link.lnk', 'report.docm', 'run.bat. ', 'safe.txt:run.exe', 'report\u202eexe.txt']) {
    assert.throws(() => assertSafeFile(name), /blocked|invalid/);
  }
  assert.doesNotThrow(() => assertSafeFile('resume.docx'));
  const root = temporary(t), received = path.join(root, 'received'); fs.mkdirSync(received);
  const target = path.join(received, 'legacy.exe'); fs.writeFileSync(target, 'not executed');
  fs.writeFileSync(path.join(received, 'index.json'), JSON.stringify([{ id: 'legacy', name: 'legacy.exe', path: target }]));
  let opened = false;
  const manager = load('src/main/file-manager.js', { electron: { shell: { openPath: () => { opened = true; } } } }).createFileManager(root);
  await assert.rejects(manager.openFile('legacy'), /blocked/);
  assert.equal(opened, false);
});

test('streaming capacity failure cleans up partial upload and releases reservations', async (t) => {
  const { createUploadStorage } = require('../src/main/upload-storage');
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const root = temporary(t), request = new EventEmitter(), stream = new PassThrough();
  let reserved = 0, writes = 0;
  const storage = createUploadStorage(root, (bytes) => {
    if (++writes > 1) throw new Error('Shared storage quota reached');
    reserved += bytes;
    return () => { reserved -= bytes; };
  });
  const result = new Promise((resolve) => storage._handleFile(request, { stream }, (err) => resolve(err)));
  stream.write(Buffer.alloc(1024));
  for (let i = 0; i < 100 && !writes; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  stream.end(Buffer.alloc(1024));
  assert.match((await result).message, /quota/);
  assert.equal(reserved, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('device permissions persist, validate patches and retain pairing while access is off', (t) => {
  const root = temporary(t), devices = createDeviceStore(root);
  const paired = devices.pair(devices.invite().token, 'Phone');
  assert.equal(devices.allows(paired.deviceId, 'view'), true);
  devices.updatePermissions(paired.deviceId, { view: false, access: false });
  const loaded = createDeviceStore(root);
  assert.equal(loaded.authenticate(paired.token), paired.deviceId);
  assert.equal(loaded.allows(paired.deviceId), false);
  loaded.updatePermissions(paired.deviceId, { access: true });
  assert.equal(loaded.allows(paired.deviceId, 'view'), false);
  assert.equal(loaded.allows(paired.deviceId, 'write'), true);
  assert.throws(() => loaded.updatePermissions(paired.deviceId, { write: 'false' }), /Invalid/);
  assert.throws(() => loaded.updatePermissions(paired.deviceId, { unknown: true }), /Invalid/);
});
