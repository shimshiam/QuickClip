'use strict';

const crypto = require('crypto');
const net = require('net');
const forge = require('node-forge');

const { asn1 } = forge;
const NAME_CONSTRAINTS_OID = '2.5.29.30';

// The phone trusts this CA as a root. Name constraints limit it to names a
// LAN server can use, so a leaked CA key cannot impersonate public websites.
// IPv4 private, CGNAT/Tailscale, link-local, and loopback ranges are permitted;
// every other IP (including all IPv6) and every DNS name except localhost is not.
const PERMITTED_IPV4 = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const PERMITTED_DNS = ['localhost'];

const ipv4Bytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));
const contextPrimitive = (tag, bytes) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, false, bytes);

function nameConstraintsExtension() {
  const subtree = (generalName) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  const permitted = [
    ...PERMITTED_DNS.map((name) => subtree(contextPrimitive(2, name))),
    ...PERMITTED_IPV4.map(([ip, mask]) => subtree(contextPrimitive(7, ipv4Bytes(ip) + ipv4Bytes(mask)))),
  ];
  const value = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, permitted),
  ]);
  return { id: NAME_CONSTRAINTS_OID, critical: true, value };
}

function isPermittedAddress(ip) {
  if (!net.isIPv4(ip)) return false;
  const value = (address) => address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  return PERMITTED_IPV4.some(([base, mask]) => {
    const m = value(mask);
    return (value(ip) & m) >>> 0 === (value(base) & m) >>> 0;
  });
}

function hasNameConstraints(certPem) {
  return !!forge.pki.certificateFromPem(certPem).getExtension({ id: NAME_CONSTRAINTS_OID });
}

function newKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const forgeKey = forge.pki.privateKeyFromPem(pem);
  return { pem, privateKey: forgeKey, publicKey: forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e) };
}

function baseCertificate(publicKey, days) {
  const cert = forge.pki.createCertificate();
  const serial = crypto.randomBytes(16);
  // Positive (high bit clear) and minimal DER (first byte never 0x00).
  serial[0] = (serial[0] & 0x7f) | 0x40;
  cert.serialNumber = serial.toString('hex');
  cert.publicKey = publicKey;
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000); // tolerate small clock skew
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return cert;
}

async function createCA({ validity = 3650 } = {}) {
  const keys = newKeyPair();
  const cert = baseCertificate(keys.publicKey, validity);
  // A distinct, dated name keeps iOS from confusing it with older QuickClip roots.
  const attributes = [
    { name: 'commonName', value: `QuickClip Local Network CA ${new Date().toISOString().slice(0, 10)}` },
    { name: 'organizationName', value: 'QuickClip' },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    // TLS server certificates only (no S/MIME or code signing for arbitrary names).
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    nameConstraintsExtension(),
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.pem, cert: forge.pki.certificateToPem(cert) };
}

async function createCert({ ca, domains, validity = 365 }) {
  if (!Array.isArray(domains) || !domains.length) throw new Error('At least one certificate name is required');
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const keys = newKeyPair();
  const cert = baseCertificate(keys.publicKey, validity);
  // Names live in subjectAltName. A hostname-like CN (e.g. an IP) would be checked
  // against the DNS constraints by some validators and fail, so use a plain label.
  cert.setSubject([{ name: 'commonName', value: 'QuickClip Server' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: domains.map((domain) => (net.isIP(domain) ? { type: 7, ip: domain } : { type: 2, value: domain })) },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { key: keys.pem, cert: forge.pki.certificateToPem(cert) };
}

module.exports = { createCA, createCert, hasNameConstraints, isPermittedAddress, PERMITTED_IPV4 };
