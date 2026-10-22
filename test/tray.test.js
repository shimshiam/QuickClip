'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers');

test('tray recreation and quit remove native icons and retain a stable identity', () => {
  const app = new EventEmitter(), icons = [];
  let failMenu = false;
  class Tray extends EventEmitter {
    constructor(icon, guid) { super(); this.guid = guid; this.destroyed = false; icons.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu() { if (failMenu) throw new Error('Menu failed'); }
  }
  const api = load('src/main/tray.js', { electron: { app, Tray,
    Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ isEmpty: () => false }) } } });
  const first = api.createTray(null, 'icon.png');
  const second = api.createTray(null, 'icon.png');
  assert.equal(first.isDestroyed(), true);
  assert.equal(second.isDestroyed(), false);
  assert.equal(first.guid, second.guid);
  assert.match(first.guid, /^[a-f0-9-]{36}$/);
  assert.equal(app.listenerCount('before-quit'), 1);
  app.emit('before-quit');
  assert.equal(second.isDestroyed(), true);
  failMenu = true;
  assert.equal(api.createTray(null, 'icon.png'), null);
  assert.equal(icons.at(-1).isDestroyed(), true);
  assert.equal(icons.filter(icon => !icon.isDestroyed()).length, 0);
});
