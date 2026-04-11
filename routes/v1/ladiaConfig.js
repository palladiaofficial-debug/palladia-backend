'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// Piani con accesso a Ladia In Cantiere
const LADIA_PLANS = new Set(['grow', 'pro', 'business', 'enterprise']);

async function requireLadiaPlan(req, res) {
  const { data, error } = await supabase
    .from('companies')
    .select('subscription_plan, subscription_status, trial_ends_at')
    .eq('id', req.companyId)
    .single();
  if (error || !data) { res.status(500).json({ error: 'DB_ERROR' }); return false; }

  const isTrialExpired = data.subscription_status === 'trial' &&
    data.trial_ends_at && new Date(data.trial_ends_at) < new Date();
  if (isTrialExpired) { res.status(402).json({ error: 'TRIAL_EXPIRED' }); return false; }

  if (!LADIA_PLANS.has(data.subscription_plan)) {
    res.status(403).json({ error: 'PLAN_REQUIRED', required: 'grow', current: data.subscription_plan });
    return false;
  }
  return true;
}

async function requireSiteOwnership(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return false; }
  return true;
}

// ── GET /api/v1/sites/:siteId/ladia ──────────────────────────────────────────
// Stato attivazione Ladia + statistiche del cantiere.
router.get('/sites/:siteId/ladia', verifySupabaseJwt, async (req, res) => {
  const { siteId }    = req.params;
  const { companyId } = req;

  if (!await requireSiteOwnership(siteId, companyId, res)) return;

  const [cfgRes, phasesRes, costsRes, briefRes] = await Promise.all([
    supabase.from('ladia_site_config')
      .select('*').eq('site_id', siteId).maybeSingle(),
    supabase.from('site_phases')
      .select('id, stato')
      .eq('site_id', siteId),
    supabase.from('site_costs')
      .select('importo')
      .eq('site_id', siteId),
    supabase.from('ladia_action_log')
      .select('executed_at')
      .eq('site_id', siteId)
      .eq('action_type', 'morning_briefing')
      .order('executed_at', { ascending: false })
      .limit(1),
  ]);

  const cfg     = cfgRes.data;
  const phases  = phasesRes.data  || [];
  const costs   = costsRes.data   || [];
  const lastBrf = briefRes.data?.[0];

  // Controlla piano (ritorna info ma non blocca GET — il frontend mostra CTA upgrade)
  const { data: company } = await supabase
    .from('companies')
    .select('subscription_plan')
    .eq('id', companyId)
    .single();

  res.json({
    is_active:           cfg?.is_active ?? false,
    activated_at:        cfg?.activated_at ?? null,
    briefing_time:       cfg?.briefing_time ?? '07:30',
    capitolato_summary:  cfg?.capitolato_summary ?? null,
    plan_has_ladia:      LADIA_PLANS.has(company?.subscription_plan),
    stats: {
      total_phases:     phases.length,
      active_phases:    phases.filter(p => p.stato === 'in_corso').length,
      completed_phases: phases.filter(p => p.stato === 'completata').length,
      total_costs:      costs.reduce((s, c) => s + (parseFloat(c.importo) || 0), 0),
      last_briefing_at: lastBrf?.executed_at ?? null,
    },
  });
});

// ── POST /api/v1/sites/:siteId/ladia/activate ─────────────────────────────────
// Attiva Ladia sul cantiere. Piano gate: Grow+.
router.post('/sites/:siteId/ladia/activate', verifySupabaseJwt, async (req, res) => {
  const { siteId }    = req.params;
  const { companyId } = req;

  if (!await requireLadiaPlan(req, res)) return;
  if (!await requireSiteOwnership(siteId, companyId, res)) return;

  const { briefing_time = '07:30' } = req.body;

  const { data, error } = await supabase
    .from('ladia_site_config')
    .upsert({
      company_id:   companyId,
      site_id:      siteId,
      is_active:    true,
      briefing_time,
      activated_at: new Date().toISOString(),
      activated_by: req.user.id,
    }, { onConflict: 'site_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, config: data });
});

// ── DELETE /api/v1/sites/:siteId/ladia ───────────────────────────────────────
// Disattiva Ladia sul cantiere (dati conservati).
router.delete('/sites/:siteId/ladia', verifySupabaseJwt, async (req, res) => {
  const { siteId }    = req.params;
  const { companyId } = req;

  if (!await requireSiteOwnership(siteId, companyId, res)) return;

  const { error } = await supabase
    .from('ladia_site_config')
    .update({ is_active: false })
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /api/v1/sites/:siteId/ladia/briefings ────────────────────────────────
// Storico briefing mattutini (ultimi 30).
router.get('/sites/:siteId/ladia/briefings', verifySupabaseJwt, async (req, res) => {
  const { siteId }    = req.params;
  const { companyId } = req;

  if (!await requireSiteOwnership(siteId, companyId, res)) return;

  const { data, error } = await supabase
    .from('ladia_action_log')
    .select('id, executed_at, action_params, result')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('action_type', 'morning_briefing')
    .order('executed_at', { ascending: false })
    .limit(30);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

module.exports = router;
