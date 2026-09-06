'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const { createPolicy, DEFAULTS } = require('./settings');
const { attachTransferHandler, createReceiptCache } = require('./transfer');
const { createUploadStorage } = require('./upload-storage');

const clients = new Set();
const connectCallbacks = [];
const disconnectCallbacks = [];
const fileCallbacks = [];
let activePolicy = createPolicy();

function safeTokenMatch(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string' || !input || !expected) return false;
  const a = Buffer.from(input), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicFile = ({ id, name, size, timestamp, available = true }) => ({ id, name, size, timestamp, available });
const deviceInfo = ({ id, address, connectedAt }) => ({ id, address, connectedAt });
function notify(callbacks, value) { for (const cb of callbacks) { try { cb(value); } catch (err) { console.error(err.message); } } }

function createServer(certData, options) {
  const { port = 8443, token, dataDir, fileManager, getHistoryFn = () => [],
    writeToClipboardFn, getImagePathFn = () => null, policy = createPolicy(),
    hostnames = ['localhost', '127.0.0.1'] } = options;
  activePolicy = policy;
  const app = express();
  const receipts = createReceiptCache();
  const tickets = new Map();
  const allowedHosts = new Set(hostnames);

  function trustedRequest(req) {
    try {
      const host = new URL(`https://${req.headers.host}`);
      if (!allowedHosts.has(host.hostname) || Number(host.port || 443) !== req.socket.localPort) return false;
      return !req.headers.origin || req.headers.origin === host.origin;
    } catch (_) { return false; }
  }
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!trustedRequest(req)) return res.status(403).json({ error: 'Origin or host is not allowed' });
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.vary('Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ') && safeTokenMatch(header.slice(7), token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  }
  function allowFiles(_req, res, next) {
    try { policy.assert('file'); next(); }
    catch (err) { res.status(403).json({ error: err.message }); }
  }
  function sendStoredFile(res, file, image = false) {
    if (!file) return res.status(404).json({ error: 'This item is no longer available' });
    if (image) res.type('png');
    else res.attachment(file.name);
    res.sendFile(file.path, (err) => {
      if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'File is no longer available' });
      else if (err) res.destroy();
    });
  }

  app.use('/', express.static(path.join(__dirname, '..', 'pwa'), { etag: true, maxAge: 0 }));
  app.get('/ca.crt', (_req, res) => res.download(certData.caPath, 'ca.crt'));
  app.get('/api/status', authenticate, (_req, res) => res.json({ connected: clients.size > 0, deviceCount: clients.size, settings: policy.get() }));
  app.get('/api/history', authenticate, (_req, res) => res.json(getHistoryFn()));
  app.get('/api/files', authenticate, (_req, res) => res.json(fileManager.listFiles().map(publicFile)));
  app.get('/api/files/:id', authenticate, (req, res) => sendStoredFile(res, fileManager.getFile(req.params.id)));
  app.get('/api/clipboard-images/:id', authenticate, (req, res) => {
    const imagePath = getImagePathFn(req.params.id);
    sendStoredFile(res, imagePath ? { path: imagePath } : null, true);
  });

  // Tickets scope a download URL to one file for 60 seconds. Range requests
  // and Safari retries may reuse it during that interval.
  app.post('/api/download-ticket', authenticate, express.json({ limit: '4kb' }), (req, res) => {
    const { id, kind } = req.body || {};
    if (typeof id !== 'string' || !['file', 'image'].includes(kind)) return res.status(400).json({ error: 'Invalid download request' });
    const exists = kind === 'file' ? fileManager.getFile(id) : getImagePathFn(id);
    if (!exists) return res.status(404).json({ error: 'This item has expired' });
    for (const [key, item] of tickets) if (item.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 1000) return res.status(429).json({ error: 'Too many downloads; try again shortly' });
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, { id, kind, expires: Date.now() + 60000 });
    res.json({ url: `/api/download/${ticket}` });
  });
  app.get('/api/download/:ticket', (req, res) => {
    const item = tickets.get(req.params.ticket);
    if (!item || item.expires <= Date.now()) {
      tickets.delete(req.params.ticket);
      return res.status(401).json({ error: 'Download link expired; tap Save again' });
    }
    const imagePath = item.kind === 'image' ? getImagePathFn(item.id) : null;
    sendStoredFile(res, item.kind === 'image' ? (imagePath ? { path: imagePath } : null) : fileManager.getFile(item.id), item.kind === 'image');
  });

  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ storage: createUploadStorage(tmpDir),
    limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 0, parts: 2 } });
  app.post('/api/upload', authenticate, allowFiles, upload.single('file'), (req, res, next) => {
    try {
      policy.assert('file'); // Settings can change while an upload is in progress.
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      const result = fileManager.saveFileFromPath(req.file.path, req.file.originalname, req.file.size);
      broadcastFileAvailable(result);
      notify(fileCallbacks, result);
      res.json(publicFile(result));
    } catch (err) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) { /* already moved */ } }
      if (!policy.allows('file')) return res.status(403).json({ error: policy.get().paused ? 'Sync is paused on Windows' : 'File sync is disabled on Windows' });
      next(err);
    }
  });
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 500 MB limit' : 'Choose one file per upload' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request' });
    console.error('[Server]', err.message);
    res.status(500).json({ error: 'Operation failed; check Windows and retry' });
  });

  const httpsServer = https.createServer({ cert: certData.cert, key: certData.key, ca: certData.ca }, app);
  const wss = new WebSocket.Server({ server: httpsServer, maxPayload: DEFAULTS.maxImageBytes,
    verifyClient: ({ req }, done) => done(trustedRequest(req), 403, 'Origin or host is not allowed') });
  wss.on('connection', (ws, req) => {
    ws.on('error', (err) => console.error('[WebSocket]', err.message));
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (!safeTokenMatch(url.searchParams.get('token'), token)) { ws.close(4001, 'Unauthorized'); return; }
    const client = { ws, id: crypto.randomUUID(), address: req.socket.remoteAddress, connectedAt: Date.now() };
    clients.add(client);
    notify(connectCallbacks, deviceInfo(client));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    attachTransferHandler(ws, { policy, receipts, write: writeToClipboardFn });
    ws.send(JSON.stringify({ type: 'settings', settings: policy.get() }));
    const remove = () => { if (clients.delete(client)) notify(disconnectCallbacks, deviceInfo(client)); };
    ws.on('close', remove);
    ws.on('error', remove);
  });
  const keepalive = setInterval(() => {
    for (const client of clients) {
      if (!client.ws.isAlive) { client.ws.terminate(); continue; }
      client.ws.isAlive = false; client.ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(keepalive));
  httpsServer.listen(port, '0.0.0.0', () => console.log(`[Server] Listening on port ${httpsServer.address().port}`));
  httpsServer.on('error', (err) => console.error('[Server]', err.message));
  return { httpsServer, wss, app };
}

function broadcastRaw(data, excludeWs) {
  for (const client of clients) if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
    // Bound per-client queued data so a sleeping phone cannot grow memory indefinitely.
    if (client.ws.bufferedAmount > 2 * 1024 * 1024) { client.ws.close(1013, 'Reconnect to refresh history'); continue; }
    client.ws.send(data);
  }
}
function broadcastClipboard(item) {
  if (!activePolicy.allows(item.type)) return;
  // Images travel as metadata/thumbnail; full bytes are fetched only for Copy.
  broadcastRaw(JSON.stringify({ ...item, type: item.type === 'image' ? 'clipboard-image-available' : 'clipboard-text' }));
}
function broadcastFileAvailable(file) {
  if (activePolicy.allows('file')) broadcastRaw(JSON.stringify({ type: 'file-available', ...publicFile(file) }));
}
function broadcastSettings() { broadcastRaw(JSON.stringify({ type: 'settings', settings: activePolicy.get() })); }
module.exports = { createServer, broadcastRaw, broadcastClipboard, broadcastFileAvailable, broadcastSettings,
  getConnectedDevices: () => Array.from(clients, deviceInfo),
  onDeviceConnect: (cb) => connectCallbacks.push(cb),
  onDeviceDisconnect: (cb) => disconnectCallbacks.push(cb),
  onFileReceived: (cb) => fileCallbacks.push(cb) };
