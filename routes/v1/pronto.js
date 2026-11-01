'use strict';
// ── Pronto a fare da subappalto (F-421, AUDIT.md del frontend) ───────────────
// Titolare (JWT):
//   GET  /api/v1/pronto                          → sei pronto? cosa manca, i tuoi operai, i link già fatti
//   POST /api/v1/pronto/pacchetti                → { destinatario, cantiere, operai[] } + pos (file, facoltativo) → link + messaggio
//   POST /api/v1/pronto/pacchetti/:id/spegni     → il link non si apre più
//   GET  /api/v1/pronto/dichiarazione.pdf        → la dichiarazione art. 14 della tua impresa, già compilata
// Chi riceve il link (senza registrazione):
//   GET  /api/v1/documenti-per/:token            → i documenti scelti, sempre aggiornati
//   GET  /api/v1/documenti-per/:token/file/:chiave → { url } firmato per 5 minuti
//   GET  /api/v1/documenti-per/:token/tutto.pdf  → tutti i documenti in un PDF solo
// La logica sta in lib/prontoSubappalto.js.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { impresaLinkLimiter } = require('../../middleware/rateLimit');
const P = require('../../lib/prontoSubappalto');
const { dichiarazionePdf } = require('../../lib/impreseDichiarazione');
const supabase = require('../../lib/supabase');
const logger = require('../../lib/logger');

const WRITE_ROLES = ['owner', 'admin', 'tech'];
const scrive = (req, res, next) => (req.userRole && !WRITE_ROLES.includes(req.userRole) ? res.status(403).json({ error: 'FORBIDDEN' }) : next());
const fallito = (res, err, what) => {
  if (err instanceof P.ProntoError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `pronto: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const posFacoltativo = (req, res, next) => upload.single('pos')(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  next();
});

router.get('/pronto', verifySupabaseJwt, async (req, res) => {
  try {
    const [st, link] = await Promise.all([P.statoTuo(req.companyId), P.elenco(req.companyId)]);
    res.json({ ...st, link });
  } catch (err) { fallito(res, err, 'stato'); }
});

router.post('/pronto/pacchetti', verifySupabaseJwt, scrive, posFacoltativo, async (req, res) => {
  try {
    const b = req.body || {};
    const operai = Array.isArray(b.operai) ? b.operai : typeof b.operai === 'string' && b.operai ? b.operai.split(',') : [];
    res.status(201).json(await P.crea(req.companyId, req.user?.id, { destinatario: b.destinatario, cantiere: b.cantiere, operai, pos: req.file || null }));
  } catch (err) { fallito(res, err, 'crea'); }
});

router.post('/pronto/pacchetti/:id/spegni', verifySupabaseJwt, scrive, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await P.spegni(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'spegni'); }
});

router.get('/pronto/dichiarazione.pdf', verifySupabaseJwt, async (req, res) => {
  try {
    const { data: co } = await supabase.from('companies').select('name, piva, vat_number, address, city, legale_rappresentante').eq('id', req.companyId).maybeSingle();
    const pdf = await dichiarazionePdf({
      impresa: { nome: co?.name || '', piva: co?.piva || co?.vat_number || '', indirizzo: [co?.address, co?.city].filter(Boolean).join(', '), referente: co?.legale_rappresentante || '' },
      azienda: String(req.query.per || '').slice(0, 160), cantieri: [],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="dichiarazione-art14.pdf"');
    res.send(Buffer.from(pdf));
  } catch (err) { fallito(res, err, 'dichiarazione'); }
});

// ── Chi riceve il link ──
router.get('/documenti-per/:token', impresaLinkLimiter, async (req, res) => {
  try { res.json(await P.pubblico(req.params.token)); } catch (err) { fallito(res, err, 'pubblico'); }
});
router.get('/documenti-per/:token/file/:chiave', impresaLinkLimiter, async (req, res) => {
  try { res.json(await P.file(req.params.token, String(req.params.chiave).slice(0, 120))); } catch (err) { fallito(res, err, 'file'); }
});
router.get('/documenti-per/:token/tutto.pdf', impresaLinkLimiter, async (req, res) => {
  try {
    const r = await P.pdf(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nome}"`);
    res.send(r.buffer);
  } catch (err) { fallito(res, err, 'pdf'); }
});

module.exports = router;
