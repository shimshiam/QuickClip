'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicJSON } = require('./storage');
const { verifyPassword } = require('./pairing-password');
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');
// A credential unused for this long stops working, so a lost or forgotten phone
// cannot reconnect months later. Activity is persisted at most every 6 hours.
const INACTIVE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
const ACTIVITY_WRITE_MS = 6 * 60 * 60 * 1000;

function createDeviceStore(dataDir, now = Date.now) {
  const file = path.join(dataDir, 'devices.json');
  let devices = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(devices) || devices.length > 20 || devices.some((device) => !device
    || typeof device.id !== 'string' || typeof device.name !== 'string'
    || !/^[a-f0-9]{64}$/.test(device.tokenHash) || !Number.isFinite(device.pairedAt)
    || (device.lastSeenAt !== undefined && !Number.isFinite(device.lastSeenAt)))) {
    throw new Error('Invalid trusted-device store');
  }
  let invitation = null;
  const listeners = [];
  const changeListeners = [];
  const permissions = (device) => ({ view: true, write: true, access: true, ...device.permissions });
  function commit(next) { atomicJSON(file, next); devices = next; }
  // A clock moved backwards must not extend a credential's life.
  const idleFor = (device) => now() - Math.min(device.lastSeenAt, now());
  const expired = (device) => idleFor(device) > INACTIVE_EXPIRY_MS;
  // Devices paired before expiry existed start their 90 days now instead of
  // being cut off for an old pairing date.
  if (devices.some((device) => device.lastSeenAt === undefined)) {
    const next = devices.map((device) => (device.lastSeenAt === undefined ? { ...device, lastSeenAt: now() } : device));
    try { commit(next); } catch (err) {
      devices = next; // keep them working; the timestamp is saved on a later write
      console.error('[Devices] Could not record device activity:', err.message);
    }
  }
  // Expired devices free their slot and disappear from the list at startup.
  function pruneExpired() {
    const gone = devices.filter(expired);
    if (!gone.length) return;
    commit(devices.filter((device) => !expired(device)));
    gone.forEach((device) => listeners.forEach((listener) => listener(device.id)));
  }
  try { pruneExpired(); } catch (err) { console.error('[Devices] Could not remove expired devices:', err.message); }
  return {
    invalidateInvitation() { invitation = null; },
    invite(passwordHash = '') {
      if (passwordHash && !/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(passwordHash)) throw new Error('Set a joining password first');
      invitation = { token: crypto.randomBytes(32).toString('hex'), expires: now() + 5 * 60000 };
      if (passwordHash) { invitation.passwordHash = passwordHash; invitation.attempts = 0; }
      return { token: invitation.token, expires: invitation.expires };
    },
    pair(token, name, passcode, replaces) {
      if (typeof token !== 'string' || !invitation || invitation.expires <= now()
        || digest(token) !== digest(invitation.token)) return null;
      if (invitation.passwordHash) {
        if (passcode === undefined) return { passcodeRequired: true };
        if (!verifyPassword(passcode, invitation.passwordHash)) {
          invitation.attempts++;
          if (invitation.attempts >= 5) { invitation = null; return null; }
          return { passcodeRequired: true, error: 'Incorrect password. Try again.' };
        }
      }
      pruneExpired();
      // Re-pairing from a browser that is already paired replaces its entry instead of
      // adding a duplicate. Proving the old credential is required, and the new entry
      // keeps the old entry's permissions so re-pairing never widens access.
      const previous = typeof replaces === 'string' && replaces && replaces.length <= 256
        ? devices.find((device) => device.tokenHash === digest(replaces)) : null;
      const remaining = previous ? devices.filter((device) => device.id !== previous.id) : devices;
      if (remaining.length >= 20) throw new Error('Remove a trusted device before pairing another');
      const credential = crypto.randomBytes(32).toString('hex');
      const device = { id: crypto.randomUUID(), name: typeof name === 'string' ? name.trim().slice(0, 80) || 'Phone' : 'Phone',
        tokenHash: digest(credential), pairedAt: now(), lastSeenAt: now(),
        ...(previous?.permissions ? { permissions: { ...previous.permissions } } : {}) };
      commit([...remaining, device]);
      invitation = null;
      if (previous) listeners.forEach((listener) => listener(previous.id));
      return { token: credential, deviceId: device.id };
    },
    authenticate(token) {
      if (typeof token !== 'string' || !token || token.length > 256) return null;
      const hash = digest(token);
      const device = devices.find((entry) => entry.tokenHash === hash);
      if (!device) return null;
      const idle = idleFor(device);
      if (idle > INACTIVE_EXPIRY_MS) {
        try { commit(devices.filter((entry) => entry.id !== device.id)); }
        catch (err) { console.error('[Devices] Could not remove expired device:', err.message); }
        listeners.forEach((listener) => listener(device.id));
        return null;
      }
      if (idle > ACTIVITY_WRITE_MS) {
        try { commit(devices.map((entry) => (entry.id === device.id ? { ...entry, lastSeenAt: now() } : entry))); }
        catch (err) { console.error('[Devices] Could not record device activity:', err.message); }
      }
      return device.id;
    },
    allows(id, capability = 'access') {
      const device = devices.find(device => device.id === id);
      return !!device && permissions(device).access && permissions(device)[capability] === true;
    },
    updatePermissions(id, patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.entries(patch).some(([key, value]) => !['view', 'write', 'access'].includes(key) || typeof value !== 'boolean')) throw new Error('Invalid device permissions');
      if (!devices.some(device => device.id === id)) throw new Error('Device no longer paired');
      commit(devices.map(device => device.id === id ? { ...device, permissions: { ...permissions(device), ...patch } } : device));
      changeListeners.forEach(listener => listener(id));
      return true;
    },
    onChange(listener) { changeListeners.push(listener); },
    applyReview(review, saveSettings) {
      if (!Array.isArray(review) || review.length !== devices.length
        || new Set(review.map(row => row?.id)).size !== devices.length) throw new Error('Device list changed. Reopen the review.');
      const next = devices.flatMap(device => {
        const row = review.find(row => row?.id === device.id);
        if (!row || typeof row.keep !== 'boolean' || !row.permissions || !row.originalPermissions
          || ['access', 'view', 'write'].some(key => typeof row.permissions[key] !== 'boolean'
            || row.originalPermissions[key] !== permissions(device)[key])) throw new Error('Device permissions changed. Reopen the review.');
        return row.keep ? [{ ...device, permissions: { access: row.permissions.access, view: row.permissions.view, write: row.permissions.write } }] : [];
      });
      const previous = devices;
      commit(next);
      try { saveSettings(); }
      catch (err) { commit(previous); throw err; }
      invitation = null;
      for (const device of previous) {
        if (!next.some(row => row.id === device.id)) listeners.forEach(listener => listener(device.id));
        else changeListeners.forEach(listener => listener(device.id));
      }
    },
    has: (id) => devices.some((device) => device.id === id),
    list: () => devices.map(({ tokenHash, ...device }) => ({ ...device, permissions: permissions(device) })),
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
