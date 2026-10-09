'use strict';
// ── Ore e assenze: quello che arriva dagli operai (F-318, AUDIT.md del frontend)
// GET  /api/v1/ore/da-vedere                 → { pioggia, malattie, infortuni }
// POST /api/v1/ore/pioggia/conferma          { siteId, day }
// POST /api/v1/ore/pioggia/scarta            { siteId, day }
// POST /api/v1/ore/pioggia/scarta-senza-ore  → "Nessuna ora di pioggia" per le giornate dove si è lavorato
// POST /api/v1/ore/pioggia/annulla           { fatti: [...] } (quello che hanno restituito conferma/scarta)
// POST /api/v1/ore/malattie/:id/visto
// POST /api/v1/ore/infortuni/:id/visto
// Solo titolare e amministratori, come il resto di Ore e assenze.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { proposte, conferma, scarta, scartaSenzaOre, annulla, PioggiaError } = require('../../lib/pioggiaDaConfermare');
const logger = require('../../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}
function fail(res, err, what) {
  if (err instanceof PioggiaError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `ore/da-vedere: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
}

router.get('/ore/da-vedere', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  try {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const [pioggia, malRes, infRes] = await Promise.all([
      proposte(req.companyId),
      supabase.from('worker_absences').select('id, worker_id, date_from, date_to, protocollo, note, created_at, workers(full_name)')
        .eq('company_id', req.companyId).eq('tipo', 'malattia').eq('da_lavoratore', true).is('decided_at', null)
        .gte('created_at', since).order('created_at', { ascending: false }),
      supabase.from('notifications').select('id, title, body, read_by, created_at')
        .eq('company_id', req.companyId).eq('type', 'worker_injury').gte('created_at', since).order('created_at', { ascending: false }),
    ]);
    if (malRes.error || infRes.error) throw new Error((malRes.error || infRes.error).message);
    const uid = req.user?.id;
    res.json({
      pioggia,
      malattie: (malRes.data || []).map(({ workers, ...m }) => ({ ...m, nome: workers?.full_name || '' })),
      infortuni: (infRes.data || []).filter(n => !uid || !(n.read_by || []).includes(uid)).map(({ read_by, ...n }) => n),
    });
  } catch (err) { fail(res, err, 'elenco'); }
});

router.post('/ore/pioggia/conferma', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const { siteId, day } = req.body || {};
  if (!UUID.test(String(siteId))) return res.status(400).json({ error: 'INVALID_SITE' });
  try { res.json(await conferma({ companyId: req.companyId, siteId, day, userId: req.user?.id || null })); } catch (err) { fail(res, err, 'conferma'); }
});

router.post('/ore/pioggia/scarta', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const { siteId, day } = req.body || {};
  if (!UUID.test(String(siteId))) return res.status(400).json({ error: 'INVALID_SITE' });
  try { res.json(await scarta({ companyId: req.companyId, siteId, day, userId: req.user?.id || null })); } catch (err) { fail(res, err, 'scarta'); }
});

router.post('/ore/pioggia/scarta-senza-ore', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  try { res.json(await scartaSenzaOre({ companyId: req.companyId, userId: req.user?.id || null })); } catch (err) { fail(res, err, 'scarta senza ore'); }
});

router.post('/ore/pioggia/annulla', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const fatti = Array.isArray(req.body?.fatti) ? req.body.fatti.slice(0, 200) : [];
  const ids = (a) => (Array.isArray(a) ? a.filter(x => UUID.test(String(x))) : []);
  try {
    for (const f of fatti) {
      if (!UUID.test(String(f?.siteId))) continue;
      await annulla({ companyId: req.companyId, siteId: f.siteId, day: f.day, reasonIds: ids(f.reasonIds), absenceIds: ids(f.absenceIds), sospensione: !!f.sospensione, scartata: !!f.scartata });
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'annulla'); }
});

router.post('/ore/malattie/:id/visto', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await supabase.from('worker_absences').update({ decided_by: req.user?.id || null, decided_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('company_id', req.companyId).eq('tipo', 'malattia').select('id');
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

router.post('/ore/infortuni/:id/visto', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const uid = req.user?.id;
  const { data: n } = await supabase.from('notifications').select('id, read_by')
    .eq('id', req.params.id).eq('company_id', req.companyId).eq('type', 'worker_injury').maybeSingle();
  if (!n) return res.status(404).json({ error: 'NOT_FOUND' });
  if (uid && !(n.read_by || []).includes(uid)) {
    const { error } = await supabase.from('notifications').update({ read_by: [...(n.read_by || []), uid] }).eq('id', n.id);
    if (error) return res.status(500).json({ error: 'DB_ERROR' });
  }
  res.json({ ok: true });
});

module.exports = router;
