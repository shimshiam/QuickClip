'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicJSON } = require('./storage');
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createDeviceStore(dataDir, now = Date.now) {
  const file = path.join(dataDir, 'devices.json');
  let devices = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(devices) || devices.length > 20 || devices.some((device) => !device
    || typeof device.id !== 'string' || typeof device.name !== 'string'
    || !/^[a-f0-9]{64}$/.test(device.tokenHash) || !Number.isFinite(device.pairedAt))) {
    throw new Error('Invalid trusted-device store');
  }
  let invitation = null;
  const listeners = [];
  function commit(next) { atomicJSON(file, next); devices = next; }
  return {
    invite() {
      invitation = { token: crypto.randomBytes(32).toString('hex'), expires: now() + 5 * 60000 };
      return { ...invitation };
    },
    pair(token, name) {
      if (typeof token !== 'string' || !invitation || invitation.expires <= now()
        || digest(token) !== digest(invitation.token)) return null;
      if (devices.length >= 20) throw new Error('Remove a trusted device before pairing another');
      const credential = crypto.randomBytes(32).toString('hex');
      const device = { id: crypto.randomUUID(), name: typeof name === 'string' ? name.trim().slice(0, 80) || 'Phone' : 'Phone',
        tokenHash: digest(credential), pairedAt: now() };
      commit([...devices, device]);
      invitation = null;
      return { token: credential, deviceId: device.id };
    },
    authenticate(token) {
      if (typeof token !== 'string' || !token || token.length > 256) return null;
      const hash = digest(token);
      return devices.find((device) => device.tokenHash === hash)?.id || null;
    },
    has: (id) => devices.some((device) => device.id === id),
    list: () => devices.map(({ tokenHash, ...device }) => device),
    revoke(id) {
      if (typeof id !== 'string') throw new Error('Invalid device');
      commit(devices.filter((device) => device.id !== id));
      listeners.forEach((listener) => listener(id));
    },
    revokeAll() {
      commit([]); invitation = null;
      listeners.forEach((listener) => listener(null));
    },
    onRevoke(listener) { listeners.push(listener); },
  };
}
module.exports = { createDeviceStore };
