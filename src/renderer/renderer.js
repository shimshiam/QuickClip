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
    const existing = [...dom.toastContainer.children].find(node => node.dataset.message === message);
    if (existing) existing.remove();
    while (dom.toastContainer.children.length >= 2) dom.toastContainer.firstElementChild.remove();
    const toast = document.createElement('div');
    toast.dataset.message = message;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✓' : '⚠'}</span>
      <span>${escapeHTML(message)}</span>
    `;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('dismiss');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 300);
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
      const active = panel.id === `panel-${tabName}`;
      panel.classList.toggle('active', active);
      panel.inert = !active;
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
  let pairingBusy = false;
  let pairingExpiry;
  function clearPairingCode() {
    clearTimeout(pairingExpiry);
    dom.qrImage.removeAttribute('src');
    dom.qrImage.classList.remove('loaded');
    $('#qrPlaceholderText').textContent = 'Create pairing code';
    $('#createPairingBtn').setAttribute('aria-label', 'Create pairing code');
  }
  async function loadQRCode() {
    if (pairingBusy) return;
    pairingBusy = true;
    clearPairingCode();
    const buttons = [$('#createPairingBtn'), $('#newPairingBtn'), $('#requirePasscode')];
    buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
    $('#qrPlaceholderText').textContent = 'Creating pairing code…';
    $('#newPairingBtn').textContent = 'Creating pairing code…';
    try {
      const qrDataUrl = await window.quickclip.getQRCode();
      if (!qrDataUrl) throw new Error('Could not create a code. Check remote access in Settings and try again.');
      dom.qrImage.src = qrDataUrl.qr || qrDataUrl;
      dom.qrImage.classList.add('loaded');
      $('#createPairingBtn').setAttribute('aria-label', 'Create a new pairing code');
      pairingExpiry = setTimeout(clearPairingCode, 5 * 60 * 1000);
      showToast('Pairing code ready. Scan it within five minutes.');
    } catch (err) {
      clearPairingCode();
      showToast(err.message || 'Could not create a pairing code. Try again.', 'error');
    } finally {
      pairingBusy = false;
      buttons.forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); });
      $('#newPairingBtn').textContent = 'New pairing code';
    }
  }
  $('#createPairingBtn').addEventListener('click', loadQRCode);

  if (dom.serverUrlWrap) {
    dom.serverUrlWrap.addEventListener('click', async () => {
      const urlText = dom.serverUrl ? dom.serverUrl.textContent : '';
      if (urlText) {
        try {
          await navigator.clipboard.writeText(urlText);
          showToast('Server URL copied');
        } catch (_) { showToast('Could not copy server URL', 'error'); }
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

      $('#settingRemoteAccess').checked = settings.remoteAccess !== false;
      $('#requirePasscode').checked = settings.requirePasscode === true;
      $('#pairingPasswordForm').hidden = !settings.requirePasscode;
      $('#pairingPasswordStatus').textContent = settings.hasPairingPassword ? 'Password saved. Leave blank to keep it.' : 'Set a password to enable protected joining.';
      $('#settingClipboardTtl').value = settings.clipboardTtlMinutes || 15;
      $('#settingFileTtl').value = settings.fileTtlHours || 24;
      $('#settingStorageQuota').value = settings.storageQuotaMB || 2048;
      await refreshDevices();
    } catch (err) {
      console.error('Failed to refresh settings:', err);
    }
  }

  async function saveSettings() {
    try {
      const updated = {
        remoteAccess: $('#settingRemoteAccess').checked,
        clipboardTtlMinutes: Number($('#settingClipboardTtl').value),
        fileTtlHours: Number($('#settingFileTtl').value),
        storageQuotaMB: Number($('#settingStorageQuota').value),
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

  function permissionIcon(key, enabled) {
    const paths = key === 'access' ? '<path d="m6 6 12 12M18 6 6 18"/>' : key === 'view' ? (enabled
        ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.8M6.2 6.2A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.5M10 10a3 3 0 0 0 4 4"/>')
      : enabled ? '<path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/>'
        : '<path d="m15 5 4 4M13 7l3-3a2.8 2.8 0 0 1 4 4l-4 4-3-1 1-3-1-1ZM10 11l-5 4-1 5 5-1 4-5-3 1 1-3-1-1Z"/>';
    return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function reviewPasswordDevices(update, devices) {
    const dialog = $('#passwordDeviceReview'), list = $('#passwordReviewDevices');
    const rows = devices.map(device => ({ id: device.id, keep: true,
      originalPermissions: { ...device.permissions }, permissions: { ...device.permissions } }));
    function render() {
      list.replaceChildren();
      rows.forEach((row, index) => {
        const device = devices[index], section = document.createElement('div');
        section.className = 'review-device';
        const name = document.createElement('strong'); name.className = 'review-device-name';
        name.textContent = device.name + (device.connected ? ' · Connected' : ' · Offline');
        const controls = document.createElement('div'); controls.className = 'review-device-controls';
        const keep = document.createElement('button');
        keep.type = 'button'; keep.className = 'review-keep';
        keep.textContent = row.keep ? 'Keep' : 'Remove';
        keep.setAttribute('aria-pressed', String(row.keep));
        keep.setAttribute('aria-label', 'Keep ' + device.name);
        keep.onclick = () => { row.keep = !row.keep; render(); };
        controls.append(keep);
        for (const [key, title] of [['access', 'Access'], ['view', 'View'], ['write', 'Write']]) {
          const control = document.createElement('button');
          control.type = 'button'; control.className = 'device-permission';
          control.dataset.permission = key;
          control.innerHTML = permissionIcon(key, row.permissions[key]);
          control.setAttribute('aria-label', title + ' ' + device.name);
          control.setAttribute('aria-pressed', String(row.permissions[key]));
          control.title = title + ': ' + (row.permissions[key] ? 'on' : 'off');
          control.disabled = !row.keep || (key !== 'access' && !row.permissions.access);
          control.onclick = () => {
            row.permissions[key] = !row.permissions[key]; render();
            list.children[index].querySelector('[data-permission="' + key + '"]').focus();
          };
          controls.append(control);
        }
        section.append(name, controls); list.append(section);
      });
    }
    render(); $('#passwordReviewError').textContent = '';
    return new Promise(resolve => {
      let saving = false;
      dialog.oncancel = event => { if (saving) event.preventDefault(); };
      dialog.onclose = () => resolve(false);
      $('#reviewCancel').onclick = () => dialog.close();
      $('#reviewKeepAll').onclick = () => { rows.forEach(row => { row.keep = true; }); render(); };
      $('#reviewRemoveAll').onclick = () => { rows.forEach(row => { row.keep = false; }); render(); };
      $('#reviewApply').onclick = async () => {
        saving = true;
        dialog.querySelectorAll('button, input').forEach(node => { node.disabled = true; });
        try {
          if (!await window.quickclip.updateSettings({ ...update, deviceReview: rows })) throw new Error('Could not apply changes. Cancel and reopen the review if devices or permissions changed.');
          dialog.onclose = null; dialog.close(); resolve(true);
        } catch (err) { $('#passwordReviewError').textContent = err.message; }
        finally { saving = false; dialog.querySelectorAll('button').forEach(node => { node.disabled = false; }); render(); }
      };
      dialog.showModal();
    });
  }

  async function savePairingPassword(event) {
    event?.preventDefault();
    const toggle = $('#requirePasscode');
    const input = $('#pairingPassword');
    $('#pairingPasswordForm').hidden = !toggle.checked;
    const settings = await window.quickclip.getSettings();
    if (toggle.checked && !input.value && !settings.hasPairingPassword) {
      input.focus();
      return;
    }
    toggle.disabled = true;
    $('#savePairingPassword').disabled = true;
    try {
      const update = { requirePasscode: toggle.checked };
      if (toggle.checked && input.value) update.pairingPassword = input.value;
      const devices = update.pairingPassword && settings.hasPairingPassword ? await window.quickclip.getTrustedDevices() : [];
      if (devices.some(device => device.connected)) {
        if (!await reviewPasswordDevices(update, devices)) return;
      } else if (!await window.quickclip.updateSettings(update)) throw new Error('Could not save joining password');
      input.value = '';
      await refreshSettings();
      clearPairingCode();
      await loadQRCode();
    } catch (err) { showToast(err.message, 'error'); await refreshSettings(); }
    finally { toggle.disabled = false; $('#savePairingPassword').disabled = false; }
  }
  $('#requirePasscode').addEventListener('change', savePairingPassword);
  $('#pairingPasswordForm').addEventListener('submit', savePairingPassword);

  if (dom.settingSyncText) dom.settingSyncText.addEventListener('change', saveSettings);
  if (dom.settingSyncImages) dom.settingSyncImages.addEventListener('change', saveSettings);
  if (dom.settingSyncFiles) dom.settingSyncFiles.addEventListener('change', saveSettings);
  if (dom.settingMaxHistory) dom.settingMaxHistory.addEventListener('change', saveSettings);

  const deviceDrawer = $('#deviceDrawer');
  function measureDeviceNames() {
    if (!deviceDrawer.open) return;
    deviceDrawer.querySelectorAll('.device-name').forEach(heading => {
      const text = heading.firstElementChild;
      const overflow = Math.max(0, text.scrollWidth - heading.clientWidth);
      heading.classList.toggle('overflows', overflow > 1);
      heading.style.setProperty('--name-travel', '-' + overflow + 'px');
      heading.style.setProperty('--name-duration', Math.max(5, overflow / 24 + 3) + 's');
    });
  }
  new ResizeObserver(measureDeviceNames).observe($('#drawerDeviceList'));
  let drawerSignature = '';
  let drawerCloseTimer;
  function closeDeviceDrawer() {
    if (!deviceDrawer.open || deviceDrawer.classList.contains('closing')) return;
    deviceDrawer.classList.add('closing');
    drawerCloseTimer = setTimeout(() => {
      deviceDrawer.close();
      deviceDrawer.classList.remove('closing');
      dom.connectionBadge.setAttribute('aria-expanded', 'false');
      dom.connectionBadge.focus();
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
  }
  dom.connectionBadge.addEventListener('click', async () => {
    clearTimeout(drawerCloseTimer);
    deviceDrawer.classList.remove('closing');
    deviceDrawer.showModal();
    requestAnimationFrame(measureDeviceNames);
    dom.connectionBadge.setAttribute('aria-expanded', 'true');
    $('#closeDeviceDrawer').focus();
    $('#deviceDrawerStatus').textContent = 'Loading devices…';
    try { await refreshDevices(); $('#deviceDrawerStatus').textContent = ''; }
    catch (_) { $('#deviceDrawerStatus').textContent = 'Could not load devices. Close and reopen to retry.'; }
  });
  $('#closeDeviceDrawer').addEventListener('click', closeDeviceDrawer);
  deviceDrawer.addEventListener('cancel', event => { event.preventDefault(); closeDeviceDrawer(); });
  deviceDrawer.addEventListener('click', event => {
    const bounds = deviceDrawer.getBoundingClientRect();
    if (event.target === deviceDrawer && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDeviceDrawer();
  });
  function renderDrawerDevices(devices) {
    const signature = JSON.stringify(devices);
    if (signature === drawerSignature) return;
    drawerSignature = signature;
    const list = $('#drawerDeviceList');
    const focused = document.activeElement?.dataset.control;
    list.replaceChildren();
    if (!devices.length) {
      const empty = document.createElement('p');
      empty.className = 'drawer-description';
      empty.textContent = 'No paired devices. Create a pairing code in the Pair tab to connect your phone.';
      list.append(empty);
    }
    for (const device of devices) {
      const card = document.createElement('section'); card.className = 'device-card';
      const identity = document.createElement('div'); identity.className = 'device-identity';
      const heading = document.createElement('h3'); heading.className = 'device-name'; heading.title = device.name;
      const name = document.createElement('span'); name.textContent = device.name; heading.append(name);
      const status = document.createElement('p'); status.className = 'drawer-description';
      const permissions = { view: true, write: true, access: true, ...device.permissions };
      status.textContent = !permissions.access ? 'Access off' : device.connected ? 'Connected' : 'Offline';
      identity.append(heading, status); card.append(identity);
      const controls = document.createElement('div'); controls.className = 'device-controls';
      const actions = document.createElement('div'); actions.className = 'device-permissions';
      for (const [key, title, description] of [
        ['access', 'Access', 'Allow this device to connect without pairing again'],
        ['view', 'View', 'Read shared clipboard items and download files'],
        ['write', 'Write', 'Send clipboard items and files to this computer'],
      ]) {
        const control = document.createElement('button');
        control.type = 'button'; control.className = 'device-permission';
        const enabled = permissions[key];
        control.innerHTML = permissionIcon(key, enabled);
        control.setAttribute('aria-label', title);
        control.setAttribute('aria-pressed', String(enabled));
        control.title = title + ': ' + (enabled ? 'on' : 'off') + '. Click to turn ' + (enabled ? 'off' : 'on') + '. ' + description;
        control.dataset.control = device.id + ':' + key;
        control.disabled = key !== 'access' && !permissions.access;
        control.addEventListener('click', async () => {
          control.disabled = true;
          $('#deviceDrawerStatus').textContent = 'Saving permissions…';
          try {
            await window.quickclip.setDevicePermissions(device.id, { [key]: !enabled });
            await refreshDevices(); await refreshStatus();
            $('#deviceDrawerStatus').textContent = title + ' updated';
          } catch (_) {
            $('#deviceDrawerStatus').textContent = 'Could not save permission. Try again.';
          } finally { control.disabled = key !== 'access' && !permissions.access; }
        });
        actions.append(control);
      }
      controls.append(actions);
      const remove = document.createElement('button'); remove.className = 'device-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + device.name);
      remove.dataset.control = device.id + ':remove';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Remove ' + device.name + '? A new pairing code will be required to connect again.')) return;
        remove.disabled = true;
        try {
          await window.quickclip.revokeDevice(device.id); clearPairingCode();
          await refreshDevices(); await refreshStatus();
          $('#deviceDrawerStatus').textContent = 'Device removed';
          $('#closeDeviceDrawer').focus();
        } catch (_) { remove.disabled = false; $('#deviceDrawerStatus').textContent = 'Could not remove device. Try again.'; }
      });
      controls.append(remove); card.append(controls); list.append(card);
    }
    requestAnimationFrame(measureDeviceNames);
    if (focused) [...list.querySelectorAll('[data-control]')].find(node => node.dataset.control === focused)?.focus();
  }

  let settingsDevicesSignature = '';
  async function refreshDevices() {
    const container = $('#trustedDevices');
    const devices = await window.quickclip.getTrustedDevices();
    renderDrawerDevices(devices);
    const signature = JSON.stringify(devices);
    if (signature === settingsDevicesSignature) return;
    settingsDevicesSignature = signature;
    const focused = document.activeElement?.dataset.settingsDeviceControl;
    container.replaceChildren();
    if (!devices.length) container.textContent = 'No trusted devices';
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'settings-row settings-device-row';
      const label = document.createElement('div'); label.className = 'settings-label settings-device-name';
      const name = document.createElement('span'); name.className = 'settings-title'; name.textContent = device.name; name.title = device.name;
      const paired = document.createElement('span'); paired.className = 'settings-desc'; paired.textContent = device.connected ? 'Connected' : 'Offline'; paired.title = 'Paired ' + new Date(device.pairedAt).toLocaleString();
      label.append(name, paired);
      const controls = document.createElement('div'); controls.className = 'settings-device-controls';
      const permissions = { write: true, access: true, view: true, ...device.permissions };
      for (const [key, title, help] of [
        ['write', 'Write', 'Send clipboard items and files to this computer'],
        ['access', 'Access', 'Allow this device to connect without pairing again'],
        ['view', 'View', 'Read shared clipboard items and download files'],
      ]) {
        const group = document.createElement('div'); group.className = 'settings-device-toggle';
        const caption = document.createElement('label'); caption.textContent = title;
        const toggle = document.createElement('label'); toggle.className = 'apple-switch'; toggle.title = help;
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = permissions[key];
        input.id = 'device-setting-' + device.id + '-' + key; caption.htmlFor = input.id;
        input.dataset.settingsDeviceControl = device.id + ':' + key;
        input.disabled = key !== 'access' && !permissions.access;
        const slider = document.createElement('span'); slider.className = 'switch-slider'; slider.setAttribute('aria-hidden', 'true');
        input.addEventListener('change', async () => {
          input.disabled = true;
          try {
            await window.quickclip.setDevicePermissions(device.id, { [key]: input.checked });
            await refreshDevices(); await refreshStatus();
          } catch (_) {
            input.checked = permissions[key];
            showToast('Could not save device permission. Try again.', 'error');
          } finally { input.disabled = key !== 'access' && !permissions.access; }
        });
        toggle.append(input, slider); group.append(caption, toggle); controls.append(group);
      }
      const button = document.createElement('button'); button.className = 'device-remove settings-device-remove'; button.textContent = 'Remove'; button.setAttribute('aria-label', 'Remove ' + device.name);
      button.addEventListener('click', async () => {
        try { await window.quickclip.revokeDevice(device.id); clearPairingCode(); await refreshDevices(); await refreshStatus(); }
        catch (_) { showToast('Could not revoke device', 'error'); }
      });
      controls.append(button); row.append(label, controls); container.append(row);
    }
    if (focused) [...container.querySelectorAll('[data-settings-device-control]')].find(node => node.dataset.settingsDeviceControl === focused)?.focus();
  }
  for (const id of ['settingRemoteAccess', 'settingClipboardTtl', 'settingFileTtl', 'settingStorageQuota']) {
    $('#' + id).addEventListener('change', saveSettings);
  }
  $('#newPairingBtn').addEventListener('click', () => { switchTab('pair'); loadQRCode(); });
  $('#disconnectAllBtn').addEventListener('click', async () => {
    try {
      await window.quickclip.disconnectAll();
      clearPairingCode();
      await refreshDevices(); await refreshStatus();
      showToast('All devices removed. Generate a new code to pair again.');
    } catch (_) { showToast('Could not disconnect devices', 'error'); }
  });

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

    const copyButton = el.querySelector('.clip-copy-btn');
    copyButton.addEventListener('click', async () => {
      copyButton.disabled = true;
      copyButton.textContent = 'Copying…';
      try {
        const result = await window.quickclip.copyHistoryItem(item.id);
        if (!result.ok) throw new Error(result.error);
        copyButton.textContent = 'Copied ✓';
      } catch (err) {
        showToast(err.message || 'Copy failed', 'error');
      } finally {
        setTimeout(() => { copyButton.disabled = false; copyButton.textContent = 'Copy'; }, 1200);
      }
    });

    return el;
  }

  // Keep unchanged rows mounted so polling does not replay animations or lose focus.
  function reconcileRows(container, items, render) {
    const existing = new Map([...container.children].map(row => [row.dataset.id, row]));
    const keep = new Set();
    items.forEach((item, index) => {
      const id = String(item.id);
      const signature = JSON.stringify(item);
      let row = existing.get(id);
      if (!row || row.dataset.signature !== signature) {
        const next = render(item);
        next.dataset.id = id;
        next.dataset.signature = signature;
        if (row) row.replaceWith(next);
        row = next;
      }
      keep.add(row);
      if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
      const time = row.querySelector('.clip-time, .file-meta span:last-child');
      if (time) time.textContent = relativeTime(item.date || item.timestamp);
    });
    [...container.children].forEach(row => { if (!keep.has(row)) row.remove(); });
  }

  async function refreshHistory() {
    try {
      const history = await window.quickclip.getHistory();
      if (!dom.clipboardList) return;
      reconcileRows(dom.clipboardList, history || [], renderClipboardItem);
      dom.clearHistoryBtn.disabled = !history?.length;

      if (!history || history.length === 0) {
        if (dom.clipboardEmpty) dom.clipboardEmpty.classList.add('visible');
        dom.clipboardList.style.display = 'none';
        return;
      }

      if (dom.clipboardEmpty) dom.clipboardEmpty.classList.remove('visible');
      dom.clipboardList.style.display = 'flex';


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
      window.quickclip.openFile(file.path || file.id).then((ok) => { if (!ok) showToast('File could not be opened or is blocked for safety', 'error'); });
    });

    el.querySelector('.file-folder-btn').addEventListener('click', () => {
      window.quickclip.showInExplorer(file.path || file.id);
    });

    const remove = document.createElement('button');
    remove.className = 'btn btn-ghost btn-sm'; remove.textContent = 'Delete saved copy';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete the QuickClip saved copy? The original source file will not be deleted.')) return;
      try { await window.quickclip.deleteFile(file.id); await refreshFiles(); }
      catch (_) { showToast('Could not delete saved copy', 'error'); }
    });
    el.querySelector('.file-actions').append(remove);
    return el;
  }

  async function refreshFiles() {
    try {
      const files = await window.quickclip.getFiles();
      if (!dom.filesList) return;
      reconcileRows(dom.filesList, sortFiles(files || [], getFileSort()), renderFileItem);

      if (!files || files.length === 0) {
        if (dom.filesEmpty) dom.filesEmpty.classList.add('visible');
        dom.filesList.style.display = 'none';
        return;
      }

      if (dom.filesEmpty) dom.filesEmpty.classList.remove('visible');
      dom.filesList.style.display = 'flex';


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
      if (dom.setupContent) {
        dom.setupContent.classList.toggle('open', !expanded);
        dom.setupContent.inert = expanded;
      }
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
      dom.sendFilesBtn.disabled = true;
      dom.sendFilesBtn.setAttribute('aria-busy', 'true');
      try {
        const sent = await window.quickclip.selectAndSendFiles();
        if (sent && sent.length > 0) {
          refreshFiles();
          showToast(`${sent.length} file(s) ready to share`);
        }
      } catch (err) {
        console.error('Failed to share files:', err);
        showToast(err.message || 'Failed to share file', 'error');
      } finally {
        dom.sendFilesBtn.disabled = false;
        dom.sendFilesBtn.removeAttribute('aria-busy');
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

    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 550);
  }

  function initRipples() {
    document.querySelectorAll('.btn, .accordion-trigger, .server-url-wrap').forEach((el) => {
      el.addEventListener('click', addRipple);

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
      refreshHistory();
      refreshDevices();
    }, 5000);
  }

  // ---------- Initialise ----------
  async function init() {
    switchTab('pair');
    dom.setupContent.inert = true;
    await Promise.all([

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
