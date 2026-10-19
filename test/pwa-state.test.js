'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production hydration and invalidation functions with controlled
// response ordering, including replies that arrive after permission removal.
function phone(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/pwa/app.js'), 'utf8');
  const clear = source.slice(source.indexOf('  function clearRemoteItems()'), source.indexOf('  function connectWebSocket()'));
  const hydrate = source.slice(source.indexOf('  async function fetchInitialState()'), source.indexOf('  // ─── Keepalive'));
  const state = { fetch, console, connected: true, settings: { canView: true },
    historyRequest: 0, historyRevision: 0, serverIp: '127.0.0.1', serverPort: '8443', authToken: 'test',
    clipboardItems: [{ content: 'old secret' }], fileItems: [{ name: 'old.txt' }],
    releaseItem() {}, renderClipboardList() {}, renderFilesList() {},
  };
  state.addClipboardItem = item => state.clipboardItems.push(item);
  state.addFileItem = item => state.fileItems.push(item);
  vm.createContext(state);
  vm.runInContext(clear + hydrate, state);
  return state;
}

test('denied history and file responses clear previously visible content', async () => {
  for (const status of [401, 403]) {
    for (const denyFiles of [false, true]) {
      const state = phone(async url => denyFiles && url.endsWith('/api/history')
        ? { ok: true, json: async () => [{ content: 'history' }] } : { ok: false, status });
      await state.fetchInitialState();
      assert.equal(state.clipboardItems.length, 0);
      assert.equal(state.fileItems.length, 0);
    }
  }
});

test('an in-flight history response cannot repopulate content after access loss', async () => {
  let respond;
  const state = phone(() => new Promise(resolve => { respond = resolve; }));
  const request = state.fetchInitialState();
  state.clearRemoteItems(); state.settings.canView = false;
  respond({ ok: true, json: async () => [{ content: 'late secret' }] });
  await request;
  assert.equal(state.clipboardItems.length, 0);
  assert.equal(state.fileItems.length, 0);
});

test('a delayed denied response cannot erase a newer authorized refresh', async () => {
  let respond, calls = 0;
  const state = phone(() => ++calls === 1 ? new Promise(resolve => { respond = resolve; })
    : Promise.resolve({ ok: true, json: async () => [] }));
  const first = state.fetchInitialState();
  await state.fetchInitialState();
  state.clipboardItems.push({ content: 'current' });
  respond({ ok: false, status: 403 });
  await first;
  assert.equal(state.clipboardItems[0].content, 'current');
});
