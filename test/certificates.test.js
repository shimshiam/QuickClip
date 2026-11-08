'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { load, temporary } = require('./helpers');
const { generateCertificates } = require('../src/main/certificates');
const DAY = 24 * 60 * 60 * 1000;

test('startup renews due certificates with the original CA and reuses healthy certificates', async (t) => {
  const root = temporary(t), ip = '192.168.1.70';
  const initial = await generateCertificates(root, ip);
  const certs = path.join(root, 'certs');
  const caKey = fs.readFileSync(path.join(certs, 'ca.key'), 'utf8');
  const expires = Date.parse(new X509Certificate(initial.cert).validTo);
  const starts = Date.parse(new X509Certificate(initial.cert).validFrom);
  const atTime = (now) => load('src/main/certificates.js', {}, { Date: { now: () => now, parse: Date.parse } });
  const restore = () => {
    fs.writeFileSync(path.join(certs, 'server.crt'), initial.cert);
    fs.writeFileSync(path.join(certs, 'server.key'), initial.key);
    fs.writeFileSync(path.join(certs, 'ip.txt'), ip);
  };
  const verify = (result, expectedIP = ip) => {
    const parsed = new X509Certificate(result.cert);
    assert.equal(result.ca, initial.ca);
    assert.equal(fs.readFileSync(path.join(certs, 'ca.key'), 'utf8'), caKey);
    assert.equal(parsed.verify(new X509Certificate(initial.ca).publicKey), true);
    assert.equal(parsed.checkPrivateKey(createPrivateKey(result.key)), true);
    assert.equal(parsed.checkIP(expectedIP), expectedIP);
    assert.ok(Date.parse(parsed.validTo) > Date.now() + 300 * DAY);
    assert.equal(fs.readFileSync(path.join(certs, 'server.crt'), 'utf8'), result.cert);
    assert.equal(fs.readFileSync(path.join(certs, 'server.key'), 'utf8'), result.key);
  };
  const healthy = await atTime(expires - 30 * DAY - 1).generateCertificates(root, ip);
  assert.equal(healthy.cert, initial.cert);
  assert.equal(healthy.key, initial.key);
  for (const [label, now] of [['30-day boundary', expires - 30 * DAY], ['expired', expires + DAY]]) {
    await t.test(label, async () => {
      restore();
      const result = await atTime(now).generateCertificates(root, ip);
      assert.notEqual(result.cert, initial.cert);
      verify(result);
    });
  }
  await assert.rejects(atTime(starts - DAY).generateCertificates(root, ip), /local CA is invalid/);
  for (const filename of ['server.crt', 'server.key']) {
    restore(); fs.unlinkSync(path.join(certs, filename));
    verify(await generateCertificates(root, ip));
  }
  restore(); fs.writeFileSync(path.join(certs, 'server.crt'), 'invalid certificate');
  verify(await generateCertificates(root, ip));
  restore(); fs.writeFileSync(path.join(certs, 'server.key'), caKey);
  verify(await generateCertificates(root, ip));
  restore(); verify(await generateCertificates(root, '192.168.1.71'), '192.168.1.71');
  restore();
  const failing = load('src/main/certificates.js', { './cert-authority': { hasNameConstraints: () => true, isPermittedAddress: () => true, createCert: async () => { throw new Error('Signing failed'); } } },
    { Date: { now: () => expires, parse: Date.parse } });
  await assert.rejects(failing.generateCertificates(root, ip), /Signing failed/);
  assert.equal(fs.readFileSync(path.join(certs, 'server.crt'), 'utf8'), initial.cert);
  assert.equal(fs.readFileSync(path.join(certs, 'ca.key'), 'utf8'), caKey);
});

test('certificate protection fails closed and incomplete CA files are preserved', async (t) => {
  const root = temporary(t), certs = path.join(root, 'certs');
  fs.mkdirSync(certs);
  fs.writeFileSync(path.join(certs, 'ca.crt'), 'original CA');
  let signed = false;
  const generator = load('src/main/certificates.js', {
    './certificate-permissions': { protectCertificateDirectory() { throw new Error('ACL denied'); } },
    './cert-authority': { hasNameConstraints: () => true, isPermittedAddress: () => true, createCA() { signed = true; } },
  });
  await assert.rejects(generator.generateCertificates(root, '127.0.0.1'), /ACL denied/);
  assert.equal(signed, false);
  await assert.rejects(generateCertificates(root, '127.0.0.1'), /CA is incomplete/);
  assert.equal(fs.readFileSync(path.join(certs, 'ca.crt'), 'utf8'), 'original CA');
  assert.equal(fs.existsSync(path.join(certs, 'ca.key')), false);
});

const forge = require('node-forge');
const { execFileSync } = require('node:child_process');
const { createCA, createCert, hasNameConstraints } = require('../src/main/cert-authority');

function unconstrainedCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.serialNumber = '01'; cert.publicKey = keys.publicKey;
  cert.validity.notBefore = new Date(Date.now() - DAY); cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const attrs = [{ name: 'commonName', value: 'QuickClip' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, critical: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

test('the CA is name-constrained to localhost and private IPv4 ranges', async (t) => {
  const root = temporary(t);
  const result = await generateCertificates(root, '192.168.1.70');
  assert.equal(result.rotated, false);
  assert.equal(hasNameConstraints(result.ca), true);
  const ext = forge.pki.certificateFromPem(result.ca).getExtension({ id: '2.5.29.30' });
  assert.equal(ext.critical, true);
  const permitted = forge.asn1.fromDer(ext.value).value[0].value.map((subtree) => subtree.value[0]);
  const names = permitted.map((name) => name.type === 2 ? 'DNS:' + name.value
    : 'IP:' + [...Buffer.from(name.value, 'binary')].slice(0, 4).join('.') + '/' + [...Buffer.from(name.value, 'binary')].slice(4).join('.'));
  assert.deepEqual(names, ['DNS:localhost', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0',
    'IP:100.64.0.0/255.192.0.0', 'IP:169.254.0.0/255.255.0.0', 'IP:127.0.0.0/255.0.0.0']);
  const server = new X509Certificate(result.cert);
  assert.equal(server.checkIP('192.168.1.70'), '192.168.1.70');
  assert.equal(server.verify(new X509Certificate(result.ca).publicKey), true);
});

test('an independent validator rejects public names signed by the constrained CA', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (_) { t.skip('openssl is not installed'); return; }
  const root = temporary(t);
  const ca = await createCA();
  fs.writeFileSync(path.join(root, 'ca.crt'), ca.cert);
  const verify = async (domains) => {
    const file = path.join(root, domains.join('_').replace(/[^a-z0-9.]/gi, '_') + '.crt');
    fs.writeFileSync(file, (await createCert({ ca, domains })).cert);
    try { execFileSync('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', path.join(root, 'ca.crt'), file], { stdio: 'pipe' }); return true; }
    catch (_) { return false; }
  };
  assert.equal(await verify(['192.168.1.70', '127.0.0.1', 'localhost']), true);
  assert.equal(await verify(['10.0.0.8']), true);
  assert.equal(await verify(['www.google.com']), false);
  assert.equal(await verify(['8.8.8.8']), false);
  assert.equal(await verify(['192.168.1.70', 'bank.example.com']), false);
});

test('an unrestricted legacy CA is replaced once with a constrained CA', async (t) => {
  const root = temporary(t), certs = path.join(root, 'certs');
  const legacy = unconstrainedCA();
  fs.mkdirSync(certs);
  fs.writeFileSync(path.join(certs, 'ca.crt'), legacy.cert);
  fs.writeFileSync(path.join(certs, 'ca.key'), legacy.key);
  const rotated = await generateCertificates(root, '192.168.1.70');
  assert.equal(rotated.rotated, true);
  assert.notEqual(rotated.ca, legacy.cert);
  assert.equal(hasNameConstraints(rotated.ca), true);
  assert.notEqual(fs.readFileSync(path.join(certs, 'ca.key'), 'utf8'), legacy.key);
  assert.equal(new X509Certificate(rotated.cert).verify(new X509Certificate(rotated.ca).publicKey), true);
  require('../src/main/certificates').acknowledgeRotation(root);
  const again = await generateCertificates(root, '192.168.1.70');
  assert.equal(again.rotated, false);
  assert.equal(again.ca, rotated.ca);
});

test('serial numbers are always positive, minimal DER', async () => {
  const ca = await createCA();
  for (let i = 0; i < 20; i++) {
    const serial = Buffer.from(new X509Certificate((await createCert({ ca, domains: ['127.0.0.1'] })).cert).serialNumber, 'hex');
    assert.ok(serial[0] >= 0x40 && serial[0] < 0x80, serial.toString('hex'));
  }
});

test('the CA replacement notice survives a failed start until acknowledged', async (t) => {
  const { acknowledgeRotation } = require('../src/main/certificates');
  const root = temporary(t), certs = path.join(root, 'certs');
  const legacy = unconstrainedCA();
  fs.mkdirSync(certs);
  fs.writeFileSync(path.join(certs, 'ca.crt'), legacy.cert);
  fs.writeFileSync(path.join(certs, 'ca.key'), legacy.key);
  const failing = load('src/main/certificates.js', { './cert-authority': { ...require('../src/main/cert-authority'),
    createCA: async () => { throw new Error('crashed mid-rotation'); } } });
  await assert.rejects(failing.generateCertificates(root, '192.168.1.70'), /crashed mid-rotation/);
  assert.equal((await generateCertificates(root, '192.168.1.70')).rotated, true, 'retry still reports rotation');
  assert.equal((await generateCertificates(root, '192.168.1.70')).rotated, true, 'until acknowledged');
  acknowledgeRotation(root);
  assert.equal((await generateCertificates(root, '192.168.1.70')).rotated, false);
});

test('a CA whose restrictions cannot be confirmed (EC key) is replaced, not trusted', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (_) { t.skip('openssl is not installed'); return; }
  const root = temporary(t), certs = path.join(root, 'certs');
  fs.mkdirSync(certs);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
    '-subj', '/CN=Restored EC CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', path.join(certs, 'ca.key'), '-out', path.join(certs, 'ca.crt')], { stdio: 'ignore' });
  const ecCA = fs.readFileSync(path.join(certs, 'ca.crt'), 'utf8');
  assert.throws(() => hasNameConstraints(ecCA));
  const result = await generateCertificates(root, '192.168.1.70');
  assert.equal(result.rotated, true);
  assert.notEqual(result.ca, ecCA);
  assert.equal(hasNameConstraints(result.ca), true);
});
