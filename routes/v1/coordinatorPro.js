'use strict';
const crypto = require('crypto');
const router = require('express').Router();
const supabase = require('../../lib/supabase');

const PRO_TOKEN_TTL_DAYS = 365;

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}

function appUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function complianceStatus(expiry) {
  if (!expiry) return 'not_set';
  const days = (new Date(expiry) - Date.now()) / 86400000;
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'ok';
}

async function resolveProSession(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('coordinator_pro_sessions')
    .select('*')
    .eq('token_hash', hashToken(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

// ── POST /api/v1/coordinator/pro/request ──────────────────────────────────────
// Richiesta magic link — risponde sempre OK (security: non rivela se email esiste)
router.post('/coordinator/pro/request', async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }
  // Risposta immediata — il resto va in background
  res.json({ ok: true });

  try {
    const now = new Date().toISOString();
    const { data: invites } = await supabase
      .from('site_coordinator_invites')
      .select('id, coordinator_name, coordinator_company')
      .eq('coordinator_email', email)
      .eq('is_active', true)
      .gt('expires_at', now)
      .limit(1);

    if (!invites || invites.length === 0) return;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PRO_TOKEN_TTL_DAYS * 86400000).toISOString();

    const { error: insertErr } = await supabase
      .from('coordinator_pro_sessions')
      .insert({ email, token_hash: hashToken(token), expires_at: expiresAt });

    if (insertErr) {
      console.error('[pro-request] insert error:', insertErr.message);
      return;
    }

    const { sendProMagicLinkEmail } = require('../../services/email');
    await sendProMagicLinkEmail({
      to: email,
      coordinatorName: invites[0].coordinator_name,
      coordinatorCompany: invites[0].coordinator_company,
      accessUrl: `${appUrl()}/pro/accesso/${token}`,
    });
  } catch (e) {
    console.error('[pro-request] background error:', e.message);
  }
});

// ── GET /api/v1/coordinator/pro/:token ────────────────────────────────────────
// Dashboard aggregata: tutti i cantieri del professionista
router.get('/coordinator/pro/:token', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });

  // Aggiorna last_used_at (fire-and-forget)
  supabase.from('coordinator_pro_sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', session.id)
    .then(() => {});

  const now = new Date().toISOString();
  const { data: invites } = await supabase
    .from('site_coordinator_invites')
    .select('id, site_id, coordinator_name, coordinator_company, expires_at')
    .eq('coordinator_email', session.email)
    .eq('is_active', true)
    .gt('expires_at', now);

  if (!invites || invites.length === 0) {
    return res.json({
      coordinator: { email: session.email, name: null, company: null },
      sites: [],
      stats: { total_sites: 0, active_sites: 0, total_workers: 0,
               unread_notes: 0, expiring_docs: 0, non_compliant: 0, on_site_now: 0 },
    });
  }

  const siteIds = [...new Set(invites.map(i => i.site_id))];

  const [sitesR, workersR, presenceR, notesR] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address, status, companies(name)')
      .in('id', siteIds),

    supabase.from('worksite_workers')
      .select('site_id, worker:workers(safety_training_expiry, health_fitness_expiry)')
      .in('site_id', siteIds)
      .eq('status', 'active'),

    supabase.from('presence_logs')
      .select('site_id, worker_id, event_type')
      .in('site_id', siteIds)
      .gte('timestamp_server', new Date(Date.now() - 30 * 3600000).toISOString())
      .order('timestamp_server', { ascending: false }),

    supabase.from('site_coordinator_notes')
      .select('site_id, is_read')
      .in('site_id', siteIds)
      .eq('is_read', false),
  ]);

  // Workers by site
  const wBySite = {};
  for (const row of workersR.data || []) {
    (wBySite[row.site_id] = wBySite[row.site_id] || []).push(row.worker);
  }

  // Chi è in cantiere adesso (ultimo evento = ENTRY)
  const lastEvt = {};
  for (const log of presenceR.data || []) {
    const k = `${log.site_id}_${log.worker_id}`;
    if (!lastEvt[k]) lastEvt[k] = { siteId: log.site_id, type: log.event_type };
  }
  const onSite = {};
  for (const { siteId, type } of Object.values(lastEvt)) {
    if (type === 'ENTRY') onSite[siteId] = (onSite[siteId] || 0) + 1;
  }

  // Note non lette per cantiere
  const unread = {};
  for (const n of notesR.data || []) {
    unread[n.site_id] = (unread[n.site_id] || 0) + 1;
  }

  // Mappa inviti per site_id
  const inviteMap = {};
  for (const inv of invites) {
    if (!inviteMap[inv.site_id]) inviteMap[inv.site_id] = inv;
  }

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
      id: site.id,
      name: site.name,
      address: site.address || '—',
      status: site.status,
      company_name: site.companies?.name || '—',
      workers_count: ws.length,
      workers_on_site: onSite[site.id] || 0,
      unread_notes: unread[site.id] || 0,
      compliance: { compliant, expiring, non_compliant: nonCompliant, total: ws.length },
      invite_id: inv?.id,
      invite_expires_at: inv?.expires_at,
    };
  });

  const stats = {
    total_sites:   sites.length,
    active_sites:  sites.filter(s => s.status === 'attivo').length,
    total_workers: sites.reduce((s, d) => s + d.workers_count, 0),
    on_site_now:   sites.reduce((s, d) => s + d.workers_on_site, 0),
    unread_notes:  sites.reduce((s, d) => s + d.unread_notes, 0),
    expiring_docs: sites.reduce((s, d) => s + d.compliance.expiring, 0),
    non_compliant: sites.reduce((s, d) => s + d.compliance.non_compliant, 0),
  };

  res.json({
    coordinator: {
      email: session.email,
      name: invites[0].coordinator_name,
      company: invites[0].coordinator_company,
    },
    sites,
    stats,
  });
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId ───────────────────────────
// Dati completi di un singolo cantiere (accesso tramite pro token)
router.get('/coordinator/pro/:token/site/:siteId', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const { siteId } = req.params;
  const now = new Date().toISOString();

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, coordinator_name, coordinator_company, expires_at, company_id')
    .eq('coordinator_email', session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', now)
    .maybeSingle();

  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const [siteR, workersR, presenceR, notesR] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address, status, client, start_date, companies(name)')
      .eq('id', siteId).single(),

    supabase.from('worksite_workers')
      .select(`
        worker:workers(
          id, full_name, fiscal_code, role, qualification,
          employer_name, safety_training_expiry, health_fitness_expiry
        )
      `)
      .eq('site_id', siteId).eq('status', 'active'),

    supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId)
      .gte('timestamp_server', new Date(Date.now() - 30 * 3600000).toISOString())
      .order('timestamp_server', { ascending: false }),

    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, is_read, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  if (siteR.error || !siteR.data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Chi è in cantiere adesso
  const lastEvt = {};
  for (const log of presenceR.data || []) {
    if (!lastEvt[log.worker_id]) lastEvt[log.worker_id] = log.event_type;
  }
  const onSiteIds = new Set(
    Object.entries(lastEvt).filter(([, t]) => t === 'ENTRY').map(([id]) => id)
  );

  const workers = (workersR.data || [])
    .map(({ worker: w }) => ({
      ...w,
      on_site: onSiteIds.has(w.id),
      compliance: {
        safety: complianceStatus(w.safety_training_expiry),
        health: complianceStatus(w.health_fitness_expiry),
      },
    }))
    .sort((a, b) => (b.on_site ? 1 : 0) - (a.on_site ? 1 : 0));

  res.json({
    site: { ...siteR.data, company_name: siteR.data.companies?.name || '—' },
    coordinator: {
      name: invite.coordinator_name,
      company: invite.coordinator_company,
      expires_at: invite.expires_at,
      invite_id: invite.id,
    },
    workers,
    on_site_count: onSiteIds.size,
    notes: notesR.data || [],
  });
});

// ── POST /api/v1/coordinator/pro/:token/site/:siteId/notes ───────────────────
// Il professionista aggiunge una nota su un cantiere
router.post('/coordinator/pro/:token/site/:siteId/notes', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const { siteId } = req.params;
  const { note_type = 'observation', content } = req.body;
  const now = new Date().toISOString();

  if (!content || typeof content !== 'string' || content.trim().length < 3 || content.length > 2000) {
    return res.status(400).json({ error: 'INVALID_CONTENT' });
  }
  const VALID_TYPES = ['observation', 'request', 'approval', 'warning'];
  const safeType = VALID_TYPES.includes(note_type) ? note_type : 'observation';

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, coordinator_name, company_id')
    .eq('coordinator_email', session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', now)
    .maybeSingle();

  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data: note, error } = await supabase
    .from('site_coordinator_notes')
    .insert({
      company_id: invite.company_id,
      site_id: siteId,
      invite_id: invite.id,
      note_type: safeType,
      content: content.trim(),
      coordinator_name: invite.coordinator_name,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Notifica email all'impresa (best-effort)
  try {
    const { data: site } = await supabase.from('sites').select('name').eq('id', siteId).single();
    const { sendCoordinatorNoteAlert } = require('../../services/email');
    await sendCoordinatorNoteAlert({
      companyId: invite.company_id,
      siteName: site?.name || siteId,
      coordinatorName: invite.coordinator_name,
      noteType: safeType,
      content: content.trim(),
      siteUrl: `${appUrl()}/cantieri/${siteId}`,
    });
  } catch { /* non blocca la risposta */ }

  res.json({ ok: true, note });
});

module.exports = router;
