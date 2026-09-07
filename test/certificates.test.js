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
  for (const [label, now] of [['30-day boundary', expires - 30 * DAY], ['expired', expires + DAY], ['not yet valid', starts - DAY]]) {
    await t.test(label, async () => {
      restore();
      const result = await atTime(now).generateCertificates(root, ip);
      assert.notEqual(result.cert, initial.cert);
      verify(result);
    });
  }
  for (const filename of ['server.crt', 'server.key']) {
    restore(); fs.unlinkSync(path.join(certs, filename));
    verify(await generateCertificates(root, ip));
  }
  restore(); fs.writeFileSync(path.join(certs, 'server.crt'), 'invalid certificate');
  verify(await generateCertificates(root, ip));
  restore(); verify(await generateCertificates(root, '192.168.1.71'), '192.168.1.71');
  restore();
  const failing = load('src/main/certificates.js', { mkcert: { createCert: async () => { throw new Error('Signing failed'); } } },
    { Date: { now: () => expires, parse: Date.parse } });
  await assert.rejects(failing.generateCertificates(root, ip), /Signing failed/);
  assert.equal(fs.readFileSync(path.join(certs, 'server.crt'), 'utf8'), initial.cert);
  assert.equal(fs.readFileSync(path.join(certs, 'ca.key'), 'utf8'), caKey);
});
