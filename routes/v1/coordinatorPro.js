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

// ── POST /api/v1/coordinator/pro/register ─────────────────────────────────────
// Registrazione autonoma professionista — funziona anche senza inviti esistenti.
// Salva il profilo, genera sessione, invia magic link.
// Body: { email, full_name, qualifica, azienda?, piva? }
router.post('/coordinator/pro/register', async (req, res) => {
  const email     = (req.body?.email     || '').trim().toLowerCase();
  const fullName  = (req.body?.full_name || '').trim();
  const qualifica = (req.body?.qualifica || 'Altro').trim();
  const azienda   = (req.body?.azienda   || '').trim() || null;
  const piva      = (req.body?.piva      || '').trim() || null;

  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }
  if (!fullName || fullName.length < 2) {
    return res.status(400).json({ error: 'NAME_REQUIRED' });
  }

  const VALID_QUALIFICHE = ['CSE', 'CSP', 'Direttore Lavori', 'RUP', 'RSPP', 'Altro'];
  const safeQualifica = VALID_QUALIFICHE.includes(qualifica) ? qualifica : 'Altro';

  // Risposta immediata
  res.json({ ok: true });

  try {
    // Salva/aggiorna profilo professionista
    await supabase.from('coordinator_profiles').upsert({
      email, full_name: fullName, qualifica: safeQualifica, azienda, piva,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    // Genera sessione e invia magic link
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PRO_TOKEN_TTL_DAYS * 86400000).toISOString();

    const { error: insertErr } = await supabase
      .from('coordinator_pro_sessions')
      .insert({ email, token_hash: hashToken(token), expires_at: expiresAt });

    if (insertErr) { console.error('[pro-register] insert error:', insertErr.message); return; }

    const { sendProMagicLinkEmail } = require('../../services/email');
    await sendProMagicLinkEmail({
      to: email,
      coordinatorName: fullName,
      coordinatorCompany: azienda,
      accessUrl: `${appUrl()}/pro/accesso/${token}`,
    });
  } catch (e) {
    console.error('[pro-register] background error:', e.message);
  }
});

// ── POST /api/v1/coordinator/pro/request ──────────────────────────────────────
// Richiesta magic link per email già registrata (login successivo).
// Risponde sempre OK (security: non rivela se email esiste).
router.post('/coordinator/pro/request', async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }
  res.json({ ok: true });

  try {
    // Cerca profilo esistente O inviti (per supportare anche il vecchio flusso)
    const [profileResult, invitesResult] = await Promise.all([
      supabase.from('coordinator_profiles').select('full_name, azienda').eq('email', email).maybeSingle(),
      supabase.from('site_coordinator_invites')
        .select('id, coordinator_name, coordinator_company')
        .eq('coordinator_email', email).eq('is_active', true)
        .gt('expires_at', new Date().toISOString()).limit(1),
    ]);

    const profile  = profileResult.data;
    const invites  = invitesResult.data;
    const name     = profile?.full_name || invites?.[0]?.coordinator_name;
    const azienda  = profile?.azienda   || invites?.[0]?.coordinator_company;

    // Genera sessione solo se esiste un profilo o un invito
    if (!profile && (!invites || invites.length === 0)) return;

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PRO_TOKEN_TTL_DAYS * 86400000).toISOString();

    const { error: insertErr } = await supabase
      .from('coordinator_pro_sessions')
      .insert({ email, token_hash: hashToken(token), expires_at: expiresAt });

    if (insertErr) { console.error('[pro-request] insert error:', insertErr.message); return; }

    const { sendProMagicLinkEmail } = require('../../services/email');
    await sendProMagicLinkEmail({
      to: email, coordinatorName: name, coordinatorCompany: azienda,
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

  // Non conformità aperte per cantiere (raggruppa per invite_id → site_id)
  const inviteIds = invites.map(i => i.id);
  let openNcBySite = {};
  if (inviteIds.length > 0) {
    const { data: openNcData } = await supabase
      .from('site_nonconformities')
      .select('site_id')
      .in('invite_id', inviteIds)
      .in('status', ['aperta', 'in_lavorazione']);
    for (const nc of openNcData || []) {
      openNcBySite[nc.site_id] = (openNcBySite[nc.site_id] || 0) + 1;
    }
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
      open_nc: openNcBySite[site.id] || 0,
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
    open_nc:       sites.reduce((s, d) => s + d.open_nc, 0),
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

  // Registra visita (best-effort)
  supabase.from('coordinator_visits').insert({
    invite_id:         invite.id,
    company_id:        invite.company_id,
    site_id:           siteId,
    coordinator_name:  invite.coordinator_name,
    coordinator_email: session.email,
    accessed_via:      'pro',
  }).then(null, () => {});

  // ── Estendi trial a 30 giorni se l'impresa è ancora in trial ─────────────
  // Un professionista accreditato porta valore → l'impresa guadagna più tempo.
  // Si estende solo se trial_ends_at < now + 30 giorni (nessun doppio bonus).
  try {
    const { data: co } = await supabase
      .from('companies')
      .select('subscription_status, trial_ends_at')
      .eq('id', invite.company_id)
      .maybeSingle();

    if (co && co.subscription_status === 'trial') {
      const thirtyDays = new Date(Date.now() + 30 * 86400000).toISOString();
      if (!co.trial_ends_at || co.trial_ends_at < thirtyDays) {
        await supabase
          .from('companies')
          .update({ trial_ends_at: thirtyDays })
          .eq('id', invite.company_id);
      }
    }
  } catch { /* non blocca la risposta */ }

  const [siteR, workersR, presenceR, notesR, ncR, visitsR] = await Promise.all([
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
      .gte('timestamp_server', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('timestamp_server', { ascending: false })
      .limit(1000),

    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, is_read, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase.from('site_nonconformities')
      .select('id, title, category, severity, status, due_date, resolution_notes, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase.from('coordinator_visits')
      .select('id, accessed_via, visited_at')
      .eq('invite_id', invite.id)
      .order('visited_at', { ascending: false })
      .limit(30),
  ]);

  if (siteR.error || !siteR.data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Chi è in cantiere adesso + presenze 7 giorni
  const allLogs = presenceR.data || [];
  const lastEvt = {};
  for (const log of allLogs) {
    if (!lastEvt[log.worker_id]) lastEvt[log.worker_id] = log.event_type;
  }
  const onSiteIds = new Set(
    Object.entries(lastEvt).filter(([, t]) => t === 'ENTRY').map(([id]) => id)
  );

  // Aggregazione 7 giorni
  const dayMap = new Map();
  for (const log of allLogs) {
    const day = log.timestamp_server.split('T')[0];
    if (!dayMap.has(day)) dayMap.set(day, { entries: 0, exits: 0, workers: new Set() });
    const d = dayMap.get(day);
    if (log.event_type === 'ENTRY') d.entries++;
    else d.exits++;
    if (log.worker_id) d.workers.add(log.worker_id);
  }
  const totalEntries7d = allLogs.filter(l => l.event_type === 'ENTRY').length;
  const presenceSummary = {
    total_entries:      totalEntries7d,
    days_with_presence: dayMap.size,
    recent_days: Array.from(dayMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, d]) => ({
        date,
        worker_count: d.workers.size,
        entries: d.entries,
        exits: d.exits,
        anomalies: d.entries - d.exits > 0 ? d.entries - d.exits : 0,
      })),
  };

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

  const ncList     = ncR.data    || [];
  const openNcCount = ncList.filter(n => n.status === 'aperta' || n.status === 'in_lavorazione').length;

  res.json({
    site: { ...siteR.data, company_name: siteR.data.companies?.name || '—' },
    coordinator: {
      name:       invite.coordinator_name,
      company:    invite.coordinator_company,
      expires_at: invite.expires_at,
      invite_id:  invite.id,
    },
    workers,
    on_site_count:    onSiteIds.size,
    presence_summary: presenceSummary,
    notes:            notesR.data  || [],
    nonconformities:  ncList,
    open_nc_count:    openNcCount,
    visits:           visitsR.data || [],
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

// ── POST /api/v1/coordinator/pro/:token/telegram-code ─────────────────────────
// Genera un codice OTP (8 char, 15 min) per collegare Telegram al profilo Pro.
// Il coordinatore invia il codice al bot con /pro CODICE.
router.post('/coordinator/pro/:token/telegram-code', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID' });

  const email = session.email;

  // Elimina eventuali codici precedenti non usati per questa email
  await supabase
    .from('telegram_coordinator_link_codes')
    .delete()
    .eq('email', email)
    .is('used_at', null);

  // Genera codice 8 char uppercase alfanumerico (esclude O/0/I/1 per leggibilità)
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += CHARS[bytes[i] % CHARS.length];

  const { error } = await supabase
    .from('telegram_coordinator_link_codes')
    .insert({ email, code });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'PalladiaBot';
  res.json({
    code,
    expires_in_minutes: 15,
    telegram_link: `https://t.me/${botUsername}?start=pro_${code}`,
    instructions: `Vai su Telegram e invia al bot: /pro ${code}`,
  });
});

// ── GET /api/v1/coordinator/pro/:token/telegram-status ────────────────────────
// Controlla se il coordinatore ha già collegato Telegram.
router.get('/coordinator/pro/:token/telegram-status', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID' });

  const { data } = await supabase
    .from('telegram_coordinator_links')
    .select('telegram_name, telegram_username, linked_at')
    .eq('email', session.email)
    .maybeSingle();

  if (!data) return res.json({ linked: false });

  res.json({
    linked: true,
    telegram_name: data.telegram_name,
    telegram_username: data.telegram_username,
    linked_at: data.linked_at,
  });
});

// ── DELETE /api/v1/coordinator/pro/:token/telegram-unlink ─────────────────────
// Scollega Telegram dal profilo Pro del coordinatore.
router.delete('/coordinator/pro/:token/telegram-unlink', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID' });

  await supabase
    .from('telegram_coordinator_links')
    .delete()
    .eq('email', session.email);

  res.json({ ok: true });
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/documents ────────────────
router.get('/coordinator/pro/:token/site/:siteId/documents', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });
  const { siteId } = req.params;
  const now = new Date().toISOString();

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id')
    .eq('coordinator_email', session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', now)
    .maybeSingle();
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const [{ data: uploaded, error }, { data: posDocs }] = await Promise.all([
    supabase.from('site_documents')
      .select('id, name, category, file_size, mime_type, created_at')
      .eq('site_id', siteId).eq('company_id', invite.company_id)
      .order('created_at', { ascending: false }),
    supabase.from('pos_documents')
      .select('id, revision, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const posFormatted = (posDocs || []).map(p => ({
    id: `pos_${p.id}`, pos_id: p.id,
    name: `POS — Revisione ${p.revision}`, category: 'pos',
    file_size: null, mime_type: 'application/pdf', created_at: p.created_at, source: 'pos',
  }));
  const all = [...(uploaded || []).map(d => ({ ...d, source: 'upload' })), ...posFormatted]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(all);
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/documents/:docId/download ─
router.get('/coordinator/pro/:token/site/:siteId/documents/:docId/download', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });
  const { siteId, docId } = req.params;
  const now = new Date().toISOString();

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id')
    .eq('coordinator_email', session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', now)
    .maybeSingle();
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data: doc } = await supabase
    .from('site_documents')
    .select('id, file_path, name, mime_type')
    .eq('id', docId).eq('site_id', siteId).eq('company_id', invite.company_id)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents').createSignedUrl(doc.file_path, 1800);
  if (signErr || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: signed.signedUrl, name: doc.name });
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/pos/:posId/pdf ───────────
router.get('/coordinator/pro/:token/site/:siteId/pos/:posId/pdf', async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'INVALID_TOKEN' });
  const { siteId, posId } = req.params;
  const now = new Date().toISOString();

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id')
    .eq('coordinator_email', session.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .gt('expires_at', now)
    .maybeSingle();
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data: pos } = await supabase
    .from('pos_documents')
    .select('id, revision, content, pos_data')
    .eq('id', posId).eq('site_id', siteId).maybeSingle();
  if (!pos) return res.status(404).json({ error: 'POS_NOT_FOUND' });

  const { data: site } = await supabase.from('sites').select('name').eq('id', siteId).maybeSingle();
  const siteName = (site?.name || 'Cantiere').replace(/[^a-zA-Z0-9]/g, '_');

  try {
    const { generatePosHtml } = require('../../pos-html-generator');
    const { selectSigns }     = require('../../sign-selector');
    const { rendererPool }    = require('../../pdf-renderer');
    const signs     = selectSigns(pos.pos_data || {});
    const html      = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
    const pdfBuffer = await rendererPool.render(html, {
      docTitle: `POS – ${site?.name || 'Cantiere'} – Rev. ${pos.revision}`,
      revision: pos.revision,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="POS-Rev${pos.revision}-${siteName}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[coordinatorPro] POS pdf error:', e.message);
    res.status(500).json({ error: 'PDF_GENERATION_ERROR' });
  }
});

module.exports = router;
