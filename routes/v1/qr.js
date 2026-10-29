'use strict';
const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// Durata default del link QR: 7 giorni (configurabile via env)
const QR_TTL_SECS = parseInt(process.env.QR_TOKEN_TTL_SECS || '604800', 10);

/**
 * Genera HMAC-SHA256 del messaggio `${siteId}.${exp}`.
 * @throws {Error} se QR_SIGNING_SECRET non è configurato
 */
function signQrToken(siteId, exp) {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret) throw new Error('QR_SIGNING_SECRET not configured');
  return crypto
    .createHmac('sha256', secret)
    .update(`${siteId}.${exp}`)
    .digest('hex');
}

/**
 * Verifica HMAC con confronto a tempo costante.
 * Restituisce true se il token è valido.
 */
function verifyQrToken(siteId, token, exp) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const expected = signQrToken(siteId, exp);
  return crypto.timingSafeEqual(
    Buffer.from(token, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

// F-405 (F-363): il cartello appeso all'ingresso vale finché c'è il cantiere.
// ttl_days=cantiere → firma lunga 10 anni; il QR smette di funzionare quando il
// cantiere viene eliminato (controllo in /scan/identify e /scan/worksites).
const PER_CANTIERE_SECS = 10 * 365 * 86400;

/** Durata del QR dalla query: 'cantiere', N giorni (max 365) o il default. */
function ttlSecsDa(query, defaultSecs) {
  if (query.ttl_days === 'cantiere') return PER_CANTIERE_SECS;
  const rawDays = parseInt(query.ttl_days, 10);
  return (!query.ttl_days || isNaN(rawDays) || rawDays <= 0) ? defaultSecs : Math.min(rawDays, 365) * 86400;
}

// GET /api/v1/sites/:siteId/qr-link — PRIVATO (JWT)
// Restituisce il link firmato da incorporare nel QR code.
// SECURITY: verifica che il cantiere appartenga a req.companyId (no cross-company QR).
router.get('/sites/:siteId/qr-link', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  // Verifica ownership: il cantiere deve appartenere alla company autenticata
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const ttlSecs = ttlSecsDa(req.query, QR_TTL_SECS);
  const exp = Math.floor(Date.now() / 1000) + ttlSecs;

  let token;
  try {
    token = signQrToken(siteId, exp);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  // URL formato: /scan/<siteId>?t=<token>&exp=<unix>
  // scan.html legge siteId dal path e il token dalla query string
  const url = `${appBase}/scan/${encodeURIComponent(siteId)}?t=${token}&exp=${exp}`;

  res.json({
    url,
    siteId,
    token,
    exp,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlDays: Math.round(ttlSecs / 86400),
    perCantiere: ttlSecs === PER_CANTIERE_SECS,
  });
});

module.exports = router;
module.exports.signQrToken   = signQrToken;
module.exports.verifyQrToken = verifyQrToken;
module.exports.ttlSecsDa     = ttlSecsDa;
module.exports.PER_CANTIERE_SECS = PER_CANTIERE_SECS;
