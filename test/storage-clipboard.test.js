'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load, temporary, fakeElectron, pngHeader } = require('./helpers');
const { createPolicy, validateSettings } = require('../src/main/settings');
const { migrateData } = require('../src/main/storage');
const { attachTransferHandler, createReceiptCache } = require('../src/main/transfer');
const { createDelivery } = require('../src/pwa/delivery');
const { imageSize } = require('../src/main/image-size');

test('migration preserves credentials and bytes, rewrites paths, and is idempotent', (t) => {
  const root = temporary(t), old = path.join(root, 'legacy'), target = path.join(root, 'user', 'runtime');
  fs.mkdirSync(path.join(old, 'certs'), { recursive: true });
  fs.mkdirSync(path.join(old, 'received'));
  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ token: 'unchanged' }));
  fs.writeFileSync(path.join(old, 'certs', 'ca.key'), 'test certificate key');
  const file = path.join(old, 'received', 'example.txt'); fs.writeFileSync(file, 'file contents');
  fs.writeFileSync(path.join(old, 'received', 'index.json'), JSON.stringify([{ id: '1', path: file }]));
  migrateData(old, target);
  assert.equal(fs.readFileSync(path.join(target, 'certs', 'ca.key'), 'utf8'), 'test certificate key');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'config.json'))).token, 'unchanged');
  const index = JSON.parse(fs.readFileSync(path.join(target, 'received', 'index.json')));
  assert.equal(index[0].path, path.join(target, 'received', 'example.txt'));
  assert.equal(fs.readFileSync(index[0].path, 'utf8'), 'file contents');
  assert.equal(fs.readFileSync(file, 'utf8'), 'file contents');
  fs.writeFileSync(path.join(target, 'config.json'), 'new configuration');
  migrateData(old, target);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), 'new configuration');
});

test('failed migration never publishes partial data or changes the source', (t) => {
  const root = temporary(t), old = path.join(root, 'old'), target = path.join(root, 'runtime');
  fs.mkdirSync(path.join(old, 'received'), { recursive: true });
  const raw = '{broken-index';
  fs.writeFileSync(path.join(old, 'received', 'index.json'), raw);
  assert.throws(() => migrateData(old, target));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(old, 'received', 'index.json'), 'utf8'), raw);
});

test('image history stores metadata, copies full bytes, prunes and clears files', (t) => {
  const dataDir = temporary(t), policy = createPolicy({ maxHistory: 2 });
  const electron = fakeElectron();
  const monitor = load('src/main/clipboard-monitor.js', { electron });
  monitor.configure({ dataDir, syncPolicy: policy });
  const image = Buffer.concat([pngHeader, Buffer.alloc(1024 * 1024)]);
  const result = monitor.writeToClipboard({ type: 'image', content: image });
  assert.equal(result.ok, true);
  const imagePath = monitor.getImagePath(result.id);
  assert.equal(monitor.getHistory()[0].content, undefined);
  assert.ok(JSON.stringify(monitor.getHistory()).length < 1000);
  electron.state.image = Buffer.alloc(0);
  assert.equal(monitor.copyHistoryItem(result.id).ok, true);
  assert.deepEqual(electron.state.image, image);
  monitor.writeToClipboard({ type: 'text', content: 'next' });
  assert.equal(fs.existsSync(imagePath), false);
  policy.update({ maxHistory: 1 }); monitor.trimHistory();
  assert.equal(monitor.getHistory().length, 1);
  monitor.clearHistory();
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'clipboard-images')), []);
  assert.equal(monitor.copyHistoryItem(result.id).ok, false);
});

test('migration retains unavailable index entries without blocking intact files', (t) => {
  const root = temporary(t), old = path.join(root, 'old'), target = path.join(root, 'runtime');
  fs.mkdirSync(path.join(old, 'received'), { recursive: true });
  fs.writeFileSync(path.join(old, 'received', 'index.json'), JSON.stringify([{ id: 'missing', path: path.join(old, 'received', 'gone.txt') }]));
  migrateData(old, target);
  const index = JSON.parse(fs.readFileSync(path.join(target, 'received', 'index.json')));
  assert.equal(index[0].id, 'missing');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'migration.json'))).missingFileIds, ['missing']);
});

test('remote writes do not echo and a new local change is detected immediately', (t) => {
  const dataDir = temporary(t), policy = createPolicy(), electron = fakeElectron();
  let poll;
  const monitor = load('src/main/clipboard-monitor.js', { electron }, {
    setInterval: (callback) => { poll = callback; return 1; }, clearInterval() {},
  });
  monitor.configure({ dataDir, syncPolicy: policy }); monitor.startMonitoring();
  const events = []; monitor.onClipboardChange((item) => events.push(item));
  monitor.writeToClipboard({ type: 'text', content: 'remote' }); poll();
  assert.equal(events.length, 1);
  electron.clipboard.writeText('local immediately'); poll();
  assert.equal(events[1].source, 'local');
  policy.update({ syncText: false }); electron.clipboard.writeText('private'); poll();
  assert.equal(events.length, 2);
  assert.equal(monitor.writeToClipboard({ type: 'text', content: 'disabled' }).ok, false);
});

test('settings reject invalid values without mutating current policy', () => {
  const policy = createPolicy();
  assert.throws(() => policy.update({ syncText: 'false' }));
  assert.throws(() => policy.update({ maxHistory: 0 }));
  assert.throws(() => policy.update({ maxImageBytes: 20971521 }));
  assert.equal(policy.get().syncText, true);
  assert.equal(validateSettings({ maxHistory: 12 }).maxHistory, 12);
  policy.pause(true); assert.equal(policy.allows('text'), false);
  policy.pause(false); assert.equal(policy.allows('text'), true);
});

test('image dimensions reject oversized decoded images before invoking native decoding', (t) => {
  const electron = fakeElectron();
  let calls = 0;
  electron.nativeImage.createFromBuffer = () => { calls++; throw new Error('Must not decode'); };
  const monitor = load('src/main/clipboard-monitor.js', { electron });
  monitor.configure({ dataDir: temporary(t), syncPolicy: createPolicy() });
  const bomb = Buffer.from(pngHeader); bomb.writeUInt32BE(1000000, 16);
  assert.equal(monitor.writeToClipboard({ type: 'image', content: bomb }).ok, false);
  assert.equal(calls, 0);
  assert.throws(() => imageSize(Buffer.from('invalid')));
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,30,0,40,1,1,17,0]);
  assert.deepEqual(imageSize(jpeg), { width: 40, height: 30 });
});

test('unfinished images expire and the same socket accepts the next transfer', async () => {
  const ws = new EventEmitter(); ws.readyState = 1;
  const output = []; ws.send = (raw) => output.push(JSON.parse(raw));
  attachTransferHandler(ws, { policy: createPolicy(), receipts: createReceiptCache(),
    write: () => ({ ok: true }), imageTimeout: 10 });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'clipboard-image', id: 'image', size: 20 })), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(output[0].error, /expired/);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'clipboard-text', id: 'text', content: 'next' })), false);
  assert.equal(output[1].ok, true);
  ws.emit('close');
});

test('phone waits for acknowledgement and retries with the same ID', async (t) => {
  const states = [], sent = [];
  const delivery = createDelivery({ timeout: 10, send: (msg) => sent.push(msg), onState: (s) => states.push(s) });
  t.after(() => delivery.dispose());
  delivery.start({ id: 'one', type: 'clipboard-text', content: 'hello' });
  assert.equal(states.at(-1).state, 'sending');
  delivery.receive({ id: 'other', ok: true }); assert.equal(states.at(-1).state, 'sending');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(states.at(-1).state, 'unconfirmed');
  delivery.disconnect(); delivery.retry();
  assert.equal(sent[0].id, sent[1].id);
  delivery.receive({ id: 'one', ok: true });
  assert.equal(states.at(-1).state, 'sent');
  delivery.start({ id: 'two' }); delivery.receive({ id: 'two', ok: false, error: 'Clipboard busy' });
  assert.equal(states.at(-1).error, 'Clipboard busy');
});
