'use strict';

const fs = require('fs');
const path = require('path');

/**
 * QuickClip – Local CA + Server Certificate Generation
 *
 * Uses the `mkcert` npm package to create a local Certificate Authority and
 * per-IP server certificates.  Certs are persisted to `<dataDir>/certs/` and
 * only regenerated when the machine's LAN IP changes.
 */

// ── generateCertificates ────────────────────────────────────────────────────────
/**
 * @param {string} dataDir  – Absolute path to the application data directory
 * @param {string} localIP  – Current LAN IPv4 address (e.g. "192.168.1.42")
 * @returns {Promise<{ ca: string, cert: string, key: string, caPath: string }>}
 */
async function generateCertificates(dataDir, localIP) {
  const { createCA, createCert } = require('mkcert');

  const certsDir = path.join(dataDir, 'certs');
  const caPath   = path.join(certsDir, 'ca.crt');
  const caKeyPath = path.join(certsDir, 'ca.key');
  const certPath = path.join(certsDir, 'server.crt');
  const keyPath  = path.join(certsDir, 'server.key');
  const ipPath   = path.join(certsDir, 'ip.txt');

  try {
    // ── First-run: no CA exists yet ───────────────────────────────────────────
    if (!fs.existsSync(caPath) || !fs.existsSync(caKeyPath)) {
      console.log('[Certs] First run – generating CA and server certificate…');

      fs.mkdirSync(certsDir, { recursive: true });

      // 1. Create CA
      const ca = await createCA({
        organization: 'QuickClip',
        countryCode: 'US',
        state: 'Local',
        locality: 'Local',
        validity: 3650, // ~10 years
      });

      // 2. Create server cert signed by the CA
      const serverCert = await createCert({
        ca: { key: ca.key, cert: ca.cert },
        domains: [localIP, '127.0.0.1', 'localhost'],
        validity: 365,
      });

      // 3. Persist everything
      fs.writeFileSync(caPath, ca.cert, 'utf-8');
      fs.writeFileSync(caKeyPath, ca.key, 'utf-8');
      fs.writeFileSync(certPath, serverCert.cert, 'utf-8');
      fs.writeFileSync(keyPath, serverCert.key, 'utf-8');
      fs.writeFileSync(ipPath, localIP, 'utf-8');

      console.log('[Certs] CA and server certificate generated for', localIP);

      return {
        ca: ca.cert,
        cert: serverCert.cert,
        key: serverCert.key,
        caPath,
      };
    }

    // ── Subsequent runs ───────────────────────────────────────────────────────
    const caCert  = fs.readFileSync(caPath, 'utf-8');
    const caKey   = fs.readFileSync(caKeyPath, 'utf-8');
    let   cert    = fs.readFileSync(certPath, 'utf-8');
    let   key     = fs.readFileSync(keyPath, 'utf-8');
    const lastIP  = fs.existsSync(ipPath) ? fs.readFileSync(ipPath, 'utf-8').trim() : '';

    // IP changed → regenerate server cert only
    if (lastIP !== localIP) {
      console.log(`[Certs] IP changed (${lastIP} → ${localIP}), regenerating server certificate…`);

      const serverCert = await createCert({
        ca: { key: caKey, cert: caCert },
        domains: [localIP, '127.0.0.1', 'localhost'],
        validity: 365,
      });

      cert = serverCert.cert;
      key  = serverCert.key;

      fs.writeFileSync(certPath, cert, 'utf-8');
      fs.writeFileSync(keyPath, key, 'utf-8');
      fs.writeFileSync(ipPath, localIP, 'utf-8');

      console.log('[Certs] Server certificate regenerated for', localIP);
    } else {
      console.log('[Certs] Loaded existing certificates for', localIP);
    }

    return { ca: caCert, cert, key, caPath };
  } catch (err) {
    console.error('[Certs] Certificate generation failed:', err);
    throw err; // Propagate — the server cannot start without certs
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────────
module.exports = {
  generateCertificates,
};
