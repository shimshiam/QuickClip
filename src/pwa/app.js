/* ═══════════════════════════════════════════════════════════
   QuickClip PWA — Application Logic
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── State ───
  let ws = null;
  let serverIp = '';
  let serverPort = '';
  let authToken = '';
  let connected = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let pingInterval = null;
  let pongTimeout = null;
  let expectingBinary = null; // { type, size, meta }
  const clipboardItems = [];
  const fileItems = [];
  let settings = { syncText: true, syncImages: true, syncFiles: true, paused: false,
    clipboardTtlMinutes: 15, fileTtlHours: 24, maxHistory: 50, maxTextBytes: 1048576, maxImageBytes: 20971520 };
  let sending = false;
  let readingClipboard = false;
  let historyRequest = 0;
  let historyRevision = 0;

  // ─── DOM Refs ───
  const $ = (sel) => document.querySelector(sel);
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const overlay = $('#connection-overlay');
  const overlayStatus = $('#overlay-status');
  const btnSendClipboard = $('#btn-send-clipboard');
  const btnSendFile = $('#btn-send-file');
  const fileInput = $('#file-input');
  const clipboardList = $('#clipboard-list');
  const filesList = $('#files-list');
  const clipboardEmpty = $('#clipboard-empty');
  const filesEmpty = $('#files-empty');
  const clipboardCount = $('#clipboard-count');
  const filesCount = $('#files-count');
  const uploadProgress = $('#upload-progress');
  const uploadFilename = $('#upload-filename');
  const uploadPercent = $('#upload-percent');
  const uploadBarFill = $('#upload-bar-fill');
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const deliveryStatus = $('#delivery-status');
  const retryClipboard = $('#retry-clipboard');
  const delivery = QuickClipDelivery.createDelivery({
    send(message, buffer) {
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Reconnect to Windows, then retry');
      ws.send(JSON.stringify(message));
      if (buffer) ws.send(buffer);
    },
    onState({ state, error }) {
      sending = state === 'sending';
      retryClipboard.hidden = state !== 'unconfirmed';
      deliveryStatus.textContent = state === 'sending' ? 'Sending…' : state === 'sent' ? 'Sent to Windows' : error;
      if (state === 'sent') { animateSentButton(btnSendClipboard); showToast('✓ Clipboard received by Windows', 'success'); }
      updateConnectionUI(connected);
    },
  });
  retryClipboard.addEventListener('click', () => delivery.retry());

  function beginTransfer(type, content) {
    if (settings.paused || !settings[type === 'image' ? 'syncImages' : 'syncText']) {
      showToast('This clipboard type is disabled or sync is paused on Windows', 'error'); return;
    }
    const size = type === 'image' ? content.byteLength : new TextEncoder().encode(content).length;
    if (size > settings[type === 'image' ? 'maxImageBytes' : 'maxTextBytes']) {
      showToast('Clipboard exceeds the size limit; send large images as files', 'error'); return;
    }
    const message = { id: crypto.randomUUID(), type: `clipboard-${type}` };
    if (type === 'text') message.content = content;
    else message.size = size;
    delivery.start(message, type === 'image' ? content : undefined);
  }

  // ═══════════════════════════════════════════════════════
  // Connection Management
  // ═══════════════════════════════════════════════════════

  async function loadConnectionInfo() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const invitation = params.get('invitation');
    serverIp = window.location.hostname;
    serverPort = window.location.port || '8443';
    window.history.replaceState({}, '', window.location.pathname);
    authToken = localStorage.getItem('quickclip_device_token') || '';
    localStorage.removeItem('quickclip_token');
    if (invitation) {
      try {
        const response = await fetch('/api/pair', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invitation, name: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : 'Browser' }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Pairing failed');
        authToken = result.token;
        localStorage.setItem('quickclip_device_token', authToken);
      } catch (err) { overlayStatus.textContent = err.message; return false; }
    }
    return true;
  }

  function clearRemoteItems() {
    historyRequest++;
    clipboardItems.forEach(releaseItem);
    clipboardItems.length = 0;
    fileItems.length = 0;
    renderClipboardList(); renderFilesList();
  }

  function connectWebSocket() {
    if (!serverIp || !serverPort || !authToken) {
      overlayStatus.textContent = 'No connection info. Scan QR code from Windows app.';
      return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    // Force-close any socket stuck in CONNECTING state
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (_) { /* ignore */ }
      ws = null;
    }

    overlayStatus.textContent = `Connecting to ${serverIp}:${serverPort}…`;

    try {
      ws = new WebSocket(`wss://${serverIp}:${serverPort}?token=${authToken}`);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      console.error('WebSocket creation failed:', e);
      scheduleReconnect();
      return;
    }

    // Timeout: if TLS handshake or connection hangs for 10s, force reconnect
    const connectTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        console.warn('WebSocket connection timed out — retrying');
        try { ws.close(); } catch (_) { /* ignore */ }
      }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      connected = true;
      reconnectDelay = 1000;
      updateConnectionUI(true);
      startPingLoop();
      fetchInitialState();
    };

    ws.onclose = (event) => {
      clearTimeout(connectTimeout);
      connected = false;
      updateConnectionUI(false);
      stopPingLoop();
      delivery.disconnect();
      expectingBinary = null;

      if (event && [4001, 4003].includes(event.code)) {
        clearRemoteItems();
        if (event.code === 4001) { authToken = ''; localStorage.removeItem('quickclip_device_token'); }
        overlayStatus.textContent = event.code === 4003 ? 'Remote access is blocked on Windows. Enable it there, then reload this page.' : 'Device access was removed. Generate a new pairing code on Windows.';
        return;
      } else if (event && event.code === 1006) {
        overlayStatus.innerHTML = 'Connecting to server failed (`1006`).<br><br><span style="color:#ffd93d;font-size:0.9em">⚠️ <b>SSL Certificate Not Trusted</b><br>Safari blocks secure WebSockets if the CA certificate is not fully trusted.<br><br><b>To fix in iOS:</b><br>1. Download & Install <b>ca.crt</b><br>2. Go to <b>Settings → General → About → Certificate Trust Settings</b> and toggle <b>QuickClip CA</b> to <b>ON</b>.</span>';
      }

      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data);
      } else {
        handleTextMessage(event.data);
      }
    };
  }

  function handleTextMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'transfer-result':
        delivery.receive(msg);
        break;
      case 'settings':
        settings = { ...settings, ...msg.settings };
        while (clipboardItems.length > settings.maxHistory) releaseItem(clipboardItems.pop());
        renderClipboardList();
        updateConnectionUI(connected);
        break;
      case 'history-changed':
        historyRevision++;
        fetchInitialState();
        break;
      case 'clipboard-image-available':
        historyRevision++;
        addClipboardItem({ ...msg, type: 'image', url: msg.thumbnail });
        showToast('🖼️ Image received', 'success');
        notifyTab('clipboard');
        break;
      case 'clipboard-text':
        historyRevision++;
        addClipboardItem({ ...msg, type: 'text', timestamp: msg.timestamp || Date.now() });
        showToast('📋 Clipboard received', 'success');
        notifyTab('clipboard');
        break;

      case 'clipboard-image':
        // Next binary frame will be the image data
        expectingBinary = { type: 'clipboard-image', size: msg.size };
        break;

      case 'file-available':
        addFileItem({ id: msg.id, name: msg.name, size: msg.size, timestamp: Date.now() });
        showToast(`📁 File: ${msg.name}`, 'success');
        notifyTab('files');
        break;

      case 'pong':
        clearTimeout(pongTimeout);
        break;
    }
  }

  function handleBinaryMessage(buffer) {
    if (expectingBinary && expectingBinary.type === 'clipboard-image') {
      const blob = new Blob([buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      addClipboardItem({ type: 'image', blob, url, timestamp: Date.now() });
      showToast('🖼️ Image received', 'success');
      notifyTab('clipboard');
      expectingBinary = null;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    overlayStatus.textContent = `Reconnecting in ${Math.round(reconnectDelay / 1000)}s…`;
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function updateConnectionUI(isConnected) {
    if (isConnected) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      overlay.classList.add('hidden');
      btnSendClipboard.disabled = sending || readingClipboard || settings.paused || (!settings.syncText && !settings.syncImages);
      btnSendFile.disabled = settings.paused || !settings.syncFiles;
      statusText.textContent = settings.paused ? 'Sync paused on Windows' : 'Connected';
      btnSendClipboard.classList.add('pulse-anim');
    } else {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Disconnected';
      overlay.classList.remove('hidden');
      btnSendClipboard.disabled = true;
      btnSendFile.disabled = true;
      btnSendClipboard.classList.remove('pulse-anim');
    }
  }

  // ─── Initial State Hydration ───
  async function fetchInitialState() {
    const request = ++historyRequest;
    const revision = historyRevision;
    const base = `https://${serverIp}:${serverPort}`;
    const headers = { 'Authorization': `Bearer ${authToken}` };

    // Fetch clipboard history
    try {
      const res = await fetch(`${base}/api/history`, { headers });
      if (res.ok) {
        const history = await res.json();
        if (request !== historyRequest) return;
        if (revision !== historyRevision) { fetchInitialState(); return; }
        clipboardItems.forEach(releaseItem);
        clipboardItems.length = 0;
        for (const item of history.slice().reverse()) addClipboardItem({ ...item, url: item.thumbnail });
        renderClipboardList();
      }
    } catch (err) {
      console.warn('Failed to fetch clipboard history:', err);
    }

    if (request !== historyRequest) return;
    // Fetch file list
    try {
      const res = await fetch(`${base}/api/files`, { headers });
      if (res.ok) {
        const files = await res.json();
        if (request !== historyRequest) return;
        fileItems.length = 0;
        renderFilesList();
        for (const file of files) {
          addFileItem({
            id: file.id,
            name: file.name,
            size: file.size,
            available: file.available,
            timestamp: file.timestamp || Date.now(),
          });
        }
      }
    } catch (err) {
      console.warn('Failed to fetch file list:', err);
    }
  }

  // ─── Keepalive ───
  function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'ping' });
        pongTimeout = setTimeout(() => {
          // No pong received — force reconnect
          if (ws) ws.close();
        }, 10000);
      }
    }, 25000);
  }

  function stopPingLoop() {
    clearInterval(pingInterval);
    clearTimeout(pongTimeout);
    pingInterval = null;
    pongTimeout = null;
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        console.error('WebSocket send failed:', err);
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════
  // Clipboard Operations
  // ═══════════════════════════════════════════════════════

  async function sendClipboard() {
    if (readingClipboard || sending) return;
    readingClipboard = true;
    updateConnectionUI(connected);
    // Use a single navigator.clipboard.read() call to avoid triggering
    // iOS's "Allow Paste?" permission dialog twice (once for readText,
    // again for read). We inspect the returned item types to determine
    // whether the content is text or an image.
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // Check for image first (more specific)
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const buffer = await blob.arrayBuffer();
          beginTransfer('image', buffer);
          return;
        }

        // Then check for text
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          if (text && text.trim()) {
            beginTransfer('text', text);
            return;
          }
        }
      }
      showToast('Clipboard is empty', 'error');
    } catch (err) {
      // Fallback for browsers that don't support clipboard.read()
      // (or if the user denied permission)
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          beginTransfer('text', text);
          return;
        }
      } catch (_) { /* ignore fallback failure too */ }

      showToast('Clipboard not accessible — tap and try again', 'error');
    } finally {
      readingClipboard = false;
      updateConnectionUI(connected);
    }
  }

  async function copyClipboardItem(item, element) {
    try {
      if (item.type === 'text') {
        await navigator.clipboard.writeText(item.content);
      } else if (item.type === 'image') {
        // MUST use the Promise pattern to avoid gesture expiration on iOS
        const blobPromise = item.blob ? Promise.resolve(item.blob) : fetch(`/api/clipboard-images/${encodeURIComponent(item.id)}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }).then((res) => { if (!res.ok) throw new Error('Image expired'); return res.blob(); });
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blobPromise })
        ]);
      }
      element.classList.add('copied');
      setTimeout(() => element.classList.remove('copied'), 400);
      showToast('✓ Copied!', 'success');
    } catch (err) {
      console.error('Copy failed:', err);
      showToast('Copy failed — the item may have expired; refresh and try again', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════
  // File Operations
  // ═══════════════════════════════════════════════════════

  function triggerFilePicker() {
    fileInput.click();
  }

  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    uploadFilename.textContent = file.name;
    uploadPercent.textContent = '0%';
    uploadBarFill.style.width = '0%';
    uploadProgress.classList.remove('hidden');

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `https://${serverIp}:${serverPort}/api/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      xhr.timeout = 10 * 60 * 1000;
      xhr.ontimeout = () => {
        showToast('Upload timed out; check Windows before retrying', 'error');
        uploadProgress.classList.add('hidden');
      };

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          uploadPercent.textContent = `${pct}%`;
          uploadBarFill.style.width = `${pct}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          showToast(`✓ "${file.name}" sent!`, 'success');
          animateSentButton(btnSendFile);
        } else {
          let message = 'Upload failed';
          try { message = JSON.parse(xhr.responseText).error || message; } catch (_) { /* non-JSON response */ }
          showToast(message, 'error');
        }
        setTimeout(() => uploadProgress.classList.add('hidden'), 1500);
      };

      xhr.onerror = () => {
        showToast('Upload error', 'error');
        uploadProgress.classList.add('hidden');
      };

      xhr.send(formData);
    } catch (err) {
      console.error('Upload failed:', err);
      showToast('Upload failed', 'error');
      uploadProgress.classList.add('hidden');
    }
  }

  async function downloadFile(fileItem) {
    if (fileItem.available === false) { showToast('This file is no longer on Windows', 'error'); return; }
    // A short-lived ticket keeps pairing credentials out of download URLs.
    let downloadUrl;
    try {
      const response = await fetch('/api/download-ticket', {
        method: 'POST', headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'file', id: fileItem.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      downloadUrl = result.url;
    } catch (err) { showToast(err.message || 'Download unavailable', 'error'); return; }
    const MAX_SHARE_SIZE = 25 * 1024 * 1024; // 25 MB

    // Try Web Share API for small files (needs a File object in memory)
    if (navigator.share && navigator.canShare && fileItem.size && fileItem.size < MAX_SHARE_SIZE) {
      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error('Download expired');
        const blob = await response.blob();
        const file = new File([blob], fileItem.name, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fileItem.name });
          return;
        }
      } catch { /* fall through to direct download */ }
    }

    // Direct download — uses a plain <a> link so Safari streams to disk
    // without buffering in JS memory. Works for any file size.
    try {
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileItem.name;
      // Some iOS Safari versions need the element in the DOM to trigger download
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`⬇ Downloading "${fileItem.name}"`, 'success');
    } catch (err) {
      console.error('Download failed:', err);
      showToast('Download failed', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════
  // UI Rendering
  // ═══════════════════════════════════════════════════════

  function addClipboardItem(item) {
    if (item.id && clipboardItems.some((entry) => entry.id === item.id)) return;
    clipboardItems.unshift(item);
    if (clipboardItems.length > settings.maxHistory) releaseItem(clipboardItems.pop());
    renderClipboardList();
  }

  function releaseItem(item) {
    if (item?.url?.startsWith('blob:')) URL.revokeObjectURL(item.url);
  }

  function addFileItem(item) {
    // Don't add duplicates
    if (fileItems.some(f => f.id === item.id)) return;
    fileItems.unshift(item);
    renderFilesList();
  }

  function renderClipboardList() {
    clipboardCount.textContent = clipboardItems.length;
    clipboardList.querySelectorAll('.item-card, .clipboard-item').forEach(el => el.remove());

    if (clipboardItems.length === 0) {
      clipboardEmpty.style.display = '';
      return;
    }

    clipboardEmpty.style.display = 'none';

    clipboardList.querySelectorAll('.item-card, .clipboard-item').forEach(el => el.remove());

    clipboardItems.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'item-card';
      el.style.animationDelay = `${index * 0.04}s`;

      const iconClass = item.type === 'image' ? 'image-thumb' : 'text-icon';
      const iconSvg = item.type === 'image'
        ? `<img src="${escapeHtml(item.url || '').replace(/"/g, '&quot;')}" alt="thumb">`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <line x1="17" y1="10" x2="3" y2="10"/>
             <line x1="21" y1="6" x2="3" y2="6"/>
             <line x1="21" y1="14" x2="3" y2="14"/>
             <line x1="17" y1="18" x2="3" y2="18"/>
           </svg>`;

      let previewHtml = item.type === 'image'
        ? '<em style="color:var(--text-secondary)">Image payload</em>'
        : escapeHtml(item.content.substring(0, 150));

      el.innerHTML = `
        <div class="item-icon ${iconClass}">${iconSvg}</div>
        <div class="item-body">
          <div class="item-text">${previewHtml}</div>
          <div class="item-meta">
            <span class="item-time" data-timestamp="${Number(item.timestamp)}">${formatTime(item.timestamp)}</span>
          </div>
        </div>
        <button class="item-action-btn">Copy</button>
      `;

      el.addEventListener('click', () => copyClipboardItem(item, el));
      clipboardList.insertBefore(el, clipboardEmpty);
    });
  }

  function renderFilesList() {
    filesCount.textContent = fileItems.length;

    filesList.querySelectorAll('.item-card, .file-item').forEach(el => el.remove());
    if (fileItems.length === 0) {
      filesEmpty.style.display = '';
      return;
    }

    filesEmpty.style.display = 'none';

    filesList.querySelectorAll('.item-card, .file-item').forEach(el => el.remove());

    fileItems.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'item-card';
      el.style.animationDelay = `${index * 0.04}s`;

      const ext = getFileExtension(item.name);

      el.innerHTML = `
        <div class="item-icon"><span>${escapeHtml(ext)}</span></div>
        <div class="item-body">
          <div class="item-text">${escapeHtml(item.name)}</div>
          <div class="item-meta">
            <span>${formatSize(item.size)}</span>
            <span>·</span>
            <span class="item-time" data-timestamp="${Number(item.timestamp || Date.now())}">${formatTime(item.timestamp || item.date || Date.now())}</span>
          </div>
        </div>
        <button class="item-action-btn" aria-label="Download" ${item.available === false ? 'disabled' : ''}>${item.available === false ? 'Unavailable' : 'Save'}</button>
      `;

      el.addEventListener('click', () => downloadFile(item));
      filesList.insertBefore(el, filesEmpty);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Tab Navigation
  // ═══════════════════════════════════════════════════════

  function switchTab(tabName) {
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
      // Clear notification dot when switching to that tab
      if (btn.dataset.tab === tabName) {
        const notif = btn.querySelector('.tab-notif');
        if (notif) notif.classList.remove('show');
      }
    });
    tabPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function notifyTab(tabName) {
    const activeBtn = document.querySelector('.tab-btn.active');
    if (activeBtn && activeBtn.dataset.tab === tabName) return; // Already on this tab

    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (!btn) return;

    let notif = btn.querySelector('.tab-notif');
    if (!notif) {
      notif = document.createElement('span');
      notif.className = 'tab-notif';
      btn.appendChild(notif);
    }
    notif.classList.add('show');
  }

  // ═══════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════

  function showToast(message, type = '') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('dismiss');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2200);
  }

  function animateSentButton(btn) {
    if (!btn) return;
    btn.classList.add('sent-flash', 'sent');
    setTimeout(() => btn.classList.remove('sent-flash', 'sent'), 600);
  }

  function formatTime(timestamp) {
    const diff = Date.now() - timestamp;
    const secs = Math.floor(diff / 1000);
    if (secs < 5) return 'Just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  function getFileExtension(filename) {
    const parts = filename.split('.');
    if (parts.length < 2) return '?';
    return parts.pop().substring(0, 4);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Keep timestamps live
  function pruneExpiredItems() {
    const now = Date.now();
    const before = clipboardItems.length + fileItems.length;
    for (let i = clipboardItems.length - 1; i >= 0; i--) {
      if (clipboardItems[i].timestamp + settings.clipboardTtlMinutes * 60000 <= now) releaseItem(clipboardItems.splice(i, 1)[0]);
    }
    for (let i = fileItems.length - 1; i >= 0; i--) {
      if (fileItems[i].timestamp + settings.fileTtlHours * 3600000 <= now) fileItems.splice(i, 1);
    }
    if (before !== clipboardItems.length + fileItems.length) { renderClipboardList(); renderFilesList(); }
  }
  function startTimestampUpdater() {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pruneExpiredItems(); });
    setInterval(() => {
      pruneExpiredItems();
      document.querySelectorAll('.item-time').forEach((el) => {
        el.textContent = formatTime(Number(el.dataset.timestamp));
      });
    }, 5000);
  }

  // ═══════════════════════════════════════════════════════
  // Service Worker Registration
  // ═══════════════════════════════════════════════════════

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // Ripple Effect
  // ═══════════════════════════════════════════════════════

  function addRipple(event) {
    const el = event.currentTarget;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const clientX = event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : rect.left + rect.width / 2);
    const clientY = event.clientY || (event.touches && event.touches[0] ? event.touches[0].clientY : rect.top + rect.height / 2);
    const x = clientX - rect.left - size / 2;
    const y = clientY - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    el.appendChild(ripple);

    ripple.addEventListener('animationend', () => ripple.remove());
  }

  function initRipples() {
    document.querySelectorAll('.btn-send-primary, .item-action-btn, .tab-btn').forEach((el) => {
      el.addEventListener('click', addRipple);
      el.addEventListener('touchstart', addRipple, { passive: true });
    });
  }

  // ═══════════════════════════════════════════════════════
  // Theme Toggle
  // ═══════════════════════════════════════════════════════

  function initThemeToggle() {
    const toggle = $('#pwa-theme-toggle');
    if (!toggle) return;

    const themeColor = document.querySelector('meta[name="theme-color"]');

    function applyTheme(isDark) {
      if (isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }

      if (themeColor) {
        themeColor.setAttribute('content', isDark ? '#30364a' : '#c8ccd4');
      }
    }

    // Restore saved theme
    const saved = localStorage.getItem('quickclip-pwa-theme');
    applyTheme(saved === 'dark');

    toggle.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      applyTheme(!isDark);
      localStorage.setItem('quickclip-pwa-theme', isDark ? 'light' : 'dark');
      // Haptic feedback on supported devices
      if (navigator.vibrate) {
        navigator.vibrate([10, 20, 10]);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // Event Listeners
  // ═══════════════════════════════════════════════════════

  function bindEvents() {
    // Send clipboard
    btnSendClipboard.addEventListener('click', () => {
      if (!connected) return;
      sendClipboard();
    });

    // Send file
    btnSendFile.addEventListener('click', () => {
      if (!connected) return;
      triggerFilePicker();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        uploadFile(file);
        fileInput.value = ''; // Reset
      }
    });

    // Tab bar
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════

  async function init() {
    if (!await loadConnectionInfo()) return;
    bindEvents();
    registerServiceWorker();
    startTimestampUpdater();
    connectWebSocket();
    initRipples();
    initThemeToggle();
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
