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
  if (!history.some((item) => item.id === id && item.type === 'image')) return null;
  return path.join(imageDir, `${id}.png`);
}

function removeImages(items) {
  for (const item of items) if (item.type === 'image') {
    try { fs.unlinkSync(path.join(imageDir, `${item.id}.png`)); }
    catch (err) { if (err.code !== 'ENOENT') console.error('[Clipboard] Image cleanup failed:', err.message); }
  }
}

function trimHistory() { removeImages(history.splice(policy.get().maxHistory)); }
function clearHistory() { removeImages(history); history = []; }
function getHistory() { return history.map((item) => ({ ...item })); }
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
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 40000000) throw new Error('Image dimensions exceed 40 megapixels');
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) throw new Error('The received image could not be decoded');
  const { width, height } = img.getSize();
  if (width * height > 40000000) throw new Error('Image dimensions exceed 40 megapixels');
  const png = img.toPNG();
  if (png.length > policy.get().maxImageBytes) throw new Error('Decoded image exceeds the clipboard size limit');
  return { img, png };
}

function poll() {
  try {
    const text = clipboard.readText();
    const textHash = text ? hash(text) : '';
    if (textHash !== lastText) {
      lastText = textHash;
      if (text && policy.allows('text') && Buffer.byteLength(text) <= policy.get().maxTextBytes) notify(record('text', text, 'local'));
    }
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) { lastImage = ''; return; }
    const png = img.toPNG();
    const imageHash = hash(png);
    if (imageHash === lastImage) return;
    lastImage = imageHash;
    if (policy.allows('image') && png.length <= policy.get().maxImageBytes && img.getSize().width * img.getSize().height <= 40000000) {
      notify(record('image', png, 'local', img));
    }
  } catch (err) { console.error('[Clipboard] Poll failed:', err.message); }
}

function seed() {
  const text = clipboard.readText();
  lastText = text ? hash(text) : '';
  const img = clipboard.readImage();
  lastImage = img && !img.isEmpty() ? hash(img.toPNG()) : '';
}

function startMonitoring() { if (!timer) { seed(); timer = setInterval(poll, 500); } }
function stopMonitoring() { clearInterval(timer); timer = null; }

function writeToClipboard(item, source = 'remote') {
  try {
    if (source === 'remote') policy.assert(item.type);
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
      if (actual.isEmpty() || hash(actual.toBitmap()) !== hash(img.toBitmap())) throw new Error('Windows did not retain the clipboard image');
    } else throw new Error('Unsupported clipboard type');
    // Track both formats instead of suppressing every change for one second.
    seed();
    const entry = record(item.type, value, source, img);
    notify(entry);
    return { ok: true, id: entry.id };
  } catch (err) { return { ok: false, error: err.message }; }
}

function copyHistoryItem(id) {
  const item = history.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: 'This history item has expired' };
  try {
    const content = item.type === 'image' ? fs.readFileSync(getImagePath(id)) : item.content;
    return writeToClipboard({ type: item.type, content }, 'local');
  } catch (_) { return { ok: false, error: 'The clipboard image is no longer available' }; }
}

module.exports = { configure, getImagePath, trimHistory, startMonitoring, stopMonitoring,
  getHistory, clearHistory, writeToClipboard, copyHistoryItem,
  onClipboardChange: (callback) => callbacks.push(callback) };
