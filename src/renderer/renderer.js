// ============================================================
// QuickClip — Renderer UI Logic (Apple White & Blue Theme)
// Uses the window.quickclip preload API
// ============================================================

(() => {
  'use strict';

  // ---------- DOM References ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    // Header
    statusDot:       $('#statusDot'),
    statusText:      $('#statusText'),
    connectionBadge: $('#connectionBadge'),

    // Tabs
    tabBtns:         $$('.tab-btn'),
    tabIndicator:    $('#tabIndicator'),
    tabPanels:       $$('.tab-panel'),

    // Pair
    qrImage:         $('#qrCodeImage'),
    qrPlaceholder:   $('#qrPlaceholder'),
    serverUrl:       $('#serverUrl'),
    serverUrlWrap:   $('#serverUrlWrap'),
    downloadCaBtn:   $('#downloadCaBtn'),
    setupToggle:     $('#setupToggle'),
    setupContent:    $('#setupContent'),

    // Clipboard
    clipboardList:   $('#clipboardList'),
    clipboardEmpty:  $('#clipboardEmpty'),
    clearHistoryBtn: $('#clearHistoryBtn'),

    // Files
    filesList:       $('#filesList'),
    filesEmpty:      $('#filesEmpty'),
    sendFilesBtn:    $('#sendFilesBtn'),
    fileSortSelect:  $('#fileSortSelect'),

    // Settings
    settingSyncText:   $('#settingSyncText'),
    settingSyncImages: $('#settingSyncImages'),
    settingSyncFiles:  $('#settingSyncFiles'),
    settingMaxHistory: $('#settingMaxHistory'),
    settingToken:      $('#settingToken'),
    copyTokenBtn:      $('#copyTokenBtn'),

    // Toast
    toastContainer:  $('#toastContainer'),

    // Footer
    footerPort:      $('#footerPort'),
    footerIP:        $('#footerIP'),
  };

  // ---------- Toast Notifications ----------
  function showToast(message, type = 'success') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✓' : '⚠'}</span>
      <span>${escapeHTML(message)}</span>
    `;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('dismiss');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2800);
  }

  // ---------- Tab Switching ----------
  function positionIndicator(btn) {
    if (!btn || !dom.tabIndicator) return;
    const rect = btn.getBoundingClientRect();
    const navRect = btn.closest('.tab-list').getBoundingClientRect();
    dom.tabIndicator.style.left = `${rect.left - navRect.left}px`;
    dom.tabIndicator.style.width = `${rect.width}px`;
  }

  function switchTab(tabName) {
    dom.tabBtns.forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
      if (isActive) positionIndicator(btn);
    });

    dom.tabPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });
  }

  dom.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  requestAnimationFrame(() => {
    const activeBtn = $('.tab-btn.active');
    if (activeBtn) positionIndicator(activeBtn);
  });

  window.addEventListener('resize', () => {
    const activeBtn = $('.tab-btn.active');
    if (activeBtn) positionIndicator(activeBtn);
  });

  // ---------- QR Code & Server URL ----------
  async function loadQRCode() {
    try {
      const qrDataUrl = await window.quickclip.getQRCode();
      if (qrDataUrl && dom.qrImage) {
        dom.qrImage.src = qrDataUrl;
        dom.qrImage.classList.add('loaded');
        if (dom.qrPlaceholder) dom.qrPlaceholder.classList.add('hidden');
      }
    } catch (err) {
      console.error('Failed to load QR code:', err);
    }
  }

  if (dom.serverUrlWrap) {
    dom.serverUrlWrap.addEventListener('click', () => {
      const urlText = dom.serverUrl ? dom.serverUrl.textContent : '';
      if (urlText) {
        navigator.clipboard.writeText(urlText);
        showToast('Server URL copied to clipboard!');
      }
    });
  }

  // ---------- Connection Status ----------
  async function refreshStatus() {
    try {
      const status = await window.quickclip.getStatus();

      const count = status.deviceCount || status.connectedDevices || 0;
      const isConnected = count > 0;
      if (dom.statusDot) dom.statusDot.className = `status-dot ${isConnected ? 'connected' : 'disconnected'}`;
      if (dom.statusText) {
        dom.statusText.textContent = isConnected
          ? `${count} Device${count > 1 ? 's' : ''}`
          : 'No Devices';
      }

      // Footer & Pair URL
      if (status.port && dom.footerPort) dom.footerPort.textContent = `Port: ${status.port}`;
      const ip = status.ip || status.localIP;
      if (ip && dom.footerIP) dom.footerIP.textContent = `IP: ${ip}`;
      const sUrl = status.serverUrl || (ip && status.port ? `https://${ip}:${status.port}` : '');
      if (sUrl && dom.serverUrl) dom.serverUrl.textContent = sUrl;
    } catch (err) {
      console.error('Failed to refresh status:', err);
    }
  }

  // ---------- Settings Tab ----------
  async function refreshSettings() {
    try {
      const settings = await window.quickclip.getSettings();
      if (settings && dom.settingSyncText) dom.settingSyncText.checked = settings.syncText !== false;
      if (settings && dom.settingSyncImages) dom.settingSyncImages.checked = settings.syncImages !== false;
      if (settings && dom.settingSyncFiles) dom.settingSyncFiles.checked = settings.syncFiles !== false;
      if (settings && dom.settingMaxHistory) dom.settingMaxHistory.value = settings.maxHistory || 50;

      const info = await window.quickclip.getServerInfo();
      if (info && info.token && dom.settingToken) dom.settingToken.value = info.token;
    } catch (err) {
      console.error('Failed to refresh settings:', err);
    }
  }

  async function saveSettings() {
    try {
      const updated = {
        syncText: dom.settingSyncText ? dom.settingSyncText.checked : true,
        syncImages: dom.settingSyncImages ? dom.settingSyncImages.checked : true,
        syncFiles: dom.settingSyncFiles ? dom.settingSyncFiles.checked : true,
        maxHistory: dom.settingMaxHistory ? Number(dom.settingMaxHistory.value) : 50,
      };
      if (!await window.quickclip.updateSettings(updated)) throw new Error('Settings could not be saved');
      await refreshHistory();
      showToast('Preferences saved');
    } catch (err) {
      console.error('Failed to update settings:', err);
      showToast('Failed to save preferences', 'error');
      await refreshSettings();
    }
  }

  if (dom.settingSyncText) dom.settingSyncText.addEventListener('change', saveSettings);
  if (dom.settingSyncImages) dom.settingSyncImages.addEventListener('change', saveSettings);
  if (dom.settingSyncFiles) dom.settingSyncFiles.addEventListener('change', saveSettings);
  if (dom.settingMaxHistory) dom.settingMaxHistory.addEventListener('change', saveSettings);

  if (dom.copyTokenBtn) {
    dom.copyTokenBtn.addEventListener('click', () => {
      const token = dom.settingToken ? dom.settingToken.value : '';
      if (token && token !== '••••••••••••') {
        navigator.clipboard.writeText(token);
        showToast('Token copied to clipboard!');
      }
    });
  }

  // ---------- Relative Time ----------
  function relativeTime(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.max(0, Math.floor((now - then) / 1000));

    if (diffSec < 5)    return 'just now';
    if (diffSec < 60)   return `${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60)      return `${mins} min${mins > 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)       return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }

  // ---------- Clipboard History ----------
  function createTextIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>`;
  }

  function renderClipboardItem(item) {
    const el = document.createElement('div');
    el.className = 'clipboard-item';

    const isImage = item.type === 'image';
    const sourceCls = item.source === 'remote' ? 'iphone' : 'local';
    const sourceLabel = item.source === 'remote' ? 'Phone' : 'Local';

    let iconHTML;
    if (isImage && item.thumbnail) {
      iconHTML = `<div class="clip-icon image-icon"><img src="${escapeAttr(item.thumbnail)}" alt="thumbnail" /></div>`;
    } else {
      iconHTML = `<div class="clip-icon">${createTextIcon()}</div>`;
    }

    const preview = isImage
      ? '<em style="color:var(--text-secondary)">Image payload</em>'
      : escapeHTML(truncate(item.content || '', 120));

    el.innerHTML = `
      ${iconHTML}
      <div class="clip-body">
        <div class="clip-preview">${preview}</div>
        <div class="clip-meta">
          <span class="clip-time">${relativeTime(item.timestamp)}</span>
          <span class="source-badge ${sourceCls}">${sourceLabel}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-ghost btn-sm clip-copy-btn">Copy</button>
      </div>
    `;

    el.querySelector('.clip-copy-btn').addEventListener('click', async () => {
      try {
        const result = await window.quickclip.copyHistoryItem(item.id);
        if (!result.ok) throw new Error(result.error);
        showToast('Copied to clipboard!');
      } catch (err) {
        showToast(err.message || 'Copy failed', 'error');
      }
    });

    return el;
  }

  async function refreshHistory() {
    try {
      const history = await window.quickclip.getHistory();
      if (!dom.clipboardList) return;
      dom.clipboardList.innerHTML = '';

      if (!history || history.length === 0) {
        if (dom.clipboardEmpty) dom.clipboardEmpty.classList.add('visible');
        dom.clipboardList.style.display = 'none';
        return;
      }

      if (dom.clipboardEmpty) dom.clipboardEmpty.classList.remove('visible');
      dom.clipboardList.style.display = 'flex';

      history.forEach((item) => {
        dom.clipboardList.appendChild(renderClipboardItem(item));
      });
    } catch (err) {
      console.error('Failed to refresh clipboard history:', err);
    }
  }

  if (dom.clearHistoryBtn) {
    dom.clearHistoryBtn.addEventListener('click', async () => {
      try {
        await window.quickclip.clearHistory();
        refreshHistory();
        showToast('Clipboard history cleared');
      } catch (err) {
        console.error('Failed to clear history:', err);
      }
    });
  }

  // ---------- Files List ----------
  const FILE_SORT_KEY = 'quickclip-file-sort';
  const FILE_SORT_OPTIONS = new Set([
    'newest',
    'oldest',
    'name-asc',
    'name-desc',
    'size-desc',
    'size-asc',
  ]);

  function getFileSort() {
    const savedSort = localStorage.getItem(FILE_SORT_KEY);
    return FILE_SORT_OPTIONS.has(savedSort) ? savedSort : 'newest';
  }

  function fileTimestamp(file) {
    const value = file.timestamp ?? file.date;
    const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function sortFiles(files, sortBy) {
    const sorted = [...files];
    const compareName = (a, b) => String(a.name || '').localeCompare(
      String(b.name || ''),
      undefined,
      { numeric: true, sensitivity: 'base' },
    );

    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          return fileTimestamp(a) - fileTimestamp(b);
        case 'name-asc':
          return compareName(a, b);
        case 'name-desc':
          return compareName(b, a);
        case 'size-desc':
          return (Number(b.size) || 0) - (Number(a.size) || 0);
        case 'size-asc':
          return (Number(a.size) || 0) - (Number(b.size) || 0);
        case 'newest':
        default:
          return fileTimestamp(b) - fileTimestamp(a);
      }
    });

    return sorted;
  }

  function fileIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>`;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function renderFileItem(file) {
    const el = document.createElement('div');
    el.className = 'file-item';

    el.innerHTML = `
      <div class="file-icon">${fileIcon()}</div>
      <div class="file-body">
        <div class="file-name" title="${escapeAttr(file.name)}">${escapeHTML(file.name)}</div>
        <div class="file-meta">
          <span>${formatBytes(file.size)}</span>
          <span>·</span>
          <span>${relativeTime(file.date || file.timestamp)}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-ghost btn-sm file-open-btn" title="Open file" ${file.available === false ? 'disabled' : ''}>${file.available === false ? 'Unavailable' : 'Open'}</button>
        <button class="btn btn-ghost btn-sm file-folder-btn" title="Show in Explorer">Folder</button>
      </div>
    `;

    el.querySelector('.file-open-btn').addEventListener('click', () => {
      window.quickclip.openFile(file.path || file.id);
    });

    el.querySelector('.file-folder-btn').addEventListener('click', () => {
      window.quickclip.showInExplorer(file.path || file.id);
    });

    return el;
  }

  async function refreshFiles() {
    try {
      const files = await window.quickclip.getFiles();
      if (!dom.filesList) return;
      dom.filesList.innerHTML = '';

      if (!files || files.length === 0) {
        if (dom.filesEmpty) dom.filesEmpty.classList.add('visible');
        dom.filesList.style.display = 'none';
        return;
      }

      if (dom.filesEmpty) dom.filesEmpty.classList.remove('visible');
      dom.filesList.style.display = 'flex';

      sortFiles(files, getFileSort()).forEach((file) => {
        dom.filesList.appendChild(renderFileItem(file));
      });
    } catch (err) {
      console.error('Failed to refresh files:', err);
    }
  }

  if (dom.fileSortSelect) {
    dom.fileSortSelect.value = getFileSort();
    dom.fileSortSelect.addEventListener('change', () => {
      const selectedSort = FILE_SORT_OPTIONS.has(dom.fileSortSelect.value)
        ? dom.fileSortSelect.value
        : 'newest';
      localStorage.setItem(FILE_SORT_KEY, selectedSort);
      refreshFiles();
    });
  }

  // ---------- Accordion Toggle ----------
  if (dom.setupToggle) {
    dom.setupToggle.addEventListener('click', () => {
      const expanded = dom.setupToggle.getAttribute('aria-expanded') === 'true';
      dom.setupToggle.setAttribute('aria-expanded', String(!expanded));
      if (dom.setupContent) dom.setupContent.classList.toggle('open', !expanded);
    });
  }

  // ---------- CA Certificate Download ----------
  if (dom.downloadCaBtn) {
    dom.downloadCaBtn.addEventListener('click', async () => {
      try {
        const success = await window.quickclip.downloadCACert();
        if (success) showToast('CA Certificate saved and opened!');
      } catch (err) {
        console.error('Failed to download CA certificate:', err);
        showToast('Failed to save certificate', 'error');
      }
    });
  }

  // ---------- Share File with Mobile ----------
  if (dom.sendFilesBtn) {
    dom.sendFilesBtn.addEventListener('click', async () => {
      try {
        const sent = await window.quickclip.selectAndSendFiles();
        if (sent && sent.length > 0) {
          refreshFiles();
          showToast(`Shared ${sent.length} file(s) with mobile devices!`);
        }
      } catch (err) {
        console.error('Failed to share files:', err);
        showToast(err.message || 'Failed to share file', 'error');
      }
    });
  }

  // ---------- Real-time Listeners ----------
  function setupEventListeners() {
    if (window.quickclip.onClipboardChange) {
      window.quickclip.onClipboardChange(() => {
        refreshHistory();
      });
    }

    if (window.quickclip.onDeviceConnect) {
      window.quickclip.onDeviceConnect(() => {
        refreshStatus();
      });
    }

    if (window.quickclip.onDeviceDisconnect) {
      window.quickclip.onDeviceDisconnect(() => {
        refreshStatus();
      });
    }

    if (window.quickclip.onFileReceived) {
      window.quickclip.onFileReceived((file) => {
        refreshFiles();
        const fileName = file && file.name ? file.name : 'New file';
        showToast(`File available: ${fileName}`);
      });
    }
  }

  // ---------- Utility Helpers ----------
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.slice(0, max) + '…';
  }

  // ---------- Ripple Effect ----------
  function addRipple(event) {
    const el = event.currentTarget;
    // Respect reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const x = (event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : rect.left + rect.width / 2)) - rect.left - size / 2;
    const y = (event.clientY || (event.touches && event.touches[0] ? event.touches[0].clientY : rect.top + rect.height / 2)) - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    el.appendChild(ripple);

    ripple.addEventListener('animationend', () => ripple.remove());
  }

  function initRipples() {
    document.querySelectorAll('.btn, .accordion-trigger, .server-url-wrap').forEach((el) => {
      el.addEventListener('click', addRipple);
      el.addEventListener('touchstart', addRipple, { passive: true });
    });
  }

  // ---------- Theme Toggle ----------
  function initThemeToggle() {
    const toggle = $('#themeToggle');
    if (!toggle) return;

    // Restore saved theme
    const saved = localStorage.getItem('quickclip-theme');
    if (saved === 'dark') {
      document.documentElement.classList.add('dark-mode');
    }

    toggle.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark-mode');
      const isDark = document.documentElement.classList.contains('dark-mode');
      localStorage.setItem('quickclip-theme', isDark ? 'dark' : 'light');
    });
  }

  // ---------- Auto-refresh ----------
  let statusInterval = null;

  function startAutoRefresh() {
    statusInterval = setInterval(() => {
      refreshStatus();
      refreshFiles();
    }, 5000);
  }

  // ---------- Initialise ----------
  async function init() {
    await Promise.all([
      loadQRCode(),
      refreshStatus(),
      refreshHistory(),
      refreshFiles(),
      refreshSettings(),
    ]);
    setupEventListeners();
    startAutoRefresh();
    initRipples();
    initThemeToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
