'use strict';
/**
 * lib/psc/http.js — F-270. Pezzi comuni alle rotte del modulo coordinatori.
 */
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isFeatureEnabled } = require('../featureFlags');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID.test(String(s || ''));

/** Coordinatore autenticato con il modulo acceso. */
async function requirePsc(req, res, next) {
  try {
    if (!(await isFeatureEnabled(req.companyId, 'psc_coordinatori'))) {
      return res.status(403).json({ error: 'FEATURE_DISABLED', message: 'Palladia Coordinatori non è attivo per questo account.' });
    }
    next();
  } catch (e) { next(e); }
}
const auth = [verifySupabaseJwt, requirePsc];

/** Gestione errori uniforme per le rotte async. */
const h = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error('[psc]', req.method, req.originalUrl, err && (err.stack || err.message));
    if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'INTERNAL' : (err.code || 'BAD_REQUEST'), message: status >= 500 ? 'Qualcosa non ha funzionato. Riprova.' : err.message });
  }
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

function uploader(maxMb, okMime) {
  const up = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 20 },
    fileFilter(_req, file, cb) {
      if (okMime(file)) return cb(null, true);
      cb(fail(400, 'Formato del file non supportato'));
    },
  });
  return (field, many = false) => (req, res, next) => (many ? up.array(field, 20) : up.single(field))(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code, message: err.code === 'LIMIT_FILE_SIZE' ? `File troppo grande (massimo ${maxMb} MB)` : err.message });
    return res.status(err.status || 400).json({ error: 'UPLOAD_ERROR', message: err.message });
  });
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isPdf = (f) => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname);
const isImage = (f) => /^image\/(jpeg|png|webp|heic|heif)$/.test(f.mimetype);

// Pulizia dei campi di testo in arrivo dal client
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : v === null ? null : undefined);
const dateOrNull = (v) => (v === null || v === '' ? null : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : undefined);
const numOrNull = (v, min = 0, max = 1e9) => (v === null || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);
const jsonOf = (v, max = 200_000) => (v && typeof v === 'object' && JSON.stringify(v).length <= max ? v : undefined);

function pick(body, spec) {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (!(k in (body || {}))) continue;
    const v = fn(body[k]);
    if (v === undefined) throw fail(400, `Valore non valido: ${k}`, 'INVALID_FIELD');
    out[k] = v;
  }
  return out;
}

const safeName = (s) => String(s || 'file').normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(0, 80);

module.exports = { auth, requirePsc, h, fail, uploader, isUuid, DOCX, isPdf, isImage, str, dateOrNull, numOrNull, jsonOf, pick, safeName };
