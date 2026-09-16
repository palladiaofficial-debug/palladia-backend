'use strict';
const crypto = require('crypto');

// Stesso schema di lib/workerAuth.js, per l'accesso esterno di chi fa i
// bonifici (studio/professionista) alla lista buste paga (migrazione 214).
// TTL più corto del lavoratore: non è un dispositivo personale che resta
// loggato per settimane, ma un controllo mensile ricorrente da un browser
// condiviso in ufficio — 7 giorni è comodo senza restare aperto per sempre.
const TOKEN_TTL = 7 * 24 * 60 * 60;

function getSecret() {
  const s = process.env.WORKER_AREA_SECRET || process.env.QR_SIGNING_SECRET;
  if (!s) throw new Error('WORKER_AREA_SECRET (or QR_SIGNING_SECRET fallback) not configured');
  return s;
}

function signPayerToken({ companyId, accessCode }) {
  const payload = {
    cid: companyId,
    ac:  accessCode,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyPayerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1 || dot === 0 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig        = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');

  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.cid || !payload.ac) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPayerArea(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('PayerArea ')) {
    return res.status(401).json({ error: 'AUTH_REQUIRED' });
  }
  const payload = verifyPayerToken(auth.slice(10));
  if (!payload) {
    return res.status(401).json({ error: 'TOKEN_EXPIRED_OR_INVALID' });
  }
  const urlCode = req.params.code?.toUpperCase();
  if (urlCode && payload.ac !== urlCode) {
    return res.status(403).json({ error: 'TOKEN_CODE_MISMATCH' });
  }
  req.payerPayload = payload;
  next();
}

module.exports = { signPayerToken, verifyPayerToken, verifyPayerArea, TOKEN_TTL };
