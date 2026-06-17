'use strict';
const crypto = require('crypto');

const TOKEN_TTL = 30 * 24 * 60 * 60; // 30 giorni — il lavoratore autentica una volta col CF, poi il dispositivo resta loggato

function getSecret() {
  const s = process.env.WORKER_AREA_SECRET || process.env.QR_SIGNING_SECRET;
  if (!s) throw new Error('WORKER_AREA_SECRET (or QR_SIGNING_SECRET fallback) not configured');
  return s;
}

function signWorkerToken({ workerId, companyId, badgeCode }) {
  const payload = {
    wid: workerId,
    cid: companyId,
    bc:  badgeCode,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyWorkerToken(token) {
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
    if (!payload.wid || !payload.cid || !payload.bc) return null;
    return payload;
  } catch {
    return null;
  }
}

function compareCf(input, stored) {
  if (!input || !stored) return false;
  const a = Buffer.from(String(input).toUpperCase().trim());
  const b = Buffer.from(String(stored).toUpperCase().trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWorkerArea(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('WorkerArea ')) {
    return res.status(401).json({ error: 'AUTH_REQUIRED' });
  }
  const payload = verifyWorkerToken(auth.slice(11));
  if (!payload) {
    return res.status(401).json({ error: 'TOKEN_EXPIRED_OR_INVALID' });
  }
  const urlCode = req.params.code?.toUpperCase();
  if (urlCode && payload.bc !== urlCode) {
    return res.status(403).json({ error: 'TOKEN_BADGE_MISMATCH' });
  }
  req.workerPayload = payload;
  next();
}

module.exports = { signWorkerToken, verifyWorkerToken, compareCf, verifyWorkerArea, TOKEN_TTL };
