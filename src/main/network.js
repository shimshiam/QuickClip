'use strict';

const os = require('os');
const crypto = require('crypto');
const { isIPv4 } = require('net');

// ── Module state ────────────────────────────────────────────────────────────────
let bonjourInstance = null;
let publishedService = null;

// ── getLocalIP ──────────────────────────────────────────────────────────────────
/**
 * Rank likely LAN addresses ahead of virtual/VPN and link-local adapters.
 * Names are a heuristic, so every usable address remains available to select.
 */
function getNetworkInterfaces() {
  try {
    const candidates = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const iface of addresses || []) {
        if (iface.internal || !['IPv4', 4].includes(iface.family) || !isIPv4(iface.address)) continue;
        const [a, b] = iface.address.split('.').map(Number);
        if (a === 0 || a === 127 || a >= 224) continue;
        const privateIP = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
        const virtual = /vethernet|hyper-v|wsl|docker|vmware|virtualbox|vbox|virtual|vpn|tailscale|zerotier|wireguard|openvpn|hamachi|tunnel|\btun\d*\b|\btap\b/i.test(name);
        const physical = /wi-?fi|wireless|wlan|ethernet|^en\d|^eth\d/i.test(name);
        let score = (privateIP ? 100 : 0) + (physical ? 20 : 0);
        if (virtual) score -= 1000;
        if (a === 100 && b >= 64 && b <= 127) score -= 1000;
        if (a === 169 && b === 254) score -= 2000;
        if (!candidates.some((entry) => entry.name === name && entry.address === iface.address)) {
          candidates.push({ name, address: iface.address, score });
        }
      }
    }
    // Stable ties avoid changing the pairing IP when OS enumeration order changes.
    return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  } catch (err) {
    console.error('[Network] Failed to enumerate network interfaces:', err.message);
    return [];
  }
}

function selectNetworkInterface(candidates, preferred) {
  // Follow the selected adapter across DHCP changes; fall back if it disappears.
  return candidates.find((entry) => entry.name === preferred?.name && entry.address === preferred?.address)
    || candidates.find((entry) => entry.name === preferred?.name)
    || candidates[0];
}

function getLocalIP(preferred) {
  return selectNetworkInterface(getNetworkInterfaces(), preferred)?.address || '127.0.0.1';
}

// ── generateQRCode ──────────────────────────────────────────────────────────────
/**
 * Generates a QR-code data-URL (PNG) that encodes the server connection info.
 * @param {string} serverUrl  - e.g. "https://192.168.1.42:8443"
 * @param {string} pairingToken
 * @returns {Promise<string>} Base-64 data URL
 */
async function generateQRCode(serverUrl, pairingToken) {
  try {
    const QRCode = require('qrcode');
    const pairingURL = new URL(serverUrl);
    pairingURL.hash = new URLSearchParams({ ip: pairingURL.hostname, port: pairingURL.port || '8443', token: pairingToken }).toString();
    const payload = pairingURL.href;
    const dataUrl = await QRCode.toDataURL(payload, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
    return dataUrl;
  } catch (err) {
    console.error('[Network] QR code generation failed:', err.message);
    return '';
  }
}

// ── generatePairingToken ────────────────────────────────────────────────────────
/**
 * Returns a new cryptographically random UUID suitable for use as a pairing
 * token.
 * @returns {string}
 */
function generatePairingToken() {
  return crypto.randomUUID();
}

// ── mDNS (Bonjour) ─────────────────────────────────────────────────────────────
/**
 * Advertises QuickClip on the local network via mDNS / Bonjour.
 * @param {number} port
 */
function startMDNS(port) {
  try {
    const { Bonjour } = require('bonjour-service');
    bonjourInstance = new Bonjour();
    publishedService = bonjourInstance.publish({
      name: 'QuickClip',
      type: 'https',
      port,
    });
    console.log(`[Network] mDNS service published on port ${port}`);
  } catch (err) {
    console.error('[Network] Failed to start mDNS:', err.message);
  }
}

/**
 * Tears down the mDNS advertisement.
 */
function stopMDNS() {
  try {
    if (publishedService) {
      publishedService.stop(() => {
        console.log('[Network] mDNS service unpublished');
      });
      publishedService = null;
    }
    if (bonjourInstance) {
      bonjourInstance.destroy();
      bonjourInstance = null;
    }
  } catch (err) {
    console.error('[Network] Failed to stop mDNS:', err.message);
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────────
module.exports = {
  getLocalIP,
  getNetworkInterfaces,
  selectNetworkInterface,
  generateQRCode,
  generatePairingToken,
  startMDNS,
  stopMDNS,
};
