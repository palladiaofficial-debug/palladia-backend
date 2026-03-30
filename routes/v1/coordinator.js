'use strict';
// ── Coordinatore della Sicurezza (CSE) ───────────────────────────────────────
// Endpoint privati (JWT) — gestione inviti dal lato impresa:
//   POST   /api/v1/sites/:siteId/coordinator-invites        — crea invito
//   GET    /api/v1/sites/:siteId/coordinator-invites        — lista inviti
//   DELETE /api/v1/coordinator-invites/:inviteId            — disattiva
//   GET    /api/v1/sites/:siteId/coordinator-notes          — note ricevute (impresa)
//   PATCH  /api/v1/coordinator-notes/:noteId/read           — segna come letta
//
// Endpoint pubblici (token nel path) — accesso coordinatore:
//   GET    /api/v1/coordinator/:token                       — dati cantiere read-only
//   GET    /api/v1/coordinator/:token/notes                 — note del coordinatore
//   POST   /api/v1/coordinator/:token/notes                 — aggiunge nota
// ─────────────────────────────────────────────────────────────────────────────
const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }    = require('../../middleware/verifyJwt');
const { coordinatorLimiter }   = require('../../middleware/rateLimit');
const { auditLog }             = require('../../lib/audit');
const { sendCoordinatorInviteEmail, sendCoordinatorNoteAlert } = require('../../services/email');

const COORD_TTL_DAYS_DEFAULT = 90;

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Calcola stato compliance da data di scadenza
function complianceStatus(expiryDate) {
  if (!expiryDate) return 'not_set';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  if (expiry < today) return 'expired';
  const in30 = new Date(today);
  in30.setDate(in30.getDate() + 30);
  if (expiry <= in30) return 'expiring';
  return 'ok';
}

function overallCompliance(safety, health) {
  const statuses = [safety, health];
  if (statuses.includes('expired'))  return 'non_compliant';
  if (statuses.includes('expiring')) return 'expiring';
  if (statuses.includes('not_set'))  return 'incomplete';
  return 'compliant';
}

// ── POST /api/v1/sites/:siteId/coordinator-invites ───────────────────────────
router.post('/sites/:siteId/coordinator-invites', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { coordinator_name, coordinator_email, coordinator_company, ttl_days } = req.body;

  if (!coordinator_name || !String(coordinator_name).trim()) {
    return res.status(400).json({ error: 'coordinator_name obbligatorio' });
  }

  // Verifica ownership cantiere
  const { data: site, error: sErr } = await supabase
    .from('sites').select('id, name, address')
    .eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (sErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const ttl       = Math.min(Math.max(Number(ttl_days) || COORD_TTL_DAYS_DEFAULT, 1), 365);
  const expiresAt = new Date(Date.now() + ttl * 86_400_000).toISOString();
  const rawToken  = generateToken();
  const tokenHash = hashToken(rawToken);

  const { data: invite, error: insertErr } = await supabase
    .from('site_coordinator_invites')
    .insert([{
      company_id:          req.companyId,
      site_id:             siteId,
      token_hash:          tokenHash,
      coordinator_name:    String(coordinator_name).trim().slice(0, 200),
      coordinator_email:   coordinator_email ? String(coordinator_email).trim().slice(0, 200) : null,
      coordinator_company: coordinator_company ? String(coordinator_company).trim().slice(0, 200) : null,
      created_by:          req.user?.id || null,
      expires_at:          expiresAt,
    }])
    .select('id, coordinator_name, coordinator_email, coordinator_company, expires_at')
    .single();

  if (insertErr) return res.status(500).json({ error: 'INVITE_CREATE_ERROR' });

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const url = `${appBase}/coordinator/${rawToken}`;

  // Email al coordinatore se ha fornito l'email
  if (coordinator_email) {
    try {
      await sendCoordinatorInviteEmail({
        to:                  coordinator_email,
        coordinatorName:     invite.coordinator_name,
        siteName:            site.name,
        siteAddress:         site.address || '',
        coordinatorCompany:  invite.coordinator_company || '',
        accessUrl:           url,
        expiresAt:           expiresAt,
      });
    } catch (emailErr) {
      console.warn('[coordinator] email send failed:', emailErr.message);
      // Non blocca — il link è già creato
    }
  }

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'coordinator_invite.create',
    targetType: 'site',
    targetId:   siteId,
    payload:    { coordinator_name: invite.coordinator_name, expires_at: expiresAt, invite_id: invite.id },
    req,
  });

  res.status(201).json({
    ok:         true,
    invite_id:  invite.id,
    url,
    coordinator_name:    invite.coordinator_name,
    coordinator_email:   invite.coordinator_email,
    coordinator_company: invite.coordinator_company,
    expires_at:          invite.expires_at,
    ttl_days:            ttl,
  });
});

// ── GET /api/v1/sites/:siteId/coordinator-invites ────────────────────────────
router.get('/sites/:siteId/coordinator-invites', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { data: invites, error } = await supabase
    .from('site_coordinator_invites')
    .select('id, coordinator_name, coordinator_email, coordinator_company, expires_at, last_accessed_at, access_count, is_active, created_at')
    .eq('site_id', siteId).eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Arricchisci con conteggio note non lette
  const now = new Date();
  const enriched = await Promise.all(invites.map(async (inv) => {
    const { count } = await supabase
      .from('site_coordinator_notes')
      .select('id', { count: 'exact', head: true })
      .eq('invite_id', inv.id).eq('is_read', false);
    return {
      ...inv,
      is_active: inv.is_active && new Date(inv.expires_at) > now,
      unread_notes: count || 0,
    };
  }));

  res.json(enriched);
});

// ── DELETE /api/v1/coordinator-invites/:inviteId ─────────────────────────────
router.delete('/coordinator-invites/:inviteId', verifySupabaseJwt, async (req, res) => {
  const { inviteId } = req.params;

  const { data, error } = await supabase
    .from('site_coordinator_invites')
    .update({ is_active: false })
    .eq('id', inviteId).eq('company_id', req.companyId)
    .select('id, site_id').single();

  if (error || !data) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });

  auditLog({
    companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
    action: 'coordinator_invite.revoke', targetType: 'coordinator_invite',
    targetId: inviteId, payload: { site_id: data.site_id }, req,
  });

  res.json({ ok: true });
});

// ── PATCH /api/v1/coordinator-invites/:inviteId/refresh-token ─────────────
// Genera un nuovo token per un invito esistente (il vecchio URL diventa invalido)
router.patch('/coordinator-invites/:inviteId/refresh-token', verifySupabaseJwt, async (req, res) => {
  const { inviteId } = req.params;

  const { data: invite, error } = await supabase
    .from('site_coordinator_invites')
    .select('id, site_id, coordinator_name, coordinator_email, is_active')
    .eq('id', inviteId).eq('company_id', req.companyId).maybeSingle();

  if (error || !invite) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });

  const rawToken  = generateToken();
  const tokenHash = hashToken(rawToken);

  const { error: updateErr } = await supabase
    .from('site_coordinator_invites')
    .update({ token_hash: tokenHash })
    .eq('id', inviteId).eq('company_id', req.companyId);

  if (updateErr) return res.status(500).json({ error: 'UPDATE_ERROR' });

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const url = `${appBase}/coordinator/${rawToken}`;

  auditLog({
    companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
    action: 'coordinator_invite.refresh_token', targetType: 'coordinator_invite',
    targetId: inviteId, payload: { site_id: invite.site_id }, req,
  });

  res.json({ ok: true, url, coordinator_name: invite.coordinator_name });
});

// ── GET /api/v1/sites/:siteId/coordinator-notes ──────────────────────────────
// Tutte le note ricevute dai coordinatori sul cantiere (lato impresa)
router.get('/sites/:siteId/coordinator-notes', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { data, error } = await supabase
    .from('site_coordinator_notes')
    .select('id, note_type, content, coordinator_name, is_read, created_at, invite_id')
    .eq('site_id', siteId).eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data);
});

// ── PATCH /api/v1/coordinator-notes/:noteId/read ─────────────────────────────
router.patch('/coordinator-notes/:noteId/read', verifySupabaseJwt, async (req, res) => {
  const { noteId } = req.params;

  const { error } = await supabase
    .from('site_coordinator_notes')
    .update({ is_read: true })
    .eq('id', noteId).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT PUBBLICI (accesso tramite token — nessun JWT richiesto)
// ═══════════════════════════════════════════════════════════════════════════════

function validateToken(token) {
  return typeof token === 'string' && token.length === 64 && /^[0-9a-f]+$/i.test(token);
}

async function resolveInvite(token) {
  if (!validateToken(token)) return null;
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();

  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, coordinator_company, expires_at, is_active')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!data) return null;
  if (!data.is_active) return null;
  if (data.expires_at < now) return null;

  // Aggiorna accesso (best-effort)
  supabase.from('site_coordinator_invites').update({
    last_accessed_at: new Date().toISOString(),
    access_count: supabase.raw ? undefined : undefined, // increment via RPC se disponibile
  }).eq('id', data.id).then(() => {});
  // Increment access_count via raw SQL non disponibile in supabase-js v2 senza RPC,
  // ma l'update di last_accessed_at è sufficiente per mostrare "ultimo accesso"
  supabase.rpc('increment_coord_access', { p_invite_id: data.id }).then(null, () => {});

  return data;
}

// ── GET /api/v1/coordinator/:token — dati completi cantiere (READ-ONLY) ───────
router.get('/coordinator/:token', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  // Registra visita (best-effort, non blocca)
  supabase.from('coordinator_visits').insert({
    invite_id:        invite.id,
    company_id:       invite.company_id,
    site_id:          invite.site_id,
    coordinator_name: invite.coordinator_name,
    coordinator_email: invite.coordinator_email || null,
    accessed_via:     'cse',
  }).then(null, () => {});

  // ── Dati cantiere ──────────────────────────────────────────────────────────
  const { data: site } = await supabase
    .from('sites')
    .select('id, name, address, status, client, start_date')
    .eq('id', invite.site_id).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // ── Lavoratori assegnati con compliance ───────────────────────────────────
  const { data: wwRaw } = await supabase
    .from('worksite_workers')
    .select(`
      worker:workers(
        id, full_name, fiscal_code, role, qualification, employer_name,
        subcontracting_auth, safety_training_expiry, health_fitness_expiry, is_active
      )
    `)
    .eq('site_id', invite.site_id)
    .eq('company_id', invite.company_id)
    .eq('status', 'active');

  const workers = (wwRaw || [])
    .filter(r => r.worker && r.worker.is_active)
    .map(r => {
      const w = r.worker;
      const safety = complianceStatus(w.safety_training_expiry);
      const health = complianceStatus(w.health_fitness_expiry);
      return {
        id:                      w.id,
        full_name:               w.full_name,
        fiscal_code:             w.fiscal_code,
        role:                    w.role || null,
        qualification:           w.qualification || null,
        employer_name:           w.employer_name || null,
        subcontracting_auth:     w.subcontracting_auth || false,
        safety_training_expiry:  w.safety_training_expiry || null,
        health_fitness_expiry:   w.health_fitness_expiry || null,
        compliance: {
          safety,
          health,
          overall: overallCompliance(safety, health),
        },
      };
    })
    .sort((a, b) => {
      // Non conformi prima, poi scadenze vicine, poi conformi
      const order = { non_compliant: 0, expiring: 1, incomplete: 2, compliant: 3 };
      return (order[a.compliance.overall] ?? 9) - (order[b.compliance.overall] ?? 9);
    });

  // ── Riepilogo presenze ultimi 7 giorni ────────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const { data: presenceLogs } = await supabase
    .from('presence_logs')
    .select('id, event_type, timestamp_server, worker_id')
    .eq('site_id', invite.site_id)
    .eq('company_id', invite.company_id)
    .gte('timestamp_server', sevenDaysAgo + 'T00:00:00.000Z')
    .lte('timestamp_server', today + 'T23:59:59.999Z')
    .order('timestamp_server', { ascending: false })
    .limit(500);

  // Raggruppa per giorno
  const dayMap = new Map();
  for (const log of (presenceLogs || [])) {
    const day = log.timestamp_server.split('T')[0];
    if (!dayMap.has(day)) dayMap.set(day, { entries: 0, exits: 0, workers: new Set() });
    const d = dayMap.get(day);
    if (log.event_type === 'ENTRY') d.entries++;
    else d.exits++;
    if (log.worker_id) d.workers.add(log.worker_id);
  }

  const recentDays = Array.from(dayMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, d]) => ({
      date,
      worker_count:   d.workers.size,
      entries:        d.entries,
      exits:          d.exits,
      anomalies:      d.entries - d.exits > 0 ? d.entries - d.exits : 0,
    }));

  const presenceSummary = {
    period_days:          7,
    total_entries:        (presenceLogs || []).filter(l => l.event_type === 'ENTRY').length,
    days_with_presence:   dayMap.size,
    recent_days:          recentDays,
  };

  // ── Note + Non Conformità + Storico visite (in parallelo) ──────────────────
  const [notesRes, ncRes, visitsRes] = await Promise.all([
    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, coordinator_name, created_at')
      .eq('site_id', invite.site_id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('site_nonconformities')
      .select('id, title, category, severity, status, due_date, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('coordinator_visits')
      .select('id, accessed_via, visited_at')
      .eq('invite_id', invite.id)
      .order('visited_at', { ascending: false })
      .limit(20),
  ]);

  // ── Compila stats globali compliance ──────────────────────────────────────
  const complianceStats = workers.reduce((acc, w) => {
    acc[w.compliance.overall] = (acc[w.compliance.overall] || 0) + 1;
    return acc;
  }, {});

  const ncList    = ncRes.data    || [];
  const openNcCount = ncList.filter(n => n.status === 'aperta' || n.status === 'in_lavorazione').length;

  res.json({
    site,
    invite: {
      coordinator_name:    invite.coordinator_name,
      coordinator_company: invite.coordinator_company || null,
      expires_at:          invite.expires_at,
    },
    workers,
    workers_count:    workers.length,
    compliance_stats: complianceStats,
    presence_summary: presenceSummary,
    notes:            notesRes.data  || [],
    nonconformities:  ncList,
    open_nc_count:    openNcCount,
    visits:           visitsRes.data || [],
  });
});

// ── GET /api/v1/coordinator/:token/notes ─────────────────────────────────────
router.get('/coordinator/:token/notes', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('site_coordinator_notes')
    .select('id, note_type, content, coordinator_name, created_at')
    .eq('site_id', invite.site_id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data);
});

// ── POST /api/v1/coordinator/:token/notes ────────────────────────────────────
router.post('/coordinator/:token/notes', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { note_type, content } = req.body;
  const VALID_TYPES = ['observation', 'request', 'approval', 'warning'];

  if (!content || !String(content).trim() || String(content).trim().length < 3) {
    return res.status(400).json({ error: 'content troppo corto (min 3 caratteri)' });
  }
  if (note_type && !VALID_TYPES.includes(note_type)) {
    return res.status(400).json({ error: `note_type non valido. Valori: ${VALID_TYPES.join(', ')}` });
  }

  const { data: note, error: insertErr } = await supabase
    .from('site_coordinator_notes')
    .insert([{
      company_id:       invite.company_id,
      site_id:          invite.site_id,
      invite_id:        invite.id,
      note_type:        note_type || 'observation',
      content:          String(content).trim().slice(0, 2000),
      coordinator_name: invite.coordinator_name,
    }])
    .select('id, note_type, content, coordinator_name, created_at')
    .single();

  if (insertErr) return res.status(500).json({ error: 'NOTE_INSERT_ERROR' });

  // Email notifica all'impresa (best-effort, non blocca)
  try {
    const { data: site } = await supabase
      .from('sites').select('name').eq('id', invite.site_id).maybeSingle();

    await sendCoordinatorNoteAlert({
      companyId:       invite.company_id,
      siteName:        site?.name || 'Cantiere',
      coordinatorName: invite.coordinator_name,
      noteType:        note.note_type,
      content:         note.content,
      siteUrl:         `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/cantieri/${invite.site_id}`,
    });
  } catch (emailErr) {
    console.warn('[coordinator] note alert email failed:', emailErr.message);
  }

  res.status(201).json({ ok: true, note });
});

module.exports = router;
