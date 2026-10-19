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
const { createDeviceStore } = require('./devices');
const { assertSafeFile } = require('./file-safety');

const clients = new Set();
const connectCallbacks = [];
const disconnectCallbacks = [];
const fileCallbacks = [];
let activePolicy = createPolicy();

const publicFile = ({ id, name, size, timestamp, available = true }) => ({ id, name, size, timestamp, available });
const deviceInfo = ({ id, deviceId, address, connectedAt }) => ({ id, deviceId, address, connectedAt });
function notify(callbacks, value) { for (const cb of callbacks) { try { cb(value); } catch (err) { console.error(err.message); } } }

function createServer(certData, options) {
  const { port = 8443, dataDir, fileManager, getHistoryFn = () => [],
    writeToClipboardFn, getImagePathFn = () => null, policy = createPolicy(),
    hostnames = ['localhost', '127.0.0.1'] } = options;
  activePolicy = policy;
  const app = express();
  const receipts = createReceiptCache();
  const tickets = new Map();
  const devices = options.devices || createDeviceStore(dataDir);
  const activeRequests = new Map();
  let uploads = 0;
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
    const websocketOrigin = `wss://${new URL(`https://${req.headers.host}`).host}`;
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'",
      "img-src 'self' data: blob:", "font-src 'self'", `connect-src 'self' ${websocketOrigin}`,
      "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
      "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Frame-Options', 'DENY');
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
    if (!policy.get().remoteAccess) return res.status(403).json({ error: 'Remote access is blocked on Windows' });
    const header = req.headers.authorization || '';
    const deviceId = header.startsWith('Bearer ') && devices.authenticate(header.slice(7));
    if (deviceId && !devices.allows(deviceId)) return res.status(403).json({ error: 'Device access is disabled on Windows' });
    if (deviceId) { req.deviceId = deviceId; trackRequest(req, res, deviceId); return next(); }
    res.status(401).json({ error: 'Unauthorized' });
  }
  function trackRequest(req, res, deviceId, capability = 'access') {
    activeRequests.set(req, { res, deviceId, capability });
    res.once('close', () => activeRequests.delete(req));
  }
  function deviceSettings(id) {
    const settings = policy.get();
    const write = devices.allows(id, 'write');
    return { ...settings, canView: devices.allows(id, 'view'), syncText: settings.syncText && write, syncImages: settings.syncImages && write,
      syncFiles: settings.syncFiles && write };
  }
  function allowedDevice(id) { return policy.get().remoteAccess && devices.allows(id); }
  function enforceAccess(id = null, permissionsChanged = false) {
    for (const client of clients) if (client.owner === httpsServer) {
      if (allowedDevice(client.deviceId)) {
        if (id === client.deviceId && client.ws.readyState === WebSocket.OPEN) {
          if (!devices.allows(id, 'write')) client.cancelTransfer();
          client.ws.send(JSON.stringify({ type: 'settings', settings: client.settings() }));
        }
        continue;
      }
      clients.delete(client);
      notify(disconnectCallbacks, deviceInfo(client));
      client.ws.close(permissionsChanged ? (allowedDevice(client.deviceId) ? 4004 : 4003) : (policy.get().remoteAccess ? 4001 : 4003), 'Access changed');
      const timer = setTimeout(() => client.ws.terminate(), 1000); timer.unref();
    }
    for (const [req, entry] of activeRequests) if (!allowedDevice(entry.deviceId) || !devices.allows(entry.deviceId, entry.capability)) {
      req.destroy(); entry.res.destroy(); activeRequests.delete(req);
    }
    for (const [key, ticket] of tickets) if (!allowedDevice(ticket.deviceId) || !devices.allows(ticket.deviceId, 'view')) tickets.delete(key);
  }
  devices.onRevoke(enforceAccess);
  devices.onChange(id => enforceAccess(id, true));
  const requirePermission = capability => (req, res, next) => {
    if (!devices.allows(req.deviceId, capability)) return res.status(403).json({ error: capability + ' permission is disabled on Windows' });
    activeRequests.get(req).capability = capability;
    next();
  };
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
  app.post('/api/pair', express.json({ limit: '4kb' }), (req, res, next) => {
    if (!policy.get().remoteAccess) return res.status(403).json({ error: 'Remote access is blocked on Windows' });
    try {
      const result = devices.pair(req.body?.invitation, req.body?.name, req.body?.passcode);
      if (!result) return res.status(401).json({ error: 'Pairing code expired or already used. Generate a new code on Windows.' });
      if (result.passcodeRequired) return res.status(403).json(result);
      res.json(result);
    } catch (err) { next(err); }
  });
  app.get('/api/status', authenticate, (req, res) => res.json({ connected: clients.size > 0, deviceCount: clients.size, settings: deviceSettings(req.deviceId) }));
  app.get('/api/history', authenticate, requirePermission('view'), (_req, res) => res.json(getHistoryFn()));
  app.get('/api/files', authenticate, requirePermission('view'), (_req, res) => res.json(fileManager.listSharedFiles().map(publicFile)));
  app.get('/api/files/:id', authenticate, requirePermission('view'), (req, res) => sendStoredFile(res, fileManager.sharedFile(req.params.id)));
  app.get('/api/clipboard-images/:id', authenticate, requirePermission('view'), (req, res) => {
    const imagePath = getImagePathFn(req.params.id);
    sendStoredFile(res, imagePath ? { path: imagePath } : null, true);
  });

  // Tickets scope a download URL to one file for 60 seconds. Range requests
  // and Safari retries may reuse it during that interval.
  app.post('/api/download-ticket', authenticate, requirePermission('view'), express.json({ limit: '4kb' }), (req, res) => {
    const { id, kind } = req.body || {};
    if (typeof id !== 'string' || !['file', 'image'].includes(kind)) return res.status(400).json({ error: 'Invalid download request' });
    const exists = kind === 'file' ? fileManager.sharedFile(id) : getImagePathFn(id);
    if (!exists) return res.status(404).json({ error: 'This item has expired' });
    for (const [key, item] of tickets) if (item.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 1000) return res.status(429).json({ error: 'Too many downloads; try again shortly' });
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, { id, kind, deviceId: req.deviceId, expires: Date.now() + 60000 });
    res.json({ url: `/api/download/${ticket}` });
  });
  app.get('/api/download/:ticket', (req, res) => {
    const item = tickets.get(req.params.ticket);
    if (!item || item.expires <= Date.now() || (!allowedDevice(item.deviceId) || !devices.allows(item.deviceId, 'view'))) {
      tickets.delete(req.params.ticket);
      return res.status(401).json({ error: 'Download link expired; tap Save again' });
    }
    trackRequest(req, res, item.deviceId, 'view');
    const imagePath = item.kind === 'image' ? getImagePathFn(item.id) : null;
    sendStoredFile(res, item.kind === 'image' ? (imagePath ? { path: imagePath } : null) : fileManager.sharedFile(item.id), item.kind === 'image');
  });

  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  // A crash cannot run upload abort handlers. Only remove our own orphan files.
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name)) {
      fs.unlinkSync(path.join(tmpDir, entry.name));
    }
  }
  function uploadSlot(req, res, next) {
    if (uploads >= 2) return res.status(429).json({ error: 'Two uploads are already in progress; try again shortly' });
    try { fileManager.assertCapacity(); } catch (err) { return res.status(507).json({ error: err.message }); }
    uploads++;
    let released = false;
    const release = () => { if (!released) { released = true; uploads--; } };
    res.once('close', release);
    res.once('finish', release);
    next();
  }
  const upload = multer({ storage: createUploadStorage(tmpDir, fileManager.reserveCapacity),
    fileFilter: (_req, file, done) => { try { assertSafeFile(file.originalname); done(null, true); } catch (err) { done(err); } },
    limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 0, parts: 2 } });
  app.post('/api/upload', authenticate, requirePermission('write'), allowFiles, uploadSlot, upload.single('file'), (req, res, next) => {
    try {
      if (!allowedDevice(req.deviceId) || !devices.allows(req.deviceId, 'write')) throw new Error('Device access was removed');
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
    if (/Unexpected end of (form|file)|Malformed part header|Boundary not found/i.test(err.message)) return res.status(400).json({ error: 'Incomplete or malformed upload; retry the file' });
    if (/quota|disk space/.test(err.message)) return res.status(507).json({ error: err.message });
    if (/blocked for safety|Filename/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('[Server]', err.message);
    res.status(500).json({ error: 'Operation failed; check Windows and retry' });
  });

  const httpsServer = https.createServer({ cert: certData.cert, key: certData.key, ca: certData.ca }, app);
  const wss = new WebSocket.Server({ server: httpsServer, maxPayload: DEFAULTS.maxImageBytes,
    verifyClient: ({ req }, done) => done(trustedRequest(req), 403, 'Origin or host is not allowed') });
  wss.on('connection', (ws, req) => {
    ws.on('error', (err) => console.error('[WebSocket]', err.message));
    const url = new URL(req.url, `https://${req.headers.host}`);
    const deviceId = devices.authenticate(url.searchParams.get('token'));
    if (!deviceId) { ws.close(4001, 'Unauthorized'); return; }
    if (!allowedDevice(deviceId)) { ws.close(4003, 'Remote access blocked'); return; }
    const client = { ws, settings: () => deviceSettings(deviceId), canView: () => allowedDevice(deviceId) && devices.allows(deviceId, 'view'), deviceId, owner: httpsServer, id: crypto.randomUUID(), address: req.socket.remoteAddress, connectedAt: Date.now() };
    clients.add(client);
    notify(connectCallbacks, deviceInfo(client));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    client.cancelTransfer = attachTransferHandler(ws, { policy, receipts: { get: (id) => receipts.get(`${deviceId}:${id}`), set: (id, value) => receipts.set(`${deviceId}:${id}`, value) },
      authorize: () => {
        if (!clients.has(client) || ws.readyState !== WebSocket.OPEN || !allowedDevice(deviceId) || !devices.allows(deviceId, 'write')) {
          throw new Error('Write permission is disabled on Windows');
        }
      },
      write: (item) => { if (!allowedDevice(deviceId) || !devices.allows(deviceId, 'write')) throw new Error('Write permission is disabled on Windows'); return writeToClipboardFn(item); } });
    ws.send(JSON.stringify({ type: 'settings', settings: deviceSettings(deviceId) }));
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
  return { httpsServer, wss, app, devices, enforceAccess };
}

function broadcastRaw(data, excludeWs) {
  if (!activePolicy.get().remoteAccess) return;
  for (const client of clients) if (client.canView() && client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
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
function broadcastSettings() {
  for (const client of clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: 'settings', settings: client.settings() }));
}
module.exports = { createServer, broadcastRaw, broadcastClipboard, broadcastFileAvailable, broadcastSettings,
  getConnectedDevices: () => Array.from(clients, deviceInfo),
  onDeviceConnect: (cb) => connectCallbacks.push(cb),
  onDeviceDisconnect: (cb) => disconnectCallbacks.push(cb),
  onFileReceived: (cb) => fileCallbacks.push(cb) };
