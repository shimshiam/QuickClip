const { hashPassword } = require('../src/main/pairing-password');
const customPassword = 'My joining password! 42';
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDeviceStore } = require('../src/main/devices');
const { createPolicy } = require('../src/main/settings');
const { assertSafeFile, canOpenDirectly } = require('../src/main/file-safety');
const { load, temporary, fakeElectron, pngHeader } = require('./helpers');

test('password device review validates snapshots, rolls back failed saves, and applies removals and permissions', t => {
  const root = temporary(t), store = createDeviceStore(root);
  const first = store.pair(store.invite().token, 'Phone');
  const second = store.pair(store.invite().token, 'Tablet');
  const draft = () => store.list().map(device => ({ id: device.id, keep: true, originalPermissions: device.permissions, permissions: { ...device.permissions } }));
  const review = draft(); review[0].permissions.write = false; review[1].keep = false;
  let changes = 0; store.onChange(() => changes++); store.onRevoke(() => changes++);
  assert.throws(() => store.applyReview(review, () => { throw new Error('Disk full'); }), /Disk full/);
  assert.equal(store.authenticate(second.token), second.deviceId);
  assert.equal(store.allows(first.deviceId, 'write'), true);
  assert.equal(changes, 0);
  assert.equal(createDeviceStore(root).list().length, 2);
  assert.throws(() => store.applyReview([], () => assert.fail()), /changed/);
  store.updatePermissions(first.deviceId, { view: false });
  assert.throws(() => store.applyReview(review, () => assert.fail()), /changed/);
  const fresh = draft(); fresh[0].permissions.write = false; fresh[1].keep = false;
  store.applyReview(fresh, () => {});
  assert.equal(store.authenticate(second.token), null);
  assert.equal(store.authenticate(first.token), first.deviceId);
  assert.equal(store.allows(first.deviceId, 'write'), false);
  assert.equal(createDeviceStore(root).allows(first.deviceId, 'write'), false);
  store.applyReview(draft().map(row => ({ ...row, keep: false })), () => {});
  assert.equal(store.list().length, 0);
});

test('passcodes gate joining, bound guesses, expire and can be disabled', (t) => {
  let now = 1000;
  const devices = createDeviceStore(temporary(t), () => now);
  const invitation = devices.invite(hashPassword(customPassword));
  assert.equal(invitation.passwordHash, undefined);
  assert.deepEqual(devices.pair(invitation.token, 'Phone'), { passcodeRequired: true });
  assert.equal(devices.list().length, 0);
  assert.equal(devices.pair(invitation.token, 'Phone', 'wrong').passcodeRequired, true);
  const paired = devices.pair(invitation.token, 'Phone', customPassword);
  assert.equal(devices.authenticate(paired.token), paired.deviceId);
  assert.equal(devices.pair(invitation.token, 'Replay', customPassword), null);
  const locked = devices.invite(hashPassword(customPassword));
  for (let i = 0; i < 4; i++) assert.equal(devices.pair(locked.token, 'Phone', 'wrong').passcodeRequired, true);
  assert.equal(devices.pair(locked.token, 'Phone', 'wrong'), null);
  assert.equal(devices.pair(locked.token, 'Phone', customPassword), null);
  const expired = devices.invite(hashPassword(customPassword)); now += 300001;
  assert.equal(devices.pair(expired.token, 'Phone', customPassword), null);
  const invalidated = devices.invite(); devices.invalidateInvitation();
  assert.equal(devices.pair(invalidated.token, 'Phone'), null);
  assert.ok(devices.pair(devices.invite(false).token, 'Phone').token);
});

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
  assert.equal(createDeviceStore(root, () => now).authenticate(first.token), first.deviceId);
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

test('failed file-index writes remove unpublished copies and preserve originals', (t) => {
  const root = temporary(t);
  const original = path.join(root, 'original.txt'); fs.writeFileSync(original, 'source');
  const manager = load('src/main/file-manager.js', { electron: fakeElectron(),
    './storage': { atomicJSON() { throw new Error('Disk full'); } },
  }).createFileManager(root);
  assert.throws(() => manager.saveFile(Buffer.from('remote'), 'remote.txt'), /Disk full/);
  assert.throws(() => manager.saveDesktopFile(original), /Disk full/);
  const tmp = path.join(root, 'upload'); fs.writeFileSync(tmp, 'upload');
  assert.throws(() => manager.saveFileFromPath(tmp, 'upload.txt', 6), /Disk full/);
  assert.equal(manager.listFiles().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'received')), []);
  assert.equal(fs.readFileSync(original, 'utf8'), 'source');
});

test('failed deletion retains the listed file so it can be retried', (t) => {
  const root = temporary(t); let locked = true;
  const manager = load('src/main/file-manager.js', { electron: fakeElectron(),
    fs: { ...fs, unlinkSync(file) { if (locked) throw new Error('File locked'); return fs.unlinkSync(file); } },
  }).createFileManager(root);
  const file = manager.saveFile(Buffer.from('keep'), 'keep.txt');
  assert.throws(() => manager.deleteFile(file.id), /File locked/);
  assert.equal(manager.listFiles().length, 1);
  assert.ok(fs.existsSync(file.path));
  locked = false; assert.equal(manager.deleteFile(file.id), true);
  assert.equal(manager.listFiles().length, 0);
});

test('risky Windows types missing from the original list are blocked; ordinary documents are allowed', () => {
  for (const name of ['addin.xll', 'run.ws', 'component.wsc', 'scriptlet.sct', 'connect.rdp', 'share.library-ms',
    'search.searchConnector-ms', 'panel.settingcontent-ms', 'leak.theme', 'install.appinstaller', 'fix.diagcab',
    'book.xlsb', 'db.accde', 'tool.msu', 'MACRO.XLAM. ']) {
    assert.throws(() => assertSafeFile(name), /blocked/, name);
  }
  for (const name of ['resume.docx', 'notes.pdf', 'photos.zip', 'IMG_0001.HEIC', 'song.mp3']) assert.doesNotThrow(() => assertSafeFile(name), name);
  for (const name of ['a.png', 'b.PDF', 'c.docx', 'd.mov', 'e.txt']) assert.equal(canOpenDirectly(name), true, name);
  for (const name of ['a.zip', 'b.html', 'c.svg', 'd.doc', 'e.xls', 'f.one', 'g']) assert.equal(canOpenDirectly(name), false, name);
});

test('phone files get Mark-of-the-Web and only allowlisted types are launched directly', { skip: process.platform !== 'win32' && 'NTFS alternate data streams are Windows-only' }, async (t) => {
  const root = temporary(t), received = path.join(root, 'received'); fs.mkdirSync(received);
  const zone = (file) => { try { return fs.readFileSync(file + ':Zone.Identifier', 'utf8'); } catch (_) { return null; } };
  // A file saved before origins were recorded is marked when QuickClip starts.
  const legacy = path.join(received, 'legacy.pdf'); fs.writeFileSync(legacy, '%PDF');
  fs.writeFileSync(path.join(received, 'index.json'), JSON.stringify([{ id: 'legacy', name: 'legacy.pdf', path: legacy, timestamp: Date.now() }]));
  const calls = [];
  const manager = load('src/main/file-manager.js', { electron: { shell: {
    openPath: async (file) => { calls.push(['open', path.basename(file)]); return ''; },
    showItemInFolder: (file) => { calls.push(['reveal', path.basename(file)]); },
  } } }).createFileManager(root);
  assert.match(zone(legacy), /ZoneId=3/);

  const photo = manager.saveFile(Buffer.from('png bytes'), 'photo.png');
  const archive = manager.saveFile(Buffer.from('zip bytes'), 'photos.zip');
  assert.match(zone(photo.path), /\[ZoneTransfer\]\r\nZoneId=3/);
  assert.match(zone(archive.path), /ZoneId=3/);
  assert.equal(fs.readFileSync(photo.path, 'utf8'), 'png bytes', 'main stream is untouched');

  const source = path.join(root, 'mine.txt'); fs.writeFileSync(source, 'my own file');
  const desktop = manager.saveDesktopFile(source);
  assert.equal(zone(desktop.path), null, 'files shared from this PC are not marked');

  assert.equal(await manager.openFile(photo.id), 'opened');
  assert.equal(await manager.openFile(archive.id), 'revealed');
  assert.deepEqual(calls, [['open', path.basename(photo.path)], ['reveal', path.basename(archive.path)]]);
});

test('opening a file deleted outside QuickClip fails without recreating it', async (t) => {
  const root = temporary(t);
  let launched = false;
  const manager = load('src/main/file-manager.js', { electron: { shell: { openPath: async () => { launched = true; return ''; }, showItemInFolder() {} } } }).createFileManager(root);
  const saved = manager.saveFile(Buffer.from('png'), 'photo.png');
  fs.unlinkSync(saved.path);
  await assert.rejects(manager.openFile(saved.id), /no longer available/);
  assert.equal(fs.existsSync(saved.path), false);
  assert.equal(launched, false);
});

test('device credentials expire after 90 days without use; activity keeps them alive', (t) => {
  const root = temporary(t); let now = 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const devices = createDeviceStore(root, () => now);
  const revoked = []; devices.onRevoke((id) => revoked.push(id));
  const active = devices.pair(devices.invite().token, 'Active');
  const idle = devices.pair(devices.invite().token, 'Idle');
  for (let day = 0; day < 120; day += 30) { now += 30 * DAY; assert.equal(devices.authenticate(active.token), active.deviceId); }
  assert.equal(devices.authenticate(idle.token), null, 'unused for 120 days');
  assert.deepEqual(revoked, [idle.deviceId]);
  assert.equal(devices.has(idle.deviceId), false);
  assert.equal(createDeviceStore(root, () => now).authenticate(active.token), active.deviceId, 'activity was persisted');
});

test('devices paired before expiry existed get a fresh 90 days instead of being cut off', (t) => {
  const root = temporary(t);
  const crypto = require('node:crypto');
  const token = 'a'.repeat(64);
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify([{ id: 'old-phone', name: 'Phone',
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'), pairedAt: 1 }]));
  const now = 400 * 24 * 60 * 60 * 1000;
  assert.equal(createDeviceStore(root, () => now).authenticate(token), 'old-phone');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'devices.json'), 'utf8'))[0].lastSeenAt, now);
});

test('expired devices are pruned at startup and before pairing; a clock moved back does not extend them', (t) => {
  const root = temporary(t); let now = 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const devices = createDeviceStore(root, () => now);
  const stale = devices.pair(devices.invite().token, 'Stale');
  now += 91 * DAY;
  const fresh = createDeviceStore(root, () => now);
  assert.equal(fresh.has(stale.deviceId), false, 'pruned on load');
  const kept = fresh.pair(fresh.invite().token, 'Kept');
  now -= 30 * DAY; // clock moved backwards
  assert.equal(fresh.authenticate(kept.token), kept.deviceId);
  now += 30 * DAY + 91 * DAY;
  assert.equal(fresh.authenticate(kept.token), null);
});
