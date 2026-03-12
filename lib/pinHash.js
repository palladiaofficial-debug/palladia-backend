'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SALT_ROUNDS = 10;

/**
 * Detects whether a stored hash is a bcrypt hash.
 * bcrypt hashes start with $2b$, $2a$, or $2y$.
 */
function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$/.test(hash);
}

/**
 * Hash PIN with bcrypt (async).
 */
async function hashPin(pin) {
  return bcrypt.hash(String(pin).trim(), SALT_ROUNDS);
}

/**
 * Verify PIN supporting both bcrypt (current) and HMAC-SHA256 (legacy).
 *
 * Returns { valid: boolean, usedLegacy: boolean }
 *   usedLegacy=true → caller should rehash with bcrypt and update the DB.
 *
 * Migration path:
 *   1. New sites → hashPin() → bcrypt stored, verifyPin returns usedLegacy=false
 *   2. Old sites → HMAC stored, verifyPin falls back to HMAC, returns usedLegacy=true
 *   3. Caller triggers async rehash → next login uses bcrypt
 *   4. After all sites migrated → remove HMAC fallback (grep usedLegacy references)
 */
async function verifyPin(pin, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    return { valid: false, usedLegacy: false };
  }

  // ── Path A: bcrypt hash ─────────────────────────────────────────────────────
  if (isBcryptHash(storedHash)) {
    const valid = await bcrypt.compare(String(pin).trim(), storedHash);
    return { valid, usedLegacy: false };
  }

  // ── Path B: legacy HMAC-SHA256 hash ────────────────────────────────────────
  // Requires PIN_SIGNING_SECRET env var (must still be present during migration).
  const secret = process.env.PIN_SIGNING_SECRET;
  if (!secret || secret.length < 16) {
    // Secret not configured → can't verify legacy hash → reject
    console.error('[pinHash] legacy HMAC hash found but PIN_SIGNING_SECRET not set');
    return { valid: false, usedLegacy: false };
  }

  let valid = false;
  try {
    const computed = crypto.createHmac('sha256', secret).update(String(pin).trim()).digest('hex');
    const a = Buffer.from(computed,    'hex');
    const b = Buffer.from(storedHash,  'hex');
    if (a.length === b.length) {
      valid = crypto.timingSafeEqual(a, b);
    }
  } catch {
    valid = false;
  }

  // usedLegacy=true only on successful verification — avoids false rehash trigger
  return { valid, usedLegacy: valid };
}

module.exports = { hashPin, verifyPin };
