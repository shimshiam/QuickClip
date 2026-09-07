'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, temporary, fakeElectron, pngHeader } = require('./helpers');
const { createPolicy } = require('../src/main/settings');

function setup(t, settings = {}) {
  const policy = createPolicy(settings), electron = fakeElectron();
  let poll, current;
  const counts = { reads: 0, bitmaps: 0, encodes: 0 };
  electron.clipboard.readImage = () => { counts.reads++; return current; };
  function image(pixels, width = 400, height = 300, bytes = 100) {
    return { isEmpty: () => false, getSize: () => ({ width, height }),
      getBitmap: () => { counts.bitmaps++; return Buffer.from(pixels); },
      toPNG: () => { counts.encodes++; return Buffer.alloc(bytes); },
      resize: () => ({ toDataURL: () => 'data:image/png;base64,dGh1bWI=' }) };
  }
  const monitor = load('src/main/clipboard-monitor.js', { electron }, {
    setInterval: (fn) => { poll = fn; return 1; }, clearInterval() {},
  });
  monitor.configure({ dataDir: temporary(t), syncPolicy: policy });
  return { monitor, policy, counts, image, set: (value) => { current = value; }, poll: () => poll() };
}

test('startup and unchanged pixels never encode PNG; changed pixels and dimensions do', (t) => {
  const f = setup(t);
  f.set(f.image('initial')); f.monitor.startMonitoring();
  for (let i = 0; i < 5; i++) { f.set(f.image('initial')); f.poll(); }
  assert.equal(f.counts.encodes, 0);
  f.set(f.image('changed')); f.poll(); f.poll();
  assert.equal(f.counts.encodes, 1);
  assert.equal(f.monitor.getHistory().length, 1);
  f.set(f.image('changed', 300, 400)); f.poll();
  assert.equal(f.counts.encodes, 2);
  // Clearing and re-copying identical pixels must still be a new local copy.
  f.set(null); f.poll(); f.set(f.image('changed', 300, 400)); f.poll();
  assert.equal(f.monitor.getHistory().length, 3);
});

test('oversized images never access pixels or encode, including startup and resume', (t) => {
  const f = setup(t);
  f.set(f.image('huge', 10000, 10000)); f.monitor.startMonitoring(); f.poll();
  f.monitor.stopMonitoring(); f.monitor.startMonitoring(); f.poll();
  assert.equal(f.counts.bitmaps, 0);
  assert.equal(f.counts.encodes, 0);
  assert.equal(f.monitor.getHistory().length, 0);
  f.set(f.image('valid')); f.poll();
  assert.equal(f.counts.encodes, 1);
  assert.equal(f.monitor.getHistory().length, 1);
});

test('disabled or paused image sync skips reads and does not send old images when re-enabled', (t) => {
  const f = setup(t, { syncImages: false });
  f.set(f.image('private')); f.monitor.startMonitoring(); f.poll();
  assert.equal(f.counts.reads, 0);
  f.policy.update({ syncImages: true }); f.poll();
  assert.equal(f.counts.encodes, 0);
  f.set(f.image('new')); f.poll();
  assert.equal(f.monitor.getHistory().length, 1);
  const reads = f.counts.reads;
  f.policy.pause(true); f.set(f.image('paused')); f.poll();
  assert.equal(f.counts.reads, reads);
  f.policy.pause(false); f.poll();
  assert.equal(f.monitor.getHistory().length, 1);
});

test('images above the byte limit are encoded once and excluded from history', (t) => {
  const f = setup(t, { maxImageBytes: 50 });
  f.monitor.startMonitoring();
  f.set(f.image('too large', 400, 300, 100)); f.poll(); f.poll();
  assert.equal(f.counts.encodes, 1);
  assert.equal(f.monitor.getHistory().length, 0);
  f.set(f.image('small', 400, 300, 40)); f.poll();
  assert.equal(f.monitor.getHistory().length, 1);
});

test('remote images do not echo and a same-size local replacement is detected', (t) => {
  const electron = fakeElectron(), policy = createPolicy();
  let poll;
  const monitor = load('src/main/clipboard-monitor.js', { electron }, {
    setInterval: (fn) => { poll = fn; return 1; }, clearInterval() {},
  });
  monitor.configure({ dataDir: temporary(t), syncPolicy: policy }); monitor.startMonitoring();
  assert.equal(monitor.writeToClipboard({ type: 'image', content: pngHeader }).ok, true);
  poll(); poll(); assert.equal(monitor.getHistory().length, 1);
  electron.state.image = Buffer.concat([pngHeader, Buffer.from('different pixels')]);
  poll(); assert.equal(monitor.getHistory().length, 2);
  assert.equal(monitor.getHistory()[0].source, 'local');
});
