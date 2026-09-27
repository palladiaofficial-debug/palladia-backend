'use strict';
// ── GET /api/v1/da-fare — la lista unica della porta "Da fare" (F-236) ────────
// Tutta la logica sta in lib/daFare.js. Risponde:
//   { today, items: [...], counts: { scaduto, settimana, mese, in_corso }, attention }
// `attention` (scaduto + settimana) è il numero sulla campanella.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { buildDaFare } = require('../../lib/daFare');
const logger = require('../../lib/logger');

router.get('/da-fare', verifySupabaseJwt, async (req, res) => {
  try {
    const result = await buildDaFare(req.companyId, req.user?.id || null);
    res.json(result);
  } catch (err) {
    logger.error({ err, companyId: req.companyId }, 'da-fare: errore di costruzione della lista');
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

// ── "Prenotata" (F-243) ─────────────────────────────────────────────────────
// POST   /api/v1/da-fare/prenota  { itemId, giorni }  → la riga va in "In corso"
// DELETE /api/v1/da-fare/prenota?itemId=…             → torna tra le cose da fare
// Solo per le scadenze (id "doc:…", "worker:…", "equipment:…", "company:…",
// "site:…"); stessi ruoli dello snooze delle notifiche. Una scadenza prenotata
// resta scaduta per tutto il resto (timbratura compresa): è un promemoria.
const { romeDate, addDays } = require('../../lib/daFare');
const supabase = require('../../lib/supabase');
const ITEM_RE = /^(doc|worker|equipment|company|site|sub):[\w:-]{1,160}$/;
const ROLES = ['owner', 'admin', 'tech'];

router.post('/da-fare/prenota', verifySupabaseJwt, async (req, res) => {
  if (req.userRole && !ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
  const { itemId, giorni } = req.body || {};
  const days = Number(giorni);
  if (typeof itemId !== 'string' || !ITEM_RE.test(itemId) || !Number.isInteger(days) || days < 1 || days > 60) {
    return res.status(400).json({ error: 'INVALID_PARAMS', message: 'itemId di una scadenza e giorni (1-60) obbligatori' });
  }
  const tornaIl = addDays(romeDate(), days);
  const { error } = await supabase.from('da_fare_prenotazioni').upsert(
    { company_id: req.companyId, item_id: itemId, torna_il: tornaIl, created_by: req.user?.id || null },
    { onConflict: 'company_id,item_id' },
  );
  if (error) {
    logger.error({ err: error, companyId: req.companyId }, 'da-fare: prenotazione non salvata');
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  res.json({ ok: true, itemId, tornaIl });
});

router.delete('/da-fare/prenota', verifySupabaseJwt, async (req, res) => {
  if (req.userRole && !ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
  const itemId = String(req.query.itemId || '');
  if (!ITEM_RE.test(itemId)) return res.status(400).json({ error: 'INVALID_PARAMS' });
  const { error } = await supabase.from('da_fare_prenotazioni').delete()
    .eq('company_id', req.companyId).eq('item_id', itemId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── "Fatto" (F-246) ─────────────────────────────────────────────────────────
// POST /api/v1/da-fare/fatto { itemId, nuovaScadenza: 'YYYY-MM-DD' }
// Scrive la nuova scadenza dove il sistema la legge (lib/daFareFatto.js):
// la riga esce da Da fare, campanella e card di Ladia, e lo stato del
// lavoratore/mezzo/subappaltatore torna in regola.
const { segnaFatto, FattoError } = require('../../lib/daFareFatto');

router.post('/da-fare/fatto', verifySupabaseJwt, async (req, res) => {
  if (req.userRole && !ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
  const { itemId, nuovaScadenza } = req.body || {};
  try {
    const out = await segnaFatto({
      companyId: req.companyId, itemId, nuovaScadenza,
      userId: req.user?.id || null, userRole: req.userRole || null, req,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof FattoError) return res.status(err.status).json({ error: err.code, message: err.message });
    logger.error({ err, companyId: req.companyId }, 'da-fare: "fatto" non salvato');
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
