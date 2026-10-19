'use strict';
const crypto = require('crypto');

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
    throw new Error('Password must contain 1 to 128 characters');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128 || !/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored)) return false;
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 32), Buffer.from(hash, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
