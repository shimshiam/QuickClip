'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { load, temporary, fakeElectron, pngHeader } = require('./helpers');
const { createPolicy } = require('../src/main/settings');

async function setup(t) {
  const dataDir = temporary(t);
  const policy = createPolicy();
  let now = Date.now();
  const electron = fakeElectron();
  const monitor = load('src/main/clipboard-monitor.js', { electron });
  monitor.configure({ dataDir, syncPolicy: policy });
  const fileManager = load('src/main/file-manager.js', { electron }).createFileManager(dataDir);
  const api = load('src/main/server.js', { https: {
    createServer(_certs, app) {
      const server = http.createServer(app);
      const listen = server.listen.bind(server);
      server.listen = (_port, _host, callback) => listen(0, '127.0.0.1', callback);
      return server;
    },
  } }, { Date: class extends Date { static now() { return now; } } });
  const { httpsServer, wss } = api.createServer({}, { dataDir, token: 'test-token', policy,
    fileManager, getHistoryFn: monitor.getHistory, getImagePathFn: monitor.getImagePath,
    writeToClipboardFn: monitor.writeToClipboard });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    httpsServer.closeAllConnections();
    await new Promise((resolve) => httpsServer.close(resolve));
  });
  await once(httpsServer, 'listening');
  const base = `http://127.0.0.1:${httpsServer.address().port}`;
  const headers = { Authorization: 'Bearer test-token' };
  async function connect() {
    const phone = new WebSocket(base.replace('http:', 'ws:') + '/?token=test-token');
    const messages = [];
    phone.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(phone, 'open');
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        const at = messages.findIndex(predicate);
        if (at >= 0) return messages.splice(at, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Expected server message was not received');
    };
    await wait((msg) => msg.type === 'settings');
    return { phone, wait, messages, send: (msg) => phone.send(JSON.stringify(msg)) };
  }
  return { base, headers, connect, api, monitor, policy, electron, fileManager, dataDir, advanceTime: (ms) => { now += ms; } };
}

test('text, image, ping, receipts and retry across reconnect', { timeout: 10000 }, async (t) => {
  const s = await setup(t);
  let c = await s.connect();
  const text = { id: 'text-1', type: 'clipboard-text', content: 'Hello 📱' };
  c.send(text);
  assert.equal((await c.wait((m) => m.id === text.id)).ok, true);
  assert.equal(s.electron.state.text, text.content);
  c.phone.close(); await once(c.phone, 'close');
  c = await s.connect(); c.send(text);
  assert.equal((await c.wait((m) => m.id === text.id)).ok, true);
  assert.equal(s.monitor.getHistory().length, 1);
  c.send({ ...text, content: 'different' });
  assert.equal((await c.wait((m) => m.id === text.id)).ok, false);
  const image = Buffer.concat([pngHeader, Buffer.from('full resolution image')]);
  c.send({ id: 'img-1', type: 'clipboard-image', size: image.length }); c.phone.send(image);
  assert.equal((await c.wait((m) => m.id === 'img-1')).ok, true);
  assert.deepEqual(s.electron.state.image, image);
  c.send({ type: 'ping' }); await c.wait((m) => m.type === 'pong');
  const history = await (await fetch(s.base + '/api/history', { headers: s.headers })).json();
  assert.equal(history[0].content, undefined);
  assert.ok(history[0].thumbnail);
  const res = await fetch(s.base + '/api/clipboard-images/' + history[0].id, { headers: s.headers });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), image);
  s.api.broadcastClipboard(history[0]);
  assert.equal((await c.wait((m) => m.type === 'clipboard-image-available')).id, history[0].id);
  s.api.broadcastClipboard(history[1]);
  assert.equal((await c.wait((m) => m.type === 'clipboard-text')).content, text.content);
});

test('reject malformed, oversized, unexpected and undecodable transfers; recover', async (t) => {
  const s = await setup(t), c = await s.connect();
  const error = () => c.wait((m) => m.type === 'transfer-result' && !m.ok);
  c.phone.send('{'); assert.match((await error()).error, /JSON/);
  c.phone.send(Buffer.from('unexpected')); assert.match((await error()).error, /metadata/);
  c.send({ type: 'clipboard-text', id: 'bad', content: {} }); await error();
  c.send({ type: 'clipboard-image', id: 'bad', size: 20971521 }); await error();
  c.send({ type: 'clipboard-image', id: 'bad', size: 5 }); c.phone.send(Buffer.from('four')); await error();
  c.send({ type: 'clipboard-image', id: 'bad', size: 4 }); c.phone.send(Buffer.from('nope')); await error();
  s.policy.update({ maxTextBytes: 4 });
  c.send({ type: 'clipboard-text', id: 'large', content: '12345' }); await error();
  c.send({ type: 'clipboard-text', id: 'ok', content: '1234' });
  assert.equal((await c.wait((m) => m.id === 'ok')).ok, true);
  s.electron.state.fail = true;
  c.send({ type: 'clipboard-text', id: 'busy', content: 'next' });
  assert.match((await error()).error, /busy/);
});

test('sync preferences and pause reject new writes; saved files remain accessible', async (t) => {
  const s = await setup(t), c = await s.connect();
  s.policy.update({ syncText: false, syncImages: false, syncFiles: false });
  c.send({ type: 'clipboard-text', id: 'off', content: 'hidden' });
  assert.match((await c.wait((m) => m.id === 'off')).error, /disabled/);
  c.send({ type: 'clipboard-image', id: 'off-img', size: 4 });
  assert.match((await c.wait((m) => m.id === 'off-img')).error, /disabled/);
  s.api.broadcastClipboard({ type: 'text', content: 'do not send' });
  s.api.broadcastFileAvailable({ id: 'x', name: 'x', size: 1 });
  c.send({ type: 'ping' }); await c.wait((m) => m.type === 'pong');
  assert.equal(c.messages.length, 0);
  const form = new FormData(); form.append('file', new Blob(['x']), 'x.txt');
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: form })).status, 403);
  s.policy.update({ syncText: true }); s.policy.pause(true);
  c.send({ type: 'clipboard-text', id: 'paused', content: 'hidden' });
  assert.match((await c.wait((m) => m.id === 'paused')).error, /paused/);
  const existing = s.fileManager.saveFile(Buffer.from('saved'), 'saved.txt');
  assert.equal((await fetch(s.base + '/api/files/' + existing.id, { headers: s.headers })).status, 200);
});

test('uploads, scoped download tickets, authentication and origin restrictions', async (t) => {
  const s = await setup(t);
  const form = new FormData(); form.append('file', new Blob(['phone file']), 'phone.txt');
  const uploaded = await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: form });
  assert.equal(uploaded.status, 200);
  const file = await uploaded.json(); assert.equal(file.path, undefined);
  const list = await (await fetch(s.base + '/api/files', { headers: s.headers })).json();
  assert.equal(list[0].path, undefined);
  const ticket = await (await fetch(s.base + '/api/download-ticket', {
    method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: file.id, kind: 'file' }),
  })).json();
  assert.ok(!ticket.url.includes('test-token'));
  assert.equal(await (await fetch(s.base + ticket.url)).text(), 'phone file');
  s.advanceTime(61000);
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
  assert.equal((await fetch(s.base + '/api/download/invalid')).status, 401);
  assert.equal((await fetch(s.base + '/api/files?token=test-token')).status, 401);
  assert.equal((await fetch(s.base + '/api/download-ticket', {
    method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: '{',
  })).status, 400);
  assert.equal((await fetch(s.base + '/api/files', { headers: { ...s.headers, Origin: 'https://evil.example' } })).status, 403);
  const denied = new WebSocket(s.base.replace('http:', 'ws:') + '/?token=test-token', { origin: 'https://evil.example' });
  const [err] = await once(denied, 'error'); assert.match(err.message, /403/);
  const unauthorized = new WebSocket(s.base.replace('http:', 'ws:') + '/?token=wrong');
  const [code] = await once(unauthorized, 'close'); assert.equal(code, 4001);
  const double = new FormData(); double.append('file', new Blob(['1']), '1.txt'); double.append('file', new Blob(['2']), '2.txt');
  const rejected = await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: double });
  assert.equal(rejected.status, 400); assert.ok((await rejected.json()).error);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), []);
});

test('aborted upload closes and removes its partial file', async (t) => {
  const s = await setup(t);
  const req = http.request(s.base + '/api/upload', { method: 'POST', headers: {
    ...s.headers, 'Content-Type': 'multipart/form-data; boundary=clip-boundary',
  } });
  req.on('error', () => {});
  req.write('--clip-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n');
  req.write(Buffer.alloc(65536, 65));
  const directory = path.join(s.dataDir, 'tmp');
  for (let i = 0; i < 100 && !fs.readdirSync(directory).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(directory).length, 1);
  req.destroy();
  for (let i = 0; i < 100 && fs.readdirSync(directory).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(s.fileManager.listFiles().length, 0);
});
