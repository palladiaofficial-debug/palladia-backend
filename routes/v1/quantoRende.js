'use strict';
/**
 * routes/v1/quantoRende.js — F-509 (AUDIT.md del frontend).
 * Quanto rende ogni cantiere: costo della manodopera da prospetto contabile,
 * buste paga e timbrature (lib/quantoRende.js), più fatture e subappaltatori,
 * e la congruità della manodopera (DM 143/2021). Sono paghe: solo titolare e
 * amministratori.
 *
 *   GET   /quanto-rende?mese=YYYY-MM        il mese (senza mese: l'ultimo pronto) + i mesi pronti
 *   GET   /quanto-rende/cantiere/:siteId    i soldi di un cantiere
 *   PATCH /quanto-rende/cantiere/:siteId    { valore, categoria }: l'unica domanda al titolare
 */
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog } = require('../../lib/audit');
const logger = require('../../lib/logger');
const supabase = require('../../lib/supabase');
const Q = require('../../lib/quantoRende');

function soloUfficio(req, res, next) {
  if (['owner', 'admin'].includes(req.userRole)) return next();
  return res.status(403).json({ error: 'SOLO_UFFICIO', message: 'Lo vedono solo il titolare e gli amministratori.' });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sbaglio = (res, err, cosa) => {
  logger.error({ err }, `[quanto-rende] ${cosa}`);
  res.status(500).json({ error: 'ERRORE', message: 'Non riesco a fare il conto. Riprova.' });
};

router.get('/quanto-rende', verifySupabaseJwt, soloUfficio, async (req, res) => {
  try {
    const mesi = await Q.mesiConProspetto(req.companyId);
    const mese = String(req.query.mese || mesi[0] || '');
    if (!mese) return res.json({ mese: null, pronto: false, manca: 'prospetto', mesi });
    if (!/^\d{4}-\d{2}$/.test(mese)) return res.status(400).json({ error: 'MESE_NON_VALIDO', message: 'mese deve essere YYYY-MM' });
    const [conto, { data: siti }] = await Promise.all([
      Q.quantoRendeMeseRicordato(req.companyId, mese),
      supabase.from('sites').select('id, budget_totale').eq('company_id', req.companyId).not('budget_totale', 'is', null),
    ]);
    // il valore del lavoro dei cantieri che ce l'hanno: la riga mostra «Quanto vale il lavoro?» solo dove manca
    const valori = Object.fromEntries((siti || []).map(s => [s.id, Number(s.budget_totale)]));
    res.json({ ...conto, mesi, valori });
  } catch (err) { sbaglio(res, err, 'mese'); }
});

router.get('/quanto-rende/cantiere/:siteId', verifySupabaseJwt, soloUfficio, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const r = await Q.soldiCantiere(req.companyId, req.params.siteId);
    if (!r) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cantiere non trovato.' });
    res.json({ ...r, categorie: Object.entries(Q.CATEGORIE).map(([key, c]) => ({ key, ...c })), soglia: Q.SOGLIA_PRIVATI });
  } catch (err) { sbaglio(res, err, 'cantiere'); }
});

router.patch('/quanto-rende/cantiere/:siteId', verifySupabaseJwt, soloUfficio, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { valore, categoria } = req.body || {};
  const patch = {};
  if (valore !== undefined) {
    const v = valore === null || valore === '' ? null : Number(valore);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1e9)) {
      return res.status(400).json({ error: 'VALORE_NON_VALIDO', message: 'Scrivi un importo in euro, senza IVA.' });
    }
    patch.budget_totale = v === null ? null : Math.round(v * 100) / 100;
  }
  if (categoria !== undefined) {
    if (categoria !== null && !Q.CATEGORIE[categoria]) return res.status(400).json({ error: 'CATEGORIA_NON_VALIDA', message: 'Scegli che lavoro è.' });
    patch.congruita_categoria = categoria;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'NIENTE_DA_SALVARE' });
  try {
    const { data, error } = await supabase.from('sites').update(patch)
      .eq('id', req.params.siteId).eq('company_id', req.companyId).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cantiere non trovato.' });
    auditLog({ companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole, action: 'quanto_rende.valore', targetType: 'site', targetId: req.params.siteId, payload: patch, req }).catch(() => {});
    res.json(await Q.soldiCantiere(req.companyId, req.params.siteId));
  } catch (err) { sbaglio(res, err, 'salva'); }
});

module.exports = router;
