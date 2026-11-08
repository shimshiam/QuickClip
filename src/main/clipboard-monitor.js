'use strict';

const { clipboard, nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPolicy } = require('./settings');
const { imageSize } = require('./image-size');

let policy = createPolicy();
let imageDir;
let history = [];
let timer;
let lastText = '';
let lastImage = '';
const callbacks = [];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const MAX_IMAGE_PIXELS = 40000000;

function imageFingerprint(img) {
  const { width, height } = img.getSize();
  // Hash raw pixels without encoding PNG; do not retain the bitmap copy.
  return `${width}x${height}:${hash(img.toBitmap())}`;
}

// Password managers (KeePass, 1Password, Bitwarden, ...) tag secrets with these
// registered Windows clipboard formats so clipboard history, cloud sync and
// monitors skip them. QuickClip honours the same opt-outs before syncing.
const EXCLUDE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'];
const OPT_OUT_FORMATS = ['CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']; // DWORD 0 = do not share

function isPrivateClipboard() {
  if (typeof clipboard.has !== 'function') return false;
  try {
    if (EXCLUDE_FORMATS.some((format) => clipboard.has(format))) return true;
    return OPT_OUT_FORMATS.some((format) => {
      if (!clipboard.has(format)) return false;
      const value = clipboard.readBuffer(format);
      return value.length >= 4 && value.readUInt32LE(0) === 0;
    });
  } catch (err) {
    // If the markers cannot be read, skip this change rather than risk leaking a secret.
    console.error('[Clipboard] Could not read privacy formats:', err.message);
    return true;
  }
}

function readImageState() {
  if (!policy.allows('image')) return { fingerprint: null };
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return { fingerprint: '' };
  const { width, height } = img.getSize();
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) return { fingerprint: 'oversized' };
  return { img, fingerprint: imageFingerprint(img) };
}

function configure({ dataDir, syncPolicy }) {
  policy = syncPolicy;
  imageDir = path.join(dataDir, 'clipboard-images');
  fs.mkdirSync(imageDir, { recursive: true });
  // History is session-only. Only app-generated orphan images are removed.
  for (const name of fs.readdirSync(imageDir)) {
    if (/^[0-9a-f-]{36}\.png$/.test(name)) fs.unlinkSync(path.join(imageDir, name));
  }
}

function getImagePath(id) {
  expireHistory();
  if (!history.some((item) => item.id === id && item.type === 'image')) return null;
  return path.join(imageDir, `${id}.png`);
}

function removeImages(items) {
  for (const item of items) if (item.type === 'image') {
    try { fs.unlinkSync(path.join(imageDir, `${item.id}.png`)); }
    catch (err) { if (err.code !== 'ENOENT') console.error('[Clipboard] Image cleanup failed:', err.message); }
  }
}

function expireHistory() {
  const cutoff = Date.now() - policy.get().clipboardTtlMinutes * 60000;
  removeImages(history.filter((item) => item.timestamp <= cutoff));
  history = history.filter((item) => item.timestamp > cutoff);
}
function trimHistory() { expireHistory(); removeImages(history.splice(policy.get().maxHistory)); }
function clearHistory() { removeImages(history); history = []; }
function getHistory() { expireHistory(); return history.map((item) => ({ ...item })); }
function notify(item) { for (const cb of callbacks) { try { cb(item); } catch (err) { console.error(err.message); } } }

function record(type, value, source, img) {
  const item = { id: crypto.randomUUID(), type, source, timestamp: Date.now() };
  if (type === 'text') item.content = value;
  else {
    if (!imageDir) throw new Error('Clipboard storage is not ready');
    const size = img.getSize();
    const scale = Math.min(1, 100 / Math.max(size.width, size.height));
    const thumbnail = img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
    item.thumbnail = thumbnail.toDataURL();
    item.size = value.length;
    fs.writeFileSync(path.join(imageDir, `${item.id}.png`), value);
  }
  history.unshift(item);
  trimHistory();
  return item;
}

function validateImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > policy.get().maxImageBytes) throw new Error('Image exceeds the clipboard size limit');
  const dimensions = imageSize(buffer);
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('Image dimensions exceed 40 megapixels');
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) throw new Error('The received image could not be decoded');
  const { width, height } = img.getSize();
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('Image dimensions exceed 40 megapixels');
  const png = img.toPNG();
  if (png.length > policy.get().maxImageBytes) throw new Error('Decoded image exceeds the clipboard size limit');
  return { img, png };
}

function poll() {
  try {
    // Read the clipboard between two privacy checks, then re-read the text. If the
    // clipboard changed while it was being read (e.g. a secret replaced before its
    // markers were checked), nothing is sent; the next poll sees a stable state.
    const privateBefore = isPrivateClipboard();
    const text = clipboard.readText();
    const textHash = text ? hash(text) : '';
    const imageState = readImageState();
    const privateAfter = isPrivateClipboard();
    const textAfter = clipboard.readText();
    const textAfterHash = textAfter ? hash(textAfter) : '';
    if (privateBefore || privateAfter) {
      // Remember what was skipped, so it is not sent once the marker disappears.
      lastText = textAfterHash;
      lastImage = imageState.fingerprint;
      return;
    }
    if (textAfterHash !== textHash) return;
    if (textHash !== lastText) {
      lastText = textHash;
      if (text && policy.allows('text') && Buffer.byteLength(text) <= policy.get().maxTextBytes) notify(record('text', text, 'local'));
    }
    const { img, fingerprint } = imageState;
    const previous = lastImage;
    if (img && previous !== null && fingerprint !== previous) {
      // Confirm the new image is still there and still not private before sending it.
      if (readImageState().fingerprint !== fingerprint || isPrivateClipboard()) return;
    }
    lastImage = fingerprint;
    // Re-enabling sync seeds the current image without sending copies made while disabled.
    if (!img || previous === null || fingerprint === previous) return;
    const png = img.toPNG();
    if (png.length <= policy.get().maxImageBytes) {
      notify(record('image', png, 'local', img));
    }
  } catch (err) { console.error('[Clipboard] Poll failed:', err.message); }
}

function seed() {
  const text = clipboard.readText();
  lastText = text ? hash(text) : '';
  lastImage = readImageState().fingerprint;
}

function startMonitoring() { if (!timer) { seed(); timer = setInterval(poll, 500); } }
function stopMonitoring() { clearInterval(timer); timer = null; }

function writeToClipboard(item, source = 'remote', { fromHistory = false } = {}) {
  try {
    if (source === 'remote' && !fromHistory) policy.assert(item.type);
    let value = item.content;
    let img;
    if (item.type === 'text') {
      if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > policy.get().maxTextBytes) throw new Error('Text is empty or exceeds the size limit');
      clipboard.writeText(value);
      if (clipboard.readText() !== value) throw new Error('Windows did not retain the clipboard text');
    } else if (item.type === 'image') {
      const decoded = validateImage(value);
      img = decoded.img; value = decoded.png;
      clipboard.writeImage(img);
      const actual = clipboard.readImage();
      if (actual.isEmpty() || imageFingerprint(actual) !== imageFingerprint(img)) throw new Error('Windows did not retain the clipboard image');
    } else throw new Error('Unsupported clipboard type');
    // Track both formats instead of suppressing every change for one second.
    seed();
    // History copies only restore the clipboard; they are not new history events.
    if (fromHistory) return { ok: true, id: item.id };
    const entry = record(item.type, value, source, img);
    notify(entry);
    return { ok: true, id: entry.id };
  } catch (err) { return { ok: false, error: err.message }; }
}

function copyHistoryItem(id) {
  expireHistory();
  const item = history.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: 'This history item has expired' };
  try {
    const content = item.type === 'image' ? fs.readFileSync(getImagePath(id)) : item.content;
    // Re-copying received content must not turn it into an outbound local update.
    return writeToClipboard({ id: item.id, type: item.type, content }, item.source, { fromHistory: true });
  } catch (_) { return { ok: false, error: 'The clipboard image is no longer available' }; }
}

module.exports = { configure, getImagePath, trimHistory, startMonitoring, stopMonitoring,
  getHistory, clearHistory, writeToClipboard, copyHistoryItem,
  onClipboardChange: (callback) => callbacks.push(callback) };
