'use strict';
const crypto = require('crypto');

/**
 * Hashing PIN con HMAC-SHA256.
 *
 * Non usiamo bcrypt per evitare dipendenze. HMAC-SHA256 è difendibile
 * per PIN brevi SOLO perché la chiave PIN_SIGNING_SECRET è segreta e
 * non si trova nel DB. Un attacker con accesso al DB non può fare
 * brute-force senza conoscere il secret.
 *
 * PIN_SIGNING_SECRET deve essere >= 32 char casuali in .env.
 */
function hashPin(pin) {
  const secret = process.env.PIN_SIGNING_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('PIN_SIGNING_SECRET mancante o troppo corto (min 16 char)');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(String(pin).trim())
    .digest('hex');
}

/**
 * Confronto timing-safe tra PIN in chiaro e hash salvato in DB.
 * Returns true se il PIN è corretto.
 */
function verifyPin(pin, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  let computed;
  try {
    computed = hashPin(pin);
  } catch {
    return false;
  }
  // Entrambi i buffer devono avere la stessa lunghezza (64 hex chars da SHA-256)
  const a = Buffer.from(computed,    'hex');
  const b = Buffer.from(storedHash,  'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { hashPin, verifyPin };
