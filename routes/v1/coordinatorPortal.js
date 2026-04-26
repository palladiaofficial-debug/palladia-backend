'use strict';
// ── Portale Coordinatore Unificato ────────────────────────────────────────────
// Risolve sia token Pro (coordinator_pro_sessions) che CSE (site_coordinator_invites).
// Il frontend usa sempre /api/v1/coordinator/portal/:token indipendentemente dal tipo.
//
// GET   /api/v1/coordinator/portal/:token
// GET   /api/v1/coordinator/portal/:token/site/:siteId
// POST  /api/v1/coordinator/portal/:token/site/:siteId/notes
// POST  /api/v1/coordinator/portal/:token/site/:siteId/nonconformities
// PATCH /api/v1/coordinator/portal/:token/site/:siteId/nonconformities/:ncId/close
// POST  /api/v1/coordinator/portal/:token/site/:siteId/verifications
// GET   /api/v1/coordinator/portal/:token/site/:siteId/timeline
// ─────────────────────────────────────────────────────────────────────────────

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { coordinatorLimiter } = require('../../middleware/rateLimit');
const {
  computeSafetyStatus,
  buildActiveIssues,
  getTodayPresences,
  getDocumentStatus,
  buildTimeline,
} = require('../../lib/coordinatorUtils');
const {
  sendCoordinatorNoteAlert,
  sendNonconformityAlert,
} = require('../../services/email');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}
function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}
function complianceStatus(expiry) {
  if (!expiry) return 'not_set';
  const days = (new Date(expiry) - Date.now()) / 86400000;
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'ok';
}

// Risolve token → { type:'pro', session } oppure { type:'cse', invite } oppure null
async function resolvePortalToken(rawToken) {
  if (!isValidToken(rawToken)) return null;
  const hash = hashToken(rawToken);

  // Pro session (priorità — inviti recenti usano Pro)
  const { data: session } = await supabase
    .from('coordinator_pro_sessions')
    .select('id, email')
    .eq('token_hash', hash)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (session) return { type: 'pro', session };

  // Fallback: vecchio token CSE
  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, coordinator_company, expires_at, is_active')
    .eq('token_hash', hash)
    .maybeSingle();
  if (!invite || !invite.is_active || new Date(invite.expires_at) < new Date()) return null;
  return { type: 'cse', invite };
}

// Risolve invite per siteId + token (usato da tutti gli endpoint azione)
async function getInviteForSite(rawToken, siteId) {
  const resolved = await resolvePortalToken(rawToken);
  if (!resolved) return null;

  if (resolved.type === 'cse') {
    if (resolved.invite.site_id !== siteId) return null;
    return { invite: resolved.invite, auth_type: 'cse' };
  }

  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, coordinator_company, expires_at, is_active')
    .eq('coordinator_email', resolved.session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!data) return null;
  return { invite: data, auth_type: 'pro' };
}

// Carica tutti i dati completi di un cantiere per un invite
async function getFullSiteData(invite) {
  const { site_id: siteId, company_id: companyId } = invite;
  const today = new Date().toISOString().slice(0, 10);
  const in30  = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [siteR, workersR, presR, notesR, ncR, visitsR, verifR, subsR, equipR] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address, status, client, start_date, companies(name)')
      .eq('id', siteId).maybeSingle(),

    supabase.from('worksite_workers')
      .select(`worker:workers(
        id, full_name, fiscal_code, role, qualification,
        employer_name, subcontracting_auth,
        safety_training_expiry, health_fitness_expiry, is_active
      )`)
      .eq('site_id', siteId).eq('company_id', companyId).eq('status', 'active'),

    supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId).eq('company_id', companyId)
      .gte('timestamp_server', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('timestamp_server', { ascending: false }).limit(1000),

    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, is_read, created_at')
      .eq('site_id', siteId).eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(50),

    supabase.from('site_nonconformities')
      .select('id, title, description, category, severity, status, due_date, resolution_notes, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(50),

    supabase.from('coordinator_visits')
      .select('id, accessed_via, visited_at')
      .eq('invite_id', invite.id)
      .order('visited_at', { ascending: false }).limit(20),

    supabase.from('coordinator_verifications')
      .select('id, safety_status, open_nc_count, critical_nc_count, note, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(10),

    supabase.from('subcontractors')
      .select('id, company_name, piva, contact_person, phone, status, durc_expiry, insurance_expiry, soa_expiry')
      .eq('company_id', companyId).eq('is_archived', false).order('company_name'),

    supabase.from('equipment')
      .select('id, type, model, plate_or_serial, ownership, inspection_date, insurance_expiry, maintenance_date')
      .eq('company_id', companyId).eq('is_active', true).order('type'),
  ]);

  if (!siteR.data) return null;

  // Chi è in cantiere (ultimo evento ENTRY nelle ultime 7gg)
  const allLogs = presR.data || [];
  const lastEvt = {};
  for (const log of allLogs) {
    if (!lastEvt[log.worker_id]) lastEvt[log.worker_id] = log.event_type;
  }
  const onSiteIds = new Set(
    Object.entries(lastEvt).filter(([, t]) => t === 'ENTRY').map(([id]) => id)
  );

  // Workers con compliance
  const workers = (workersR.data || [])
    .filter(r => r.worker?.is_active)
    .map(r => {
      const w = r.worker;
      const safety = complianceStatus(w.safety_training_expiry);
      const health = complianceStatus(w.health_fitness_expiry);
      const sts = [safety, health];
      const overall = sts.includes('expired')  ? 'non_compliant'
        : sts.includes('expiring') ? 'expiring'
        : sts.includes('not_set')  ? 'incomplete' : 'compliant';
      return { ...w, on_site: onSiteIds.has(w.id), compliance: { safety, health, overall } };
    })
    .sort((a, b) => {
      const ord = { non_compliant: 0, expiring: 1, incomplete: 2, compliant: 3 };
      return (ord[a.compliance.overall] ?? 9) - (ord[b.compliance.overall] ?? 9);
    });

  // Presenza summary 7 giorni
  const dayMap = new Map();
  for (const log of allLogs) {
    const day = log.timestamp_server.split('T')[0];
    if (!dayMap.has(day)) dayMap.set(day, { entries: 0, exits: 0, workers: new Set() });
    const d = dayMap.get(day);
    if (log.event_type === 'ENTRY') d.entries++; else d.exits++;
    if (log.worker_id) d.workers.add(log.worker_id);
  }
  const presenceSummary = {
    total_entries:       allLogs.filter(l => l.event_type === 'ENTRY').length,
    days_with_presence:  dayMap.size,
    recent_days: Array.from(dayMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, d]) => ({
        date, worker_count: d.workers.size,
        entries: d.entries, exits: d.exits,
        anomalies: d.entries - d.exits > 0 ? d.entries - d.exits : 0,
      })),
  };

  const ncList      = ncR.data || [];
  const openNcCount = ncList.filter(n => n.status === 'aperta' || n.status === 'in_lavorazione').length;

  const safetyStatus   = computeSafetyStatus(workers, ncList);
  const activeIssues   = buildActiveIssues(workers, ncList);
  const todayPresences = await getTodayPresences(siteId, companyId, workers);
  const documentStatus = await getDocumentStatus(siteId, companyId);

  // Mezzi
  const equipment = (equipR.data || []).map(e => {
    const dates = [e.inspection_date, e.insurance_expiry, e.maintenance_date].filter(Boolean);
    const status = dates.some(d => d < today) ? 'expired'
      : dates.some(d => d >= today && d <= in30) ? 'expiring' : 'ok';
    return {
      id: e.id, type: e.type, model: e.model || '',
      plateOrSerial: e.plate_or_serial || '', ownership: e.ownership, status,
      maintenance: { inspection: e.inspection_date, insurance: e.insurance_expiry, scheduled: e.maintenance_date },
    };
  });

  return {
    site: { ...siteR.data, company_name: siteR.data.companies?.name || '—' },
    coordinator: {
      name:       invite.coordinator_name,
      company:    invite.coordinator_company || null,
      email:      invite.coordinator_email   || null,
      expires_at: invite.expires_at,
      invite_id:  invite.id,
    },
    safety_status:    safetyStatus,
    active_issues:    activeIssues,
    today_presences:  todayPresences,
    document_status:  documentStatus,
    workers,
    on_site_count:    onSiteIds.size,
    presence_summary: presenceSummary,
    notes:            notesR.data || [],
    nonconformities:  ncList,
    open_nc_count:    openNcCount,
    visits:           visitsR.data || [],
    recent_verifications: verifR.data || [],
    subcontractors:   subsR.data || [],
    equipment,
  };
}

// ─── GET /coordinator/portal/:token — resolve + dati iniziali ─────────────────
router.get('/coordinator/portal/:token', coordinatorLimiter, async (req, res) => {
  const resolved = await resolvePortalToken(req.params.token);
  if (!resolved) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  // ── CSE: sempre single ────────────────────────────────────────────────────
  if (resolved.type === 'cse') {
    const invite = resolved.invite;
    supabase.from('coordinator_visits').insert({
      invite_id: invite.id, company_id: invite.company_id, site_id: invite.site_id,
      coordinator_name: invite.coordinator_name, coordinator_email: invite.coordinator_email || null,
      accessed_via: 'portal_cse',
    }).then(null, () => {});
    supabase.rpc('increment_coord_access', { p_invite_id: invite.id }).then(null, () => {});

    const data = await getFullSiteData(invite);
    if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    return res.json({ auth_type: 'cse', mode: 'single', ...data });
  }

  // ── Pro: conta cantieri attivi ────────────────────────────────────────────
  const { session } = resolved;
  supabase.from('coordinator_pro_sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', session.id).then(() => {});

  const { data: invites } = await supabase
    .from('site_coordinator_invites')
    .select('id, site_id, coordinator_name, coordinator_company, expires_at, company_id')
    .eq('coordinator_email', session.email)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString());

  const activeInvites = invites || [];

  if (activeInvites.length === 0) {
    return res.json({
      auth_type: 'pro', mode: 'empty',
      coordinator: { email: session.email, name: null, company: null },
      sites: [],
    });
  }

  if (activeInvites.length === 1) {
    const invite = activeInvites[0];
    supabase.from('coordinator_visits').insert({
      invite_id: invite.id, company_id: invite.company_id, site_id: invite.site_id,
      coordinator_name: invite.coordinator_name, coordinator_email: session.email,
      accessed_via: 'portal_pro',
    }).then(null, () => {});

    const data = await getFullSiteData(invite);
    if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    return res.json({ auth_type: 'pro', mode: 'single', ...data });
  }

  // Multi-site: lista sintetica per il picker
  const siteIds   = [...new Set(activeInvites.map(i => i.site_id))];
  const inviteMap = {};
  for (const inv of activeInvites) if (!inviteMap[inv.site_id]) inviteMap[inv.site_id] = inv;

  const [sitesR, workersR, presR, notesR, ncR] = await Promise.all([
    supabase.from('sites').select('id, name, address, status, companies(name)').in('id', siteIds),
    supabase.from('worksite_workers')
      .select('site_id, worker:workers(safety_training_expiry, health_fitness_expiry)')
      .in('site_id', siteIds).eq('status', 'active'),
    supabase.from('presence_logs')
      .select('site_id, worker_id, event_type')
      .in('site_id', siteIds)
      .gte('timestamp_server', new Date(Date.now() - 30 * 3600000).toISOString())
      .order('timestamp_server', { ascending: false }),
    supabase.from('site_coordinator_notes')
      .select('site_id, is_read').in('site_id', siteIds).eq('is_read', false),
    supabase.from('site_nonconformities')
      .select('site_id')
      .in('invite_id', activeInvites.map(i => i.id))
      .in('status', ['aperta', 'in_lavorazione']),
  ]);

  const wBySite = {};
  for (const row of workersR.data || []) {
    (wBySite[row.site_id] = wBySite[row.site_id] || []).push(row.worker);
  }
  const lastEvt = {};
  for (const log of presR.data || []) {
    const k = `${log.site_id}_${log.worker_id}`;
    if (!lastEvt[k]) lastEvt[k] = { siteId: log.site_id, type: log.event_type };
  }
  const onSite = {};
  for (const { siteId, type } of Object.values(lastEvt)) {
    if (type === 'ENTRY') onSite[siteId] = (onSite[siteId] || 0) + 1;
  }
  const unread = {};
  for (const n of notesR.data || []) unread[n.site_id] = (unread[n.site_id] || 0) + 1;
  const openNcBySite = {};
  for (const nc of ncR.data || []) openNcBySite[nc.site_id] = (openNcBySite[nc.site_id] || 0) + 1;

  const sites = (sitesR.data || []).map(site => {
    const ws = wBySite[site.id] || [];
    let compliant = 0, expiring = 0, nonCompliant = 0;
    for (const w of ws) {
      const s = complianceStatus(w.safety_training_expiry);
      const h = complianceStatus(w.health_fitness_expiry);
      if (s === 'expired' || h === 'expired') nonCompliant++;
      else if (s === 'expiring' || h === 'expiring') expiring++;
      else compliant++;
    }
    const inv = inviteMap[site.id];
    return {
      id: site.id, name: site.name, address: site.address || '—',
      status: site.status, company_name: site.companies?.name || '—',
      workers_count: ws.length, workers_on_site: onSite[site.id] || 0,
      unread_notes: unread[site.id] || 0, open_nc: openNcBySite[site.id] || 0,
      compliance: { compliant, expiring, non_compliant: nonCompliant, total: ws.length },
      invite_id: inv?.id, invite_expires_at: inv?.expires_at,
    };
  });

  res.json({
    auth_type: 'pro', mode: 'multi',
    coordinator: {
      email:   session.email,
      name:    activeInvites[0].coordinator_name,
      company: activeInvites[0].coordinator_company,
    },
    sites,
  });
});

// ── GET /coordinator/portal/:token/site/:siteId — dettaglio cantiere ──────────
router.get('/coordinator/portal/:token/site/:siteId', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  supabase.from('coordinator_visits').insert({
    invite_id: result.invite.id, company_id: result.invite.company_id,
    site_id: req.params.siteId, coordinator_name: result.invite.coordinator_name,
    coordinator_email: result.invite.coordinator_email || null,
    accessed_via: `portal_${result.auth_type}`,
  }).then(null, () => {});

  const data = await getFullSiteData(result.invite);
  if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  return res.json({ auth_type: result.auth_type, mode: 'single', ...data });
});

// ── POST /coordinator/portal/:token/site/:siteId/notes ───────────────────────
router.post('/coordinator/portal/:token/site/:siteId/notes', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { invite }                     = result;
  const { note_type = 'observation', content } = req.body || {};
  const VALID_TYPES = ['observation', 'request', 'approval', 'warning'];

  if (!content || typeof content !== 'string' || content.trim().length < 3 || content.length > 2000) {
    return res.status(400).json({ error: 'CONTENT_INVALID', message: 'Contenuto: minimo 3 caratteri.' });
  }
  const safeType = VALID_TYPES.includes(note_type) ? note_type : 'observation';

  const { data: note, error } = await supabase
    .from('site_coordinator_notes')
    .insert({
      company_id: invite.company_id, site_id: invite.site_id,
      invite_id: invite.id, note_type: safeType,
      content: content.trim(), coordinator_name: invite.coordinator_name,
    })
    .select('id, note_type, content, coordinator_name, created_at').single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  try {
    const { data: site } = await supabase.from('sites').select('name').eq('id', invite.site_id).maybeSingle();
    await sendCoordinatorNoteAlert({
      companyId:       invite.company_id,
      siteName:        site?.name || 'Cantiere',
      coordinatorName: invite.coordinator_name,
      noteType:        safeType,
      content:         content.trim(),
      siteUrl:         `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/cantieri/${invite.site_id}`,
    });
  } catch { /* non blocca */ }

  res.status(201).json({ ok: true, note });
});

// ── POST /coordinator/portal/:token/site/:siteId/nonconformities ─────────────
router.post('/coordinator/portal/:token/site/:siteId/nonconformities', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { invite } = result;
  const { title, description, category, severity, due_date } = req.body || {};

  const VALID_CATS = ['sicurezza', 'documentale', 'operativa', 'igiene'];
  const VALID_SEVS = ['bassa', 'media', 'alta', 'critica'];

  if (!title || String(title).trim().length < 3) {
    return res.status(400).json({ error: 'TITLE_REQUIRED', message: 'Titolo: minimo 3 caratteri.' });
  }
  if (!description || String(description).trim().length < 3) {
    return res.status(400).json({ error: 'DESCRIPTION_REQUIRED', message: 'Descrizione: minimo 3 caratteri.' });
  }

  const safeCategory = VALID_CATS.includes(category) ? category : 'sicurezza';
  const safeSeverity = VALID_SEVS.includes(severity) ? severity : 'media';
  const safeDueDate  = due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;

  const { data: nc, error } = await supabase
    .from('site_nonconformities')
    .insert({
      company_id:       invite.company_id,
      site_id:          invite.site_id,
      invite_id:        invite.id,
      coordinator_name: invite.coordinator_name,
      coordinator_email: invite.coordinator_email || null,
      title:            String(title).trim().slice(0, 300),
      description:      String(description).trim().slice(0, 3000),
      category:         safeCategory,
      severity:         safeSeverity,
      status:           'aperta',
      due_date:         safeDueDate,
    })
    .select('id, title, description, category, severity, status, due_date, created_at').single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  try {
    const { data: site } = await supabase.from('sites').select('name').eq('id', invite.site_id).maybeSingle();
    sendNonconformityAlert({
      companyId:       invite.company_id,
      siteName:        site?.name || 'Cantiere',
      coordinatorName: invite.coordinator_name,
      severity:        safeSeverity,
      category:        safeCategory,
      title:           nc.title,
      siteUrl:         `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/cantieri/${invite.site_id}`,
    }).catch(() => {});
  } catch { /* non blocca */ }

  res.status(201).json({ ok: true, nonconformity: nc });
});

// ── PATCH /coordinator/portal/:token/site/:siteId/nonconformities/:ncId/close ─
router.patch('/coordinator/portal/:token/site/:siteId/nonconformities/:ncId/close', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('site_nonconformities')
    .update({ status: 'chiusa', closed_by_coordinator_at: new Date().toISOString() })
    .eq('id', req.params.ncId)
    .eq('invite_id', result.invite.id)
    .select('id, status').single();

  if (error || !data) return res.status(404).json({ error: 'NC_NOT_FOUND' });
  res.json({ ok: true, nc: data });
});

// ── POST /coordinator/portal/:token/site/:siteId/verifications ───────────────
router.post('/coordinator/portal/:token/site/:siteId/verifications', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { invite } = result;
  const rawNote = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;

  const [wwRes, ncRes] = await Promise.all([
    supabase.from('worksite_workers')
      .select('worker:workers(id, full_name, safety_training_expiry, health_fitness_expiry, is_active)')
      .eq('site_id', invite.site_id).eq('company_id', invite.company_id).eq('status', 'active'),
    supabase.from('site_nonconformities')
      .select('id, title, category, severity, status, created_at')
      .eq('invite_id', invite.id).order('created_at', { ascending: false }).limit(100),
  ]);

  function cs(expiry) {
    if (!expiry) return 'not_set';
    const days = (new Date(expiry) - Date.now()) / 86400000;
    return days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'ok';
  }
  function oc(s, h) {
    const sts = [s, h];
    return sts.includes('expired') ? 'non_compliant'
      : sts.includes('expiring') ? 'expiring'
      : sts.includes('not_set') ? 'incomplete' : 'compliant';
  }
  const workers = (wwRes.data || []).filter(r => r.worker?.is_active).map(r => ({
    id: r.worker.id, full_name: r.worker.full_name,
    compliance: { overall: oc(cs(r.worker.safety_training_expiry), cs(r.worker.health_fitness_expiry)) },
  }));

  const ncList         = ncRes.data || [];
  const safetyStatus   = computeSafetyStatus(workers, ncList);
  const activeIssues   = buildActiveIssues(workers, ncList);
  const todayPresences = await getTodayPresences(invite.site_id, invite.company_id, workers);
  const docStatus      = await getDocumentStatus(invite.site_id, invite.company_id);

  const { data: verif, error } = await supabase
    .from('coordinator_verifications')
    .insert({
      invite_id:              invite.id,
      company_id:             invite.company_id,
      site_id:                invite.site_id,
      coordinator_name:       invite.coordinator_name,
      coordinator_email:      invite.coordinator_email || null,
      accessed_via:           `portal_${result.auth_type}`,
      safety_status:          safetyStatus.level,
      open_nc_count:          safetyStatus.open_nc_count,
      critical_nc_count:      safetyStatus.critical_nc_count,
      non_compliant_workers:  safetyStatus.non_compliant_workers,
      expiring_workers:       safetyStatus.expiring_workers,
      workers_present_today:  todayPresences.present_count,
      active_issues_snapshot: JSON.stringify(activeIssues),
      document_snapshot:      JSON.stringify(docStatus),
      note:                   rawNote,
      ip_address:             req.ip || null,
      user_agent:             req.headers['user-agent']?.slice(0, 300) || null,
    })
    .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, created_at')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.status(201).json({
    ok: true,
    verification: verif,
    safety_status: { level: safetyStatus.level, label: safetyStatus.label, reasons: safetyStatus.reasons },
  });
});

// ── GET /coordinator/portal/:token/site/:siteId/timeline ─────────────────────
router.get('/coordinator/portal/:token/site/:siteId/timeline', coordinatorLimiter, async (req, res) => {
  const result = await getInviteForSite(req.params.token, req.params.siteId);
  if (!result) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { invite } = result;

  const [verifRes, ncRes, notesRes] = await Promise.all([
    supabase.from('coordinator_verifications')
      .select('id, safety_status, open_nc_count, critical_nc_count, non_compliant_workers, workers_present_today, note, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(100),
    supabase.from('site_nonconformities')
      .select('id, title, severity, category, status, coordinator_name, created_at, resolved_at, closed_by_coordinator_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(100),
    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false }).limit(100),
  ]);

  const timeline = buildTimeline(verifRes.data || [], ncRes.data || [], notesRes.data || []);
  res.json({ timeline, coordinator_name: invite.coordinator_name });
});

module.exports = router;
