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

// Publish only a completely verified copy. A failed migration leaves the
// original data untouched and cannot masquerade as a completed migration.
function migrateData(legacy, target) {
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), 'quickclip-migration-'));
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
  return target;
}

module.exports = { atomicJSON, migrateData };
