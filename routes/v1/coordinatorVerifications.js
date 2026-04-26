'use strict';
/**
 * routes/v1/coordinatorVerifications.js
 *
 * Verifiche formali del coordinatore — registro immutabile + timeline unificata.
 *
 * Endpoint pubblici (token nel path — no JWT):
 *   POST  /api/v1/coordinator/:token/verifications                          — CSE registra verifica
 *   GET   /api/v1/coordinator/:token/verifications                          — CSE storico verifiche
 *   GET   /api/v1/coordinator/:token/timeline                               — CSE timeline unificata
 *   POST  /api/v1/coordinator/pro/:token/site/:siteId/verifications         — Pro registra verifica
 *   GET   /api/v1/coordinator/pro/:token/site/:siteId/verifications         — Pro storico verifiche
 *   GET   /api/v1/coordinator/pro/:token/site/:siteId/timeline              — Pro timeline unificata
 *
 * Endpoint privati (JWT + X-Company-Id):
 *   GET   /api/v1/sites/:siteId/coordinator-verifications                   — impresa vede tutto
 */

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');
const { coordinatorLimiter } = require('../../middleware/rateLimit');
const {
  computeSafetyStatus,
  buildActiveIssues,
  getTodayPresences,
  getDocumentStatus,
  buildTimeline,
} = require('../../lib/coordinatorUtils');

// ── Helpers token ─────────────────────────────────────────────────────────────

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}
function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}

async function resolveInvite(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, expires_at, is_active')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (!data || !data.is_active || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function resolveProSession(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('coordinator_pro_sessions')
    .select('id, email')
    .eq('token_hash', hashToken(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

async function resolveProInviteForSite(email, siteId) {
  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, expires_at, is_active')
    .eq('site_id', siteId)
    .eq('coordinator_email', email)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

// ── Snapshot helper ───────────────────────────────────────────────────────────
// Carica workers + NC per il cantiere e calcola safety_status snapshot.
async function buildVerificationSnapshot(invite) {
  const [wwRes, ncRes] = await Promise.all([
    supabase
      .from('worksite_workers')
      .select('worker:workers(id, full_name, safety_training_expiry, health_fitness_expiry, is_active)')
      .eq('site_id', invite.site_id)
      .eq('company_id', invite.company_id)
      .eq('status', 'active'),
    supabase
      .from('site_nonconformities')
      .select('id, title, category, severity, status, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  function complianceStatus(expiry) {
    if (!expiry) return 'not_set';
    const days = (new Date(expiry) - Date.now()) / 86_400_000;
    if (days < 0) return 'expired';
    if (days <= 30) return 'expiring';
    return 'ok';
  }
  function overallCompliance(s, h) {
    const sts = [s, h];
    if (sts.includes('expired'))  return 'non_compliant';
    if (sts.includes('expiring')) return 'expiring';
    if (sts.includes('not_set'))  return 'incomplete';
    return 'compliant';
  }

  const workers = (wwRes.data || [])
    .filter(r => r.worker && r.worker.is_active)
    .map(r => ({
      id:        r.worker.id,
      full_name: r.worker.full_name,
      compliance: {
        overall: overallCompliance(
          complianceStatus(r.worker.safety_training_expiry),
          complianceStatus(r.worker.health_fitness_expiry)
        ),
      },
    }));

  const ncList = ncRes.data || [];

  const safetyStatus = computeSafetyStatus(workers, ncList);
  const activeIssues = buildActiveIssues(workers, ncList);
  const todayPresences = await getTodayPresences(invite.site_id, invite.company_id, workers);
  const docStatus    = await getDocumentStatus(invite.site_id, invite.company_id);

  return {
    safetyStatus,
    activeIssues,
    todayPresences,
    docStatus,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSE TOKEN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/v1/coordinator/:token/verifications
router.post('/coordinator/:token/verifications', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const rawNote = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;

  const { safetyStatus, activeIssues, todayPresences, docStatus } =
    await buildVerificationSnapshot(invite);

  const { data: verif, error } = await supabase
    .from('coordinator_verifications')
    .insert({
      invite_id:             invite.id,
      company_id:            invite.company_id,
      site_id:               invite.site_id,
      coordinator_name:      invite.coordinator_name,
      coordinator_email:     invite.coordinator_email || null,
      accessed_via:          'cse',
      safety_status:         safetyStatus.level,
      open_nc_count:         safetyStatus.open_nc_count,
      critical_nc_count:     safetyStatus.critical_nc_count,
      non_compliant_workers: safetyStatus.non_compliant_workers,
      expiring_workers:      safetyStatus.expiring_workers,
      workers_present_today: todayPresences.present_count,
      active_issues_snapshot: JSON.stringify(activeIssues),
      document_snapshot:     JSON.stringify(docStatus),
      note:                  rawNote,
      ip_address:            req.ip || null,
      user_agent:            req.headers['user-agent']?.slice(0, 300) || null,
    })
    .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, created_at')
    .single();

  if (error) {
    console.error('[coord-verif] insert error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  res.status(201).json({
    ok:           true,
    verification: verif,
    safety_status: {
      level:   safetyStatus.level,
      label:   safetyStatus.label,
      reasons: safetyStatus.reasons,
    },
  });
});

// GET /api/v1/coordinator/:token/verifications
router.get('/coordinator/:token/verifications', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('coordinator_verifications')
    .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, expiring_workers, workers_present_today, note, created_at')
    .eq('invite_id', invite.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// GET /api/v1/coordinator/:token/timeline
router.get('/coordinator/:token/timeline', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const [verifRes, ncRes, notesRes] = await Promise.all([
    supabase.from('coordinator_verifications')
      .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('site_nonconformities')
      .select('id, title, severity, category, status, coordinator_name, created_at, resolved_at, closed_by_coordinator_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const timeline = buildTimeline(
    verifRes.data  || [],
    ncRes.data     || [],
    notesRes.data  || []
  );

  res.json({ timeline, coordinator_name: invite.coordinator_name });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRO TOKEN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/v1/coordinator/pro/:token/site/:siteId/verifications
router.post('/coordinator/pro/:token/site/:siteId/verifications', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const rawNote = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;

  const { safetyStatus, activeIssues, todayPresences, docStatus } =
    await buildVerificationSnapshot(invite);

  const { data: verif, error } = await supabase
    .from('coordinator_verifications')
    .insert({
      invite_id:             invite.id,
      company_id:            invite.company_id,
      site_id:               invite.site_id,
      coordinator_name:      invite.coordinator_name,
      coordinator_email:     session.email,
      accessed_via:          'pro',
      safety_status:         safetyStatus.level,
      open_nc_count:         safetyStatus.open_nc_count,
      critical_nc_count:     safetyStatus.critical_nc_count,
      non_compliant_workers: safetyStatus.non_compliant_workers,
      expiring_workers:      safetyStatus.expiring_workers,
      workers_present_today: todayPresences.present_count,
      active_issues_snapshot: JSON.stringify(activeIssues),
      document_snapshot:     JSON.stringify(docStatus),
      note:                  rawNote,
      ip_address:            req.ip || null,
      user_agent:            req.headers['user-agent']?.slice(0, 300) || null,
    })
    .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, created_at')
    .single();

  if (error) {
    console.error('[coord-verif-pro] insert error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  res.status(201).json({
    ok:           true,
    verification: verif,
    safety_status: {
      level:   safetyStatus.level,
      label:   safetyStatus.label,
      reasons: safetyStatus.reasons,
    },
  });
});

// GET /api/v1/coordinator/pro/:token/site/:siteId/verifications
router.get('/coordinator/pro/:token/site/:siteId/verifications', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data, error } = await supabase
    .from('coordinator_verifications')
    .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, expiring_workers, workers_present_today, note, created_at')
    .eq('invite_id', invite.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// GET /api/v1/coordinator/pro/:token/site/:siteId/timeline
router.get('/coordinator/pro/:token/site/:siteId/timeline', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const [verifRes, ncRes, notesRes] = await Promise.all([
    supabase.from('coordinator_verifications')
      .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('site_nonconformities')
      .select('id, title, severity, category, status, coordinator_name, created_at, resolved_at, closed_by_coordinator_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const timeline = buildTimeline(
    verifRes.data  || [],
    ncRes.data     || [],
    notesRes.data  || []
  );

  res.json({ timeline, coordinator_name: invite.coordinator_name });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY ENDPOINT (JWT)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/sites/:siteId/coordinator-verifications
router.get('/sites/:siteId/coordinator-verifications', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, limit = 100 } = req.query;
  const lim = Math.min(parseInt(limit) || 100, 500);

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  let query = supabase
    .from('coordinator_verifications')
    .select('id, coordinator_name, coordinator_email, accessed_via, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, expiring_workers, workers_present_today, note, created_at')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(lim);

  if (from) query = query.gte('created_at', from);
  if (to)   query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

module.exports = router;
