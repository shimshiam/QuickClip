'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicJSON(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function digest(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

const STAGING = /^quickclip-migration-[A-Za-z0-9]{6}$/;

// Remove a path without following a link out of it.
function removeEntry(entry) {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) {
    try { fs.unlinkSync(entry); } catch (_) { fs.rmdirSync(entry); }
  } else {
    fs.rmSync(entry, { recursive: true, force: true });
  }
}

// Staging folders from an interrupted migration can hold a copy of the CA key.
function removeStaleStaging(parent) {
  let names;
  try { names = fs.existsSync(parent) ? fs.readdirSync(parent) : []; }
  catch (err) { console.error('[Storage] Could not check for stale migration folders:', err.message); return; }
  for (const name of names) {
    if (!STAGING.test(name)) continue;
    try { removeEntry(path.join(parent, name)); }
    catch (err) { console.error('[Storage] Could not remove stale migration folder:', err.message); }
  }
}

// Publish only a completely verified copy. A failed migration leaves the
// original data untouched and cannot masquerade as a completed migration.
function migrateData(legacy, target) {
  removeStaleStaging(path.dirname(target));
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), 'quickclip-migration-'));
  try {
    stageMigration(legacy, target, staging);
  } catch (err) {
    // Never leave a half-copied folder (possibly holding ca.key) behind.
    try { removeEntry(staging); } catch (_) { /* reported on next start */ }
    throw err;
  }
  return target;
}

function stageMigration(legacy, target, staging) {
  function copy(from, to) {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('Migration cannot copy symbolic links');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
    } else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (digest(from) !== digest(to)) throw new Error('Migration file verification failed');
    }
  }
  for (const name of ['config.json', 'certs', 'received']) {
    const from = path.join(legacy, name);
    if (fs.existsSync(from)) copy(from, path.join(staging, name));
  }
  const indexFile = path.join(staging, 'received', 'index.json');
  const missingFileIds = [];
  if (fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!Array.isArray(index)) throw new Error('Invalid received file index');
    for (const entry of index) {
      const name = path.basename(entry.path);
      if (!fs.existsSync(path.join(staging, 'received', name))) missingFileIds.push(entry.id);
      entry.path = path.join(target, 'received', name);
    }
    atomicJSON(indexFile, index);
  }
  atomicJSON(path.join(staging, 'migration.json'), { version: 1, completedAt: Date.now(), missingFileIds });
  fs.renameSync(staging, target);
}

// The legacy folder sits beside the app with the parent folder's (often shared)
// permissions. After migration the runtime copy is the only one QuickClip reads,
// so a leftover CA key is pure exposure: remove it instead of leaving it behind.
function retireLegacyCertificates(legacy, target) {
  if (!fs.existsSync(path.join(target, 'migration.json'))) return false;
  const certs = path.join(legacy, 'certs');
  let stat;
  try { stat = fs.lstatSync(certs); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  // Never follow a link out of the legacy folder; remove only the link itself.
  if (stat) removeEntry(certs);
  if (fs.existsSync(certs)) throw new Error('Legacy certificate folder could not be removed');
  return true;
}

module.exports = { atomicJSON, migrateData, retireLegacyCertificates };
