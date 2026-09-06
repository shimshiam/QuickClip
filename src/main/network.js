'use strict';

const os = require('os');
const crypto = require('crypto');

// ── Module state ────────────────────────────────────────────────────────────────
let bonjourInstance = null;
let publishedService = null;

// ── getLocalIP ──────────────────────────────────────────────────────────────────
/**
 * Returns the first non-internal IPv4 address found on any network interface.
 * Falls back to '127.0.0.1' when no suitable address is available.
 * @returns {string}
 */
function getLocalIP() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) and non-IPv4 addresses
        if (!iface.internal && iface.family === 'IPv4') {
          return iface.address;
        }
      }
    }
  } catch (err) {
    console.error('[Network] Failed to enumerate network interfaces:', err.message);
  }
  return '127.0.0.1';
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
  generateQRCode,
  generatePairingToken,
  startMDNS,
  stopMDNS,
};
