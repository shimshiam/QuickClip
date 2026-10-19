'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const { atomicJSON } = require('./storage');
const { createPolicy } = require('./settings');
const { assertSafeFile } = require('./file-safety');

/**
 * QuickClip – File Storage Manager
 *
 * Manages received files in `<dataDir>/received/` and maintains a JSON index
 * for quick lookups.
 */

/**
 * Create a new file-manager instance.
 *
 * @param {string} dataDir – Absolute path to the application data directory
 * @returns {{ saveFile, getFile, listFiles, deleteFile, openFile, revealFile }}
 */
function createFileManager(dataDir, policy = createPolicy()) {
  const receivedDir = path.join(dataDir, 'received');
  const indexPath   = path.join(receivedDir, 'index.json');

  // Ensure the target directory exists
  try {
    fs.mkdirSync(receivedDir, { recursive: true });
  } catch (err) {
    console.error('[FileManager] Failed to create received directory:', err.message);
  }

  // ── Index persistence ─────────────────────────────────────────────────────

  /**
   * Load the file index from disk.
   * @returns {Array<{ id: string, name: string, path: string, size: number, timestamp: number }>}
   */
  function loadIndex() {
    try {
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[FileManager] Failed to load index:', err.message);
    }
    return [];
  }

  /**
   * Save the file index to disk.
   * @param {object[]} index
   */
  function saveIndex(index) {
    try {
      atomicJSON(indexPath, index);
    } catch (err) {
      console.error('[FileManager] Failed to save index:', err.message);
      throw err;
    }
  }

  let index = loadIndex();

  function publish(entry) {
    const nextIndex = [...index, entry];
    try { saveIndex(nextIndex); }
    catch (err) {
      // Do not leave an unlisted copy consuming quota after a failed commit.
      try { fs.unlinkSync(entry.path); } catch (_) { /* preserve the original error */ }
      throw err;
    }
    index = nextIndex;
  }

  // ── Helpers & Path Validation ─────────────────────────────────────────────

  /**
   * Sanitize filename to prevent path traversal and reserved Windows names.
   * @param {string} originalName
   * @returns {string}
   */
  function sanitizeFileName(originalName) {
    let name = path.basename(originalName || 'unnamed_file');
    // Strip null bytes and dangerous control/special characters
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    // Prevent leading dots or trailing spaces/dots
    name = name.replace(/^[.]+/, '_').replace(/[. ]+$/, '');
    if (!name) name = 'unnamed_file';
    // Check against Windows reserved device names (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
    const baseWithoutExt = name.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseWithoutExt)) {
      name = `_${name}`;
    }
    return name;
  }

  /**
   * Verify that a file path is safely confined within receivedDir.
   * @param {string} filePath
   * @returns {boolean}
   */
  function isSafePath(filePath) {
    if (!filePath) return false;
    const resolved = path.resolve(filePath);
    const targetDir = path.resolve(receivedDir);
    return resolved.startsWith(targetDir + path.sep) || resolved === targetDir;
  }

  let reservedBytes = 0;
  function assertCapacity(bytes = 0) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid file size');
    let total = 0;
    for (const directory of [receivedDir, path.join(dataDir, 'tmp')]) {
      if (!fs.existsSync(directory)) continue;
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isFile()) total += fs.statSync(path.join(directory, item.name)).size;
      }
    }
    if (total + reservedBytes + bytes > policy.get().storageQuotaMB * 1024 * 1024) throw new Error('Shared storage quota reached; delete saved files on Windows');
    const disk = fs.statfsSync(receivedDir);
    if (disk.bavail * disk.bsize < reservedBytes + bytes + 256 * 1024 * 1024) throw new Error('Not enough free disk space; keep at least 256 MB free');
  }
  function reserveCapacity(bytes) {
    assertCapacity(bytes); reservedBytes += bytes;
    let released = false;
    return () => { if (!released) { released = true; reservedBytes -= bytes; } };
  }
  function isShared(entry) {
    return Number.isFinite(entry.timestamp) && entry.timestamp + policy.get().fileTtlHours * 3600000 > Date.now();
  }
  function sharedFile(id) {
    const entry = index.find((entry) => entry.id === id);
    return entry && isShared(entry) ? getFile(id) : null;
  }

  // ── Public methods ────────────────────────────────────────────────────────

  /**
   * Save an incoming file buffer to the received directory.
   *
   * @param {Buffer} buffer       – Raw file content
   * @param {string} originalName – Original filename from the sender
   * @returns {{ id: string, name: string, path: string, size: number }}
   */
  function saveFile(buffer, originalName) {
    assertSafeFile(originalName);
    assertCapacity(buffer.length);
    const id = crypto.randomUUID();
    const safeName = sanitizeFileName(originalName);
    const fileName = `${id}_${safeName}`;
    const fullPath = path.join(receivedDir, fileName);

    try {
      fs.writeFileSync(fullPath, buffer);
    } catch (err) {
      console.error('[FileManager] Failed to write file:', err.message);
      throw err;
    }

    const entry = {
      id,
      name: safeName,
      path: fullPath,
      size: buffer.length,
      timestamp: Date.now(),
    };

    publish(entry);

    console.log(`[FileManager] Saved file: ${safeName} (${buffer.length} bytes)`);
    return { id, name: safeName, path: fullPath, size: buffer.length };
  }

  /**
   * Save a file moved from a temporary path (for diskStorage streaming).
   *
   * @param {string} tmpPath        – Path to the temporary uploaded file
   * @param {string} originalName – Original filename from the sender
   * @param {number} size         – File size in bytes
   * @returns {{ id: string, name: string, path: string, size: number }}
   */
  function saveFileFromPath(tmpPath, originalName, size = 0) {
    assertSafeFile(originalName);
    assertCapacity();
    const id = crypto.randomUUID();
    const safeName = sanitizeFileName(originalName);
    const fileName = `${id}_${safeName}`;
    const fullPath = path.join(receivedDir, fileName);

    try {
      try {
        fs.renameSync(tmpPath, fullPath);
      } catch (renameErr) {
        // Fallback if tmpPath is on a different filesystem partition
        if (renameErr.code === 'EXDEV') {
          fs.copyFileSync(tmpPath, fullPath);
          fs.unlinkSync(tmpPath);
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      console.error('[FileManager] Failed to move file from tmp:', err.message);
      throw err;
    }

    let actualSize = size;
    try {
      if (!actualSize) actualSize = fs.statSync(fullPath).size;
    } catch (_) { /* ok */ }

    const entry = {
      id,
      name: safeName,
      path: fullPath,
      size: actualSize,
      timestamp: Date.now(),
    };

    publish(entry);

    console.log(`[FileManager] Saved file from path: ${safeName} (${actualSize} bytes)`);
    return { id, name: safeName, path: fullPath, size: actualSize };
  }

  /**
   * Copy and index an existing local PC file (shared from Desktop to mobile).
   *
   * @param {string} sourcePath – Absolute path to the local file on Windows
   * @returns {{ id: string, name: string, path: string, size: number }}
   */
  function saveDesktopFile(sourcePath) {
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('Invalid file path');
    }
    const originalName = path.basename(sourcePath);
    assertSafeFile(originalName);
    assertCapacity(fs.statSync(sourcePath).size);
    const id = crypto.randomUUID();
    const safeName = sanitizeFileName(originalName);
    const fileName = `${id}_${safeName}`;
    const fullPath = path.join(receivedDir, fileName);

    try {
      fs.copyFileSync(sourcePath, fullPath);
    } catch (err) {
      console.error('[FileManager] Failed to copy desktop file:', err.message);
      throw err;
    }

    let actualSize = 0;
    try {
      actualSize = fs.statSync(fullPath).size;
    } catch (_) { /* ok */ }

    const entry = {
      id,
      name: safeName,
      path: fullPath,
      size: actualSize,
      timestamp: Date.now(),
    };

    publish(entry);

    console.log(`[FileManager] Saved desktop file: ${safeName} (${actualSize} bytes)`);
    return { id, name: safeName, path: fullPath, size: actualSize };
  }

  /**
   * Look up a file by its ID.
   *
   * @param {string} id
   * @returns {{ name: string, path: string, size: number } | null}
   */
  function getFile(id) {
    const entry = index.find((e) => e.id === id);
    if (!entry || !isSafePath(entry.path) || !fs.existsSync(entry.path)) return null;
    return { name: entry.name, path: entry.path, size: entry.size };
  }

  /**
   * List all stored files.
   * @returns {object[]}
   */
  function listFiles() {
    return index.map((entry) => ({ ...entry, available: isSafePath(entry.path) && fs.existsSync(entry.path) }));
  }

  /**
   * Delete a file from disk and remove its index entry.
   * @param {string} id
   * @returns {boolean} true if deleted, false if not found
   */
  function deleteFile(id) {
    const entryIdx = index.findIndex((e) => e.id === id);
    if (entryIdx === -1) return false;

    const entry = index[entryIdx];
    if (isSafePath(entry.path)) {
      try {
        if (fs.existsSync(entry.path)) {
          fs.unlinkSync(entry.path);
        }
      } catch (err) {
        console.error('[FileManager] Failed to delete file from disk:', err.message);
        throw err;
      }
    } else {
      console.warn('[FileManager] Refusing to delete path outside receivedDir:', entry.path);
    }

    const nextIndex = index.filter((_, i) => i !== entryIdx);
    saveIndex(nextIndex);
    index = nextIndex;
    console.log(`[FileManager] Deleted file: ${entry.name}`);
    return true;
  }

  /**
   * Open a file with the system's default application.
   * @param {string} id
   */
  async function openFile(id) {
    const entry = index.find((e) => e.id === id);
    if (!entry || !isSafePath(entry.path)) {
      console.warn('[FileManager] openFile: not found or unsafe path', id);
      return;
    }
    try {
      assertSafeFile(entry.name);
      const error = await shell.openPath(entry.path);
      if (error) throw new Error(error);
    } catch (err) {
      console.error('[FileManager] Failed to open file:', err.message);
      throw err;
    }
  }

  /**
   * Reveal a file in the system file explorer.
   * @param {string} id
   */
  function revealFile(id) {
    const entry = index.find((e) => e.id === id);
    if (!entry || !isSafePath(entry.path)) {
      console.warn('[FileManager] revealFile: not found or unsafe path', id);
      return;
    }
    try {
      shell.showItemInFolder(entry.path);
    } catch (err) {
      console.error('[FileManager] Failed to reveal file:', err.message);
    }
  }

  // ── Return public interface ───────────────────────────────────────────────
  return {
    assertCapacity,
    reserveCapacity,
    sharedFile,
    listSharedFiles: () => listFiles().filter(isShared),
    saveFile,
    saveFileFromPath,
    saveDesktopFile,
    getFile,
    listFiles,
    deleteFile,
    openFile,
    revealFile,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────────
module.exports = {
  createFileManager,
};
