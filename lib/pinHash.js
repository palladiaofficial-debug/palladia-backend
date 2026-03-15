'use strict';
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

/**
 * Hash PIN with bcrypt (async).
 */
async function hashPin(pin) {
  return bcrypt.hash(String(pin).trim(), SALT_ROUNDS);
}

/**
 * Verify PIN with bcrypt. Returns boolean.
 */
async function verifyPin(pin, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  return bcrypt.compare(String(pin).trim(), storedHash);
}

module.exports = { hashPin, verifyPin };
