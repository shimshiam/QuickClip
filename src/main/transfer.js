'use strict';

const crypto = require('crypto');
const ID = /^[A-Za-z0-9_-]{1,80}$/;

// Shared across sockets so a retry after reconnect is acknowledged without
// overwriting a newer clipboard. Entries expire and memory use is bounded.
function createReceiptCache(now = Date.now) {
  const entries = new Map();
  return {
    get(id) {
      for (const [key, value] of entries) if (value.expires <= now()) entries.delete(key);
      return entries.get(id);
    },
    set(id, fingerprint) {
      entries.delete(id);
      entries.set(id, { fingerprint, expires: now() + 10 * 60 * 1000 });
      while (entries.size > 1000) entries.delete(entries.keys().next().value);
    },
  };
}

function attachTransferHandler(ws, { policy, write, receipts, imageTimeout = 15000 }) {
  let pending = null;
  const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  const reset = () => { if (pending) clearTimeout(pending.timer); pending = null; };
  const fail = (id, error) => send({ type: 'transfer-result', id: id || null, ok: false, error });
  const deliver = (id, type, content) => {
    const fingerprint = crypto.createHash('sha256').update(type).update(content).digest('hex');
    const previous = receipts.get(id);
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Transfer ID already used for different content');
    if (!previous) {
      policy.assert(type);
      const result = write({ type, content });
      if (!result || result.ok !== true) throw new Error(result?.error || 'Windows could not write the clipboard');
      receipts.set(id, fingerprint);
    }
    send({ type: 'transfer-result', id, ok: true });
  };

  ws.on('message', (data, isBinary) => {
    let id;
    try {
      if (isBinary) {
        const meta = pending;
        reset();
        if (!meta) throw new Error('Image metadata must arrive before image data');
        id = meta.id;
        if (data.length !== meta.size || data.length > policy.get().maxImageBytes) throw new Error('Image size does not match its metadata');
        deliver(id, 'image', Buffer.from(data));
        return;
      }
      // ws supplies Buffers for JSON too. The frame flag, not Buffer.isBuffer,
      // determines whether the content is binary.
      if (data.length > policy.get().maxTextBytes * 6 + 1024) throw new Error('Message is too large');
      const msg = JSON.parse(data.toString());
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid message');
      if (msg.type === 'ping') { send({ type: 'pong' }); return; }
      if (typeof msg.id !== 'string' || !ID.test(msg.id)) throw new Error('A valid transfer ID is required; reload QuickClip on your phone');
      id = msg.id;
      if (pending) throw new Error('Finish the current image transfer first');
      if (msg.type === 'clipboard-text') {
        if (typeof msg.content !== 'string' || msg.content.length === 0) throw new Error('Text is empty or invalid');
        if (Buffer.byteLength(msg.content) > policy.get().maxTextBytes) throw new Error('Text exceeds the clipboard size limit');
        deliver(id, 'text', msg.content);
      } else if (msg.type === 'clipboard-image') {
        policy.assert('image');
        if (!Number.isInteger(msg.size) || msg.size < 1 || msg.size > policy.get().maxImageBytes) throw new Error('Image exceeds the clipboard size limit');
        pending = { id, size: msg.size, timer: setTimeout(() => {
          reset(); fail(id, 'Image transfer expired; retry');
        }, imageTimeout) };
      } else throw new Error('Unsupported message type');
    } catch (err) {
      fail(id, err instanceof SyntaxError ? 'Invalid JSON message' : err.message);
    }
  });
  ws.on('close', reset);
  ws.on('error', reset);
}

module.exports = { attachTransferHandler, createReceiptCache };
