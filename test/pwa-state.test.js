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
    FilePreview: { closeAll() { state.previewsClosed = true; } },
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
      assert.equal(state.previewsClosed, true);
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

test('paired devices are named after the device and browser', () => {
  const { deviceLabel } = require('../src/pwa/device-label');
  const ua = {
    iPhoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
    iPhoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15',
    iPhoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
    iPadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  };
  assert.equal(deviceLabel({ userAgent: ua.iPhoneSafari }), 'iPhone · Safari');
  assert.equal(deviceLabel({ userAgent: ua.iPhoneSafari, standalone: true }), 'iPhone · Home Screen app');
  assert.equal(deviceLabel({ userAgent: ua.iPhoneChrome }), 'iPhone · Chrome');
  assert.equal(deviceLabel({ userAgent: ua.iPhoneEdge }), 'iPhone · Edge');
  assert.equal(deviceLabel({ userAgent: ua.iPhoneFirefox }), 'iPhone · Firefox');
  assert.equal(deviceLabel({ userAgent: ua.iPadOS, maxTouchPoints: 5 }), 'iPad · Safari');
  assert.equal(deviceLabel({ userAgent: ua.iPadOS, maxTouchPoints: 0 }), 'Mac · Safari');
  assert.equal(deviceLabel({ userAgent: ua.android }), 'Android phone · Chrome');
  assert.equal(deviceLabel({ userAgent: ua.samsung }), 'Android phone · Samsung Internet');
  assert.equal(deviceLabel({ userAgent: ua.windowsEdge }), 'Windows PC · Edge');
  assert.equal(deviceLabel({}), 'Device · Browser');
});
