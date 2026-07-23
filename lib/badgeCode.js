'use strict';
const crypto = require('crypto');

// Genera codice badge univoco: 9 byte → 18 char hex uppercase.
// Spazio 2^72 — praticamente non enumerabile.
// Estratto in un modulo condiviso il 2026-07-22 (audit F-013/F-023): era
// duplicato in workers.js/studio.js/scan.js e mancava del tutto in
// workerInvite.js, causando un NOT NULL violation su ogni self-service invite.
function generateBadgeCode() {
  return crypto.randomBytes(9).toString('hex').toUpperCase();
}

module.exports = { generateBadgeCode };
