const { hashPassword } = require('../src/main/pairing-password');
const customPassword = 'My joining password! 42';
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

test('pairing API challenges for a passcode before issuing credentials', async (t) => {
  const s = await setup(t);
  const invitation = s.devices.invite(hashPassword(customPassword));
  const pair = passcode => fetch(s.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitation: invitation.token, passcode }) });
  const challenge = await pair();
  assert.equal(challenge.status, 403);
  assert.deepEqual(await challenge.json(), { passcodeRequired: true });
  assert.equal((await pair('wrong')).status, 403);
  const response = await pair(customPassword);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).token);
  assert.equal((await pair(customPassword)).status, 401);
});

async function setup(t, prepare = () => {}) {
  const dataDir = temporary(t);
  prepare(dataDir);
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
  const { httpsServer, wss, devices, enforceAccess } = api.createServer({}, { dataDir, token: 'test-token', policy,
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
  const invitation = devices.invite();
  const pairedResponse = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitation: invitation.token, name: 'Test phone' }) });
  assert.equal(pairedResponse.status, 200);
  const credential = await pairedResponse.json();
  const headers = { Authorization: `Bearer ${credential.token}` };
  async function connect() {
    const phone = new WebSocket(base.replace('http:', 'ws:') + '/?token=' + credential.token);
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
  return { base, headers, connect, devices, enforceAccess, credential, api, monitor, policy, electron, fileManager, dataDir, advanceTime: (ms) => { now += ms; } };
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

test('View changes preserve uploads while Write removal cancels and cleans them', { timeout: 10000 }, async (t) => {
  const s = await setup(t);
  async function partialUpload() {
    const request = http.request(s.base + '/api/upload', { method: 'POST', headers: {
      ...s.headers, 'Content-Type': 'multipart/form-data; boundary=permission-boundary',
    } });
    request.on('error', () => {}); t.after(() => request.destroy());
    request.write('--permission-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n\r\nabc');
    for (let i = 0; i < 100 && !fs.readdirSync(path.join(s.dataDir, 'tmp')).length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(fs.readdirSync(path.join(s.dataDir, 'tmp')).length, 1);
    return request;
  }
  const request = await partialUpload();
  s.devices.updatePermissions(s.credential.deviceId, { view: false });
  s.devices.updatePermissions(s.credential.deviceId, { view: true });
  const response = once(request, 'response');
  request.end('\r\n--permission-boundary--\r\n');
  const [res] = await response; res.resume();
  assert.equal(res.statusCode, 200);
  assert.equal(s.fileManager.listFiles().length, 1);
  await partialUpload();
  s.devices.updatePermissions(s.credential.deviceId, { write: false });
  for (let i = 0; i < 100 && fs.readdirSync(path.join(s.dataDir, 'tmp')).length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), []);
  assert.equal(s.fileManager.listFiles().length, 1);
});

test('Write changes preserve downloads and cancel pending images across a rapid off/on toggle', async (t) => {
  const s = await setup(t), c = await s.connect();
  const file = s.fileManager.saveFile(Buffer.from('private'), 'private.txt');
  const ticket = await (await fetch(s.base + '/api/download-ticket', { method: 'POST',
    headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: file.id, kind: 'file' }) })).json();
  c.send({ type: 'clipboard-image', id: 'pending-image', size: pngHeader.length });
  c.send({ type: 'ping' }); await c.wait(m => m.type === 'pong');
  s.devices.updatePermissions(s.credential.deviceId, { write: false });
  assert.equal((await c.wait(m => m.id === 'pending-image')).ok, false);
  assert.equal(await (await fetch(s.base + ticket.url)).text(), 'private');
  s.devices.updatePermissions(s.credential.deviceId, { write: true });
  c.phone.send(pngHeader);
  assert.match((await c.wait(m => m.type === 'transfer-result')).error, /metadata/);
  assert.equal(s.monitor.getHistory().length, 0);
  s.devices.updatePermissions(s.credential.deviceId, { view: false });
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
});

test('malformed uploads do not crash the server, leak files, or consume upload slots', { timeout: 10000 }, async (t) => {
  const s = await setup(t);
  for (const body of [
    '--broken\r\nContent-Disposition: form-data; filename="bad.txt"\r\n\r\nx\r\n--broken--\r\n',
    '--broken\r\nContent-Disposition: form-data; name=""; filename="bad.txt"\r\n\r\nx\r\n--broken--\r\n',
    '--broken\r\nContent-Disposition: form-data; name="file"; filename="bad.txt"\r\n\r\ntruncated',
  ]) {
    const res = await fetch(s.base + '/api/upload', { method: 'POST', headers: {
      ...s.headers, 'Content-Type': 'multipart/form-data; boundary=broken',
    }, body });
    assert.equal(res.status, 400);
    for (let i = 0; i < 100 && fs.readdirSync(path.join(s.dataDir, 'tmp')).length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), []);
  }
  const body = new FormData(); body.append('file', new Blob(['ok']), 'safe.txt');
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body })).status, 200);
});

test('startup removes only generated temporary uploads left by a crash', async (t) => {
  const s = await setup(t, root => {
    const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, '12345678-1234-1234-1234-123456789abc'), 'orphan');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'unrelated');
  });
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), ['keep.txt']);
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

test('revocation closes sockets, rejects old credentials and invalidates download tickets', async (t) => {
  const s = await setup(t), c = await s.connect();
  const file = s.fileManager.saveFile(Buffer.from('private'), 'private.txt');
  const ticket = await (await fetch(s.base + '/api/download-ticket', { method: 'POST',
    headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: file.id, kind: 'file' }) })).json();
  const closed = once(c.phone, 'close');
  s.devices.revoke(s.credential.deviceId);
  assert.equal((await closed)[0], 4001);
  for (const endpoint of ['/api/history', '/api/files', '/api/files/' + file.id]) {
    assert.equal((await fetch(s.base + endpoint, { headers: s.headers })).status, 401);
  }
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
  assert.equal((await fetch(s.base + '/api/files', { headers: { Authorization: 'Bearer test-token' } })).status, 401);
});

test('remote-access block is distinct from pause and survives reenabling without restoring tickets', async (t) => {
  const s = await setup(t), c = await s.connect();
  const file = s.fileManager.saveFile(Buffer.from('private'), 'private.txt');
  const ticket = await (await fetch(s.base + '/api/download-ticket', { method: 'POST',
    headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: file.id, kind: 'file' }) })).json();
  const closed = once(c.phone, 'close');
  s.policy.update({ remoteAccess: false }); s.enforceAccess();
  assert.equal((await closed)[0], 4003);
  assert.equal((await fetch(s.base + '/api/files', { headers: s.headers })).status, 403);
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
  s.policy.update({ remoteAccess: true });
  assert.equal((await fetch(s.base + '/api/files', { headers: s.headers })).status, 200);
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
});

test('dangerous uploads are rejected and parallel upload limit releases on abort', async (t) => {
  const s = await setup(t);
  const form = new FormData(); form.append('file', new Blob(['not executed']), 'script.PS1');
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: form })).status, 400);
  const requests = [];
  t.after(() => requests.forEach((request) => request.destroy()));
  for (let n = 0; n < 2; n++) {
    const request = http.request(s.base + '/api/upload', { method: 'POST', headers: {
      ...s.headers, 'Content-Type': 'multipart/form-data; boundary=limit-boundary',
    } });
    request.on('error', () => {}); requests.push(request);
    request.write('--limit-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n\r\nabc');
  }
  const directory = path.join(s.dataDir, 'tmp');
  for (let i = 0; i < 100 && fs.readdirSync(directory).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(directory).length, 2);
  const safe = new FormData(); safe.append('file', new Blob(['safe']), 'safe.txt');
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: safe })).status, 429);
  requests.forEach((request) => request.destroy());
  for (let i = 0; i < 100 && fs.readdirSync(directory).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(directory).length, 0);
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers, body: safe })).status, 200);
});

test('revoking a device during upload removes partial bytes and never publishes the file', async (t) => {
  const s = await setup(t);
  const request = http.request(s.base + '/api/upload', { method: 'POST', headers: {
    ...s.headers, 'Content-Type': 'multipart/form-data; boundary=revoke-boundary',
  } });
  request.on('error', () => {}); t.after(() => request.destroy());
  request.write('--revoke-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n\r\nabc');
  const directory = path.join(s.dataDir, 'tmp');
  for (let i = 0; i < 100 && !fs.readdirSync(directory).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(directory).length, 1);
  s.devices.revoke(s.credential.deviceId);
  for (let i = 0; i < 100 && fs.readdirSync(directory).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(directory).length, 0);
  assert.equal(s.fileManager.listFiles().length, 0);
});

test('unauthenticated clients cannot read content, upload or mint download tickets', async (t) => {
  const s = await setup(t);
  for (const endpoint of ['/api/status', '/api/history', '/api/files', '/api/files/unknown', '/api/clipboard-images/unknown']) {
    assert.equal((await fetch(s.base + endpoint)).status, 401);
  }
  for (const endpoint of ['/api/upload', '/api/download-ticket']) {
    assert.equal((await fetch(s.base + endpoint, { method: 'POST' })).status, 401);
  }
  const invitation = s.devices.invite();
  const pair = () => fetch(s.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitation: invitation.token }) });
  assert.equal((await pair()).status, 200);
  assert.equal((await pair()).status, 401);
});

test('per-device permissions block reads, broadcasts and writes, invalidate tickets and preserve credentials', async (t) => {
  const s = await setup(t);
  const file = s.fileManager.saveFile(Buffer.from('private'), 'private.txt');
  const ticket = await (await fetch(s.base + '/api/download-ticket', { method: 'POST',
    headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: file.id, kind: 'file' }) })).json();
  let c = await s.connect();
  s.devices.updatePermissions(s.credential.deviceId, { view: false });
  assert.equal((await c.wait(m => m.type === 'settings')).settings.canView, false);
  assert.equal(c.phone.readyState, WebSocket.OPEN);
  for (const endpoint of ['/api/history', '/api/files', '/api/files/' + file.id, '/api/clipboard-images/anything']) {
    assert.equal((await fetch(s.base + endpoint, { headers: s.headers })).status, 403);
  }
  assert.equal((await fetch(s.base + ticket.url)).status, 401);
  assert.equal((await fetch(s.base + '/api/download-ticket', { method: 'POST', headers: s.headers })).status, 403);
  s.api.broadcastClipboard({ type: 'text', content: 'must not leak' });
  c.send({ type: 'ping' }); await c.wait(m => m.type === 'pong');
  assert.equal(c.messages.some(m => m.type === 'clipboard-text'), false);
  c.send({ type: 'clipboard-text', id: 'allowed-write', content: 'allowed' });
  assert.equal((await c.wait(m => m.id === 'allowed-write')).ok, true);
  s.devices.updatePermissions(s.credential.deviceId, { view: true, write: false });
  const updated = await c.wait(m => m.type === 'settings');
  assert.equal(updated.settings.canView, true);
  assert.equal(updated.settings.syncText, false);
  assert.equal((await fetch(s.base + '/api/history', { headers: s.headers })).status, 200);
  c.send({ type: 'clipboard-text', id: 'blocked-write', content: 'blocked' });
  assert.equal((await c.wait(m => m.id === 'blocked-write')).ok, false);
  assert.equal((await fetch(s.base + '/api/upload', { method: 'POST', headers: s.headers })).status, 403);
  const blocked = once(c.phone, 'close');
  s.devices.updatePermissions(s.credential.deviceId, { access: false });
  assert.equal((await blocked)[0], 4003);
  assert.equal((await fetch(s.base + '/api/history', { headers: s.headers })).status, 403);
  s.devices.updatePermissions(s.credential.deviceId, { access: true });
  assert.equal((await fetch(s.base + '/api/history', { headers: s.headers })).status, 200);
});
