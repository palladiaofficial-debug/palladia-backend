'use strict';
// ── Lavagna cantieri (F-331, AUDIT.md del frontend) ───────────────────────────
// GET    /api/v1/lavagna                       → { oggi, righe: [...] }
// PATCH  /api/v1/lavagna/righe                 { rigaId | siteId, urgenza?, daFare?, note?, stato? }
// POST   /api/v1/lavagna/righe                 { nome } → riga solo nella lavagna, "Da iniziare"
// DELETE /api/v1/lavagna/righe/:id             → toglie una riga solo nella lavagna
// POST   /api/v1/lavagna/righe/:id/collega     { siteId } → "È il cantiere…"
// La logica è in lib/lavagna.js. Dietro il flag `lavagna`.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { invalidate } = require('../../middleware/cache');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { auditLog } = require('../../lib/audit');
const logger = require('../../lib/logger');
const L = require('../../lib/lavagna');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_ROLES = ['owner', 'admin', 'tech'];

async function guard(req, res, scrive) {
  if (!(await isFeatureEnabled(req.companyId, 'lavagna'))) { res.status(404).json({ error: 'FEATURE_DISABLED' }); return false; }
  if (scrive && req.userRole && !WRITE_ROLES.includes(req.userRole)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Solo il titolare o un amministratore può modificare la lavagna.' }); return false; }
  return true;
}
function fallito(res, err, dove) {
  if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.code && err.code !== err.message) return res.status(400).json({ error: err.code, message: err.message });
  logger.error({ err }, dove);
  return res.status(500).json({ error: 'DB_ERROR' });
}
const audit = (req, action, targetId, payload) => auditLog({
  companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole || null,
  action, targetType: 'lavagna', targetId, payload, req,
});

router.get('/lavagna', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, false))) return;
  try { res.json(await L.lavagna(req.companyId)); }
  catch (err) { fallito(res, err, 'lavagna GET'); }
});

router.patch('/lavagna/righe', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const { rigaId, siteId, urgenza, daFare, note, stato } = req.body || {};
  if (!!rigaId === !!siteId || (rigaId && !UUID.test(rigaId)) || (siteId && !UUID.test(siteId))) return res.status(400).json({ error: 'RIGA_O_CANTIERE' });
  try {
    const r = await L.salva(req.companyId, req.user?.id, { rigaId, siteId, urgenza, daFare, note, stato });
    audit(req, 'lavagna.update', r.riga.id, { siteId: siteId || null, urgenza, daFare, note, stato });
    if (r.statusDopo && r.statusDopo !== r.statusPrima) {
      // Lo stato vero del cantiere: stessa traccia di PATCH /sites/:id
      auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole, action: 'site.update', targetType: 'site', targetId: siteId, payload: { status: r.statusDopo, from: r.statusPrima, via: 'lavagna' }, req });
      invalidate(req.companyId, '/sites');
    }
    res.json({ ok: true });
  } catch (err) { fallito(res, err, 'lavagna PATCH'); }
});

router.post('/lavagna/righe', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  try {
    const riga = await L.crea(req.companyId, req.user?.id, req.body?.nome);
    audit(req, 'lavagna.create', riga.id, { nome: riga.nome });
    res.status(201).json({ id: riga.id });
  } catch (err) { fallito(res, err, 'lavagna POST'); }
});

router.delete('/lavagna/righe/:id', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'INVALID_ID' });
  try {
    await L.togli(req.companyId, req.params.id);
    audit(req, 'lavagna.delete', req.params.id, {});
    res.json({ ok: true });
  } catch (err) { fallito(res, err, 'lavagna DELETE'); }
});

router.post('/lavagna/righe/:id/collega', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const siteId = req.body?.siteId;
  if (!UUID.test(req.params.id) || !UUID.test(siteId || '')) return res.status(400).json({ error: 'INVALID_ID' });
  try {
    await L.collega(req.companyId, req.user?.id, req.params.id, siteId);
    audit(req, 'lavagna.link', req.params.id, { siteId });
    res.json({ ok: true });
  } catch (err) { fallito(res, err, 'lavagna collega'); }
});

// ── "Già in corso" (F-334): gli avvisi della riga si mettono da parte con la
// stessa prenotazione di Da fare; tornano da soli alla data scelta.
router.post('/lavagna/in-corso', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const { siteId, chiavi, giorni } = req.body || {};
  if (!UUID.test(siteId || '')) return res.status(400).json({ error: 'INVALID_ID' });
  try {
    const r = await L.inCorso(req.companyId, req.user?.id, { siteId, chiavi, giorni });
    audit(req, 'lavagna.in_corso', siteId, { chiavi, giorni, tornaIl: r.tornaIl });
    res.json({ ok: true, tornaIl: r.tornaIl });
  } catch (err) { fallito(res, err, 'lavagna in corso'); }
});

router.post('/lavagna/in-corso/annulla', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res, true))) return;
  const { siteId, chiavi } = req.body || {};
  if (!UUID.test(siteId || '')) return res.status(400).json({ error: 'INVALID_ID' });
  try {
    await L.annullaInCorso(req.companyId, { siteId, chiavi });
    audit(req, 'lavagna.in_corso_annulla', siteId, { chiavi });
    res.json({ ok: true });
  } catch (err) { fallito(res, err, 'lavagna annulla in corso'); }
});

module.exports = router;
