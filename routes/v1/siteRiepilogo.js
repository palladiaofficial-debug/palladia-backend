'use strict';
// ── Scheda cantiere senza cartelle (F-321, AUDIT.md del frontend) ─────────────
// GET /api/v1/sites/:siteId/riepilogo            → { alLavoro, ultimoGiorno, daSistemare, urgenti, documenti, maltempoGiorni, oreMese }
// PUT /api/v1/sites/:siteId/documenti-non-servono  { tipo: 'pos'|'psc'|'notifica_asl', nonServe: boolean }
// La logica è in lib/cantiereRiepilogo.js. Le azioni del Riepilogo usano le
// rotte che esistono già (pioggia: /ore/pioggia/*, togliere un operaio:
// DELETE /sites/:id/workers/:workerId, data di fine: PATCH /sites/:id).
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { riepiloghi, oreDelMese, DOC_NON_SERVE } = require('../../lib/cantiereRiepilogo');
const logger = require('../../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/sites/:siteId/riepilogo', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  if (!UUID.test(siteId)) return res.status(400).json({ error: 'INVALID_SITE' });
  try {
    const r = (await riepiloghi(req.companyId, { siteIds: [siteId], fresh: req.query.fresh === '1' })).get(siteId);
    if (!r) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    const [{ count }, oreMese] = await Promise.all([
      supabase.from('site_suspension_days').select('id', { count: 'exact', head: true }).eq('company_id', req.companyId).eq('site_id', siteId),
      oreDelMese(req.companyId, siteId).catch((err) => { logger.warn({ err }, 'sites/riepilogo oreDelMese'); return null; }),
    ]);
    res.json({ ...r, maltempoGiorni: count || 0, oreMese });
  } catch (err) {
    logger.error({ err }, 'sites/riepilogo');
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.put('/sites/:siteId/documenti-non-servono', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin', 'tech'].includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
  const { siteId } = req.params;
  const { tipo, nonServe } = req.body || {};
  if (!UUID.test(siteId)) return res.status(400).json({ error: 'INVALID_SITE' });
  if (!DOC_NON_SERVE.includes(tipo) || typeof nonServe !== 'boolean') return res.status(400).json({ error: 'INVALID_INPUT' });
  const { data: site } = await supabase.from('sites').select('id, documenti_non_servono')
    .eq('id', siteId).eq('company_id', req.companyId).neq('status', 'eliminato').maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const set = new Set(site.documenti_non_servono || []);
  if (nonServe) set.add(tipo); else set.delete(tipo);
  const { data, error } = await supabase.from('sites').update({ documenti_non_servono: [...set] })
    .eq('id', siteId).eq('company_id', req.companyId).select('documenti_non_servono').single();
  if (error) { logger.error({ err: error }, 'sites/documenti-non-servono'); return res.status(500).json({ error: 'DB_ERROR' }); }
  res.json({ documenti_non_servono: data.documenti_non_servono });
});

module.exports = router;
