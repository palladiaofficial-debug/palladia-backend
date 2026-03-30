'use strict';
/**
 * routes/v1/nonconformities.js
 * Non Conformità — rilievi formali aperti dai coordinatori sui cantieri.
 *
 * Endpoint pubblici (token nel path — no JWT):
 *   POST   /api/v1/coordinator/:token/nonconformities                  — CSE apre NC
 *   GET    /api/v1/coordinator/:token/nonconformities                  — CSE vede sue NC
 *   PATCH  /api/v1/coordinator/:token/nonconformities/:id/close        — CSE chiude NC
 *   POST   /api/v1/coordinator/pro/:token/site/:siteId/nonconformities — Pro apre NC
 *   GET    /api/v1/coordinator/pro/:token/site/:siteId/nonconformities — Pro vede NC sito
 *   PATCH  /api/v1/coordinator/pro/:token/nonconformities/:id/close    — Pro chiude NC
 *
 * Endpoint privati (JWT + X-Company-Id):
 *   GET    /api/v1/sites/:siteId/nonconformities        — impresa vede tutte le NC
 *   PATCH  /api/v1/nonconformities/:id                  — impresa aggiorna stato/risposta
 */

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');
const { coordinatorLimiter } = require('../../middleware/rateLimit');
const {
  sendNonconformityAlert,
  sendNonconformityUpdate,
} = require('../../services/email');

// ── helpers ───────────────────────────────────────────────────────────────────

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}
function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}

const VALID_CATEGORIES = ['sicurezza', 'documentale', 'operativa', 'igiene'];
const VALID_SEVERITIES = ['bassa', 'media', 'alta', 'critica'];

/**
 * Risolve un invite CSE dal token raw.
 * Ritorna { invite, site } oppure null.
 */
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

/**
 * Risolve una sessione Pro dal token.
 */
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

/**
 * Verifica che una sessione Pro abbia accesso a un siteId specifico.
 */
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

// ── POST /api/v1/coordinator/:token/nonconformities ───────────────────────────
// CSE apre una non conformità su un cantiere
router.post('/coordinator/:token/nonconformities', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { title, description, category, severity, due_date } = req.body || {};

  if (!title || String(title).trim().length < 3) {
    return res.status(400).json({ error: 'TITLE_REQUIRED', message: 'Titolo: minimo 3 caratteri.' });
  }
  if (!description || String(description).trim().length < 3) {
    return res.status(400).json({ error: 'DESCRIPTION_REQUIRED', message: 'Descrizione: minimo 3 caratteri.' });
  }

  const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'sicurezza';
  const safeSeverity = VALID_SEVERITIES.includes(severity) ? severity : 'media';
  const safeDueDate  = due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;

  const { data: nc, error } = await supabase
    .from('site_nonconformities')
    .insert({
      company_id:       invite.company_id,
      site_id:          invite.site_id,
      invite_id:        invite.id,
      coordinator_name: invite.coordinator_name,
      title:            String(title).trim().slice(0, 300),
      description:      String(description).trim().slice(0, 3000),
      category:         safeCategory,
      severity:         safeSeverity,
      due_date:         safeDueDate,
    })
    .select()
    .single();

  if (error) {
    console.error('[nc] insert error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  // Notifica email agli admin (best-effort)
  const { data: site } = await supabase
    .from('sites').select('name, address').eq('id', invite.site_id).maybeSingle();
  sendNonconformityAlert({
    companyId:       invite.company_id,
    siteName:        site?.name || site?.address || 'Cantiere',
    coordinatorName: invite.coordinator_name,
    severity:        safeSeverity,
    category:        safeCategory,
    title:           String(title).trim().slice(0, 300),
    siteUrl:         `${process.env.FRONTEND_URL || 'http://localhost:5173'}/cantieri/${invite.site_id}`,
  }).catch(e => console.error('[nc] email error:', e.message));

  res.status(201).json({ ok: true, nonconformity: nc });
});

// ── GET /api/v1/coordinator/:token/nonconformities ────────────────────────────
// CSE vede le NC che ha aperto su quel cantiere
router.get('/coordinator/:token/nonconformities', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('site_nonconformities')
    .select('id, title, description, category, severity, status, due_date, resolution_notes, resolved_at, closed_by_coordinator_at, created_at')
    .eq('invite_id', invite.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── PATCH /api/v1/coordinator/:token/nonconformities/:id/close ────────────────
// CSE chiude (o riapre) una NC — dopo che l'impresa l'ha risolta
router.patch('/coordinator/:token/nonconformities/:id/close', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { action } = req.body || {}; // 'close' | 'reopen'

  const { data: nc } = await supabase
    .from('site_nonconformities')
    .select('id, status, site_id')
    .eq('id', req.params.id)
    .eq('invite_id', invite.id)
    .maybeSingle();

  if (!nc) return res.status(404).json({ error: 'NOT_FOUND' });

  let updates;
  if (action === 'reopen') {
    updates = { status: 'aperta', closed_by_coordinator_at: null };
  } else {
    if (nc.status !== 'risolta') {
      return res.status(400).json({ error: 'CANNOT_CLOSE', message: 'Puoi chiudere solo NC già risolte dall\'impresa.' });
    }
    updates = { status: 'chiusa', closed_by_coordinator_at: new Date().toISOString() };
  }

  const { error } = await supabase
    .from('site_nonconformities')
    .update(updates)
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, status: updates.status });
});

// ── POST /api/v1/coordinator/pro/:token/site/:siteId/nonconformities ──────────
// Pro apre NC su un cantiere
router.post('/coordinator/pro/:token/site/:siteId/nonconformities', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { title, description, category, severity, due_date } = req.body || {};

  if (!title || String(title).trim().length < 3) {
    return res.status(400).json({ error: 'TITLE_REQUIRED' });
  }
  if (!description || String(description).trim().length < 3) {
    return res.status(400).json({ error: 'DESCRIPTION_REQUIRED' });
  }

  const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'sicurezza';
  const safeSeverity = VALID_SEVERITIES.includes(severity) ? severity : 'media';
  const safeDueDate  = due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;

  const { data: nc, error } = await supabase
    .from('site_nonconformities')
    .insert({
      company_id:       invite.company_id,
      site_id:          invite.site_id,
      invite_id:        invite.id,
      coordinator_name: invite.coordinator_name,
      title:            String(title).trim().slice(0, 300),
      description:      String(description).trim().slice(0, 3000),
      category:         safeCategory,
      severity:         safeSeverity,
      due_date:         safeDueDate,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const { data: site } = await supabase
    .from('sites').select('name, address').eq('id', invite.site_id).maybeSingle();
  sendNonconformityAlert({
    companyId:       invite.company_id,
    siteName:        site?.name || site?.address || 'Cantiere',
    coordinatorName: invite.coordinator_name,
    severity:        safeSeverity,
    category:        safeCategory,
    title:           String(title).trim().slice(0, 300),
    siteUrl:         `${process.env.FRONTEND_URL || 'http://localhost:5173'}/cantieri/${invite.site_id}`,
  }).catch(e => console.error('[nc] email error:', e.message));

  res.status(201).json({ ok: true, nonconformity: nc });
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/nonconformities ───────────
// Pro vede NC di un sito specifico
router.get('/coordinator/pro/:token/site/:siteId/nonconformities', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data, error } = await supabase
    .from('site_nonconformities')
    .select('id, title, description, category, severity, status, due_date, resolution_notes, resolved_at, closed_by_coordinator_at, created_at')
    .eq('site_id', req.params.siteId)
    .eq('invite_id', invite.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── PATCH /api/v1/coordinator/pro/:token/nonconformities/:id/close ────────────
// Pro chiude una NC
router.patch('/coordinator/pro/:token/nonconformities/:id/close', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  // Verifica ownership (NC deve appartenere a un invito per cui questo pro ha accesso)
  const { data: nc } = await supabase
    .from('site_nonconformities')
    .select('id, status, site_id, invite_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!nc) return res.status(404).json({ error: 'NOT_FOUND' });

  // Verifica accesso al sito
  const invite = await resolveProInviteForSite(session.email, nc.site_id);
  if (!invite || invite.id !== nc.invite_id) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { action } = req.body || {};
  let updates;
  if (action === 'reopen') {
    updates = { status: 'aperta', closed_by_coordinator_at: null };
  } else {
    if (nc.status !== 'risolta') {
      return res.status(400).json({ error: 'CANNOT_CLOSE', message: 'Puoi chiudere solo NC già risolte dall\'impresa.' });
    }
    updates = { status: 'chiusa', closed_by_coordinator_at: new Date().toISOString() };
  }

  const { error } = await supabase
    .from('site_nonconformities')
    .update(updates)
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, status: updates.status });
});

// ── GET /api/v1/sites/:siteId/nonconformities ─────────────────────────────────
// Impresa: vede tutte le NC di un cantiere
router.get('/sites/:siteId/nonconformities', verifySupabaseJwt, async (req, res) => {
  const { status } = req.query; // optional filter: 'aperta'|'in_lavorazione'|'risolta'|'chiusa'

  let query = supabase
    .from('site_nonconformities')
    .select('id, invite_id, coordinator_name, title, description, category, severity, status, due_date, resolution_notes, resolved_at, closed_by_coordinator_at, created_at')
    .eq('site_id', req.params.siteId)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (status && ['aperta', 'in_lavorazione', 'risolta', 'chiusa'].includes(status)) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── PATCH /api/v1/nonconformities/:id ─────────────────────────────────────────
// Impresa: aggiorna stato e/o aggiunge note di risoluzione
router.patch('/nonconformities/:id', verifySupabaseJwt, async (req, res) => {
  const { status, resolution_notes } = req.body || {};

  const COMPANY_STATUSES = ['in_lavorazione', 'risolta'];
  if (status && !COMPANY_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'INVALID_STATUS',
      message: `L'impresa può impostare: ${COMPANY_STATUSES.join(', ')}.`,
    });
  }

  // Fetch NC e verifica ownership
  const { data: nc } = await supabase
    .from('site_nonconformities')
    .select('id, title, status, invite_id, site_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!nc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (nc.status === 'chiusa') {
    return res.status(400).json({ error: 'ALREADY_CLOSED', message: 'La NC è già chiusa dal coordinatore.' });
  }

  const updates = {};
  if (status)            updates.status           = status;
  if (resolution_notes)  updates.resolution_notes = String(resolution_notes).trim().slice(0, 3000);
  if (status === 'risolta') updates.resolved_at   = new Date().toISOString();

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS' });
  }

  const { error } = await supabase
    .from('site_nonconformities')
    .update(updates)
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Se l'impresa segna come risolta → notifica email al coordinatore
  if (status === 'risolta') {
    const { data: invite } = await supabase
      .from('site_coordinator_invites')
      .select('coordinator_email, coordinator_name')
      .eq('id', nc.invite_id)
      .maybeSingle();

    if (invite?.coordinator_email) {
      const { data: site } = await supabase
        .from('sites').select('name, address').eq('id', nc.site_id).maybeSingle();
      sendNonconformityUpdate({
        to:              invite.coordinator_email,
        coordinatorName: invite.coordinator_name,
        siteName:        site?.name || site?.address || 'Cantiere',
        ncTitle:         nc.title || '(senza titolo)',
        newStatus:       'risolta',
        resolutionNotes: updates.resolution_notes || '',
        accessUrl:       `${process.env.FRONTEND_URL || 'http://localhost:5173'}`,
      }).catch(e => console.error('[nc] notify coordinator error:', e.message));
    }
  }

  res.json({ ok: true, updates });
});

// ── GET /api/v1/sites/:siteId/coordinator-visits ──────────────────────────────
// Impresa: storico visite coordinatori su un cantiere
router.get('/sites/:siteId/coordinator-visits', verifySupabaseJwt, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  const { data, error } = await supabase
    .from('coordinator_visits')
    .select('id, coordinator_name, coordinator_email, accessed_via, visited_at')
    .eq('site_id', req.params.siteId)
    .eq('company_id', req.companyId)
    .order('visited_at', { ascending: false })
    .range(off, off + lim - 1);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/visits ────────────────────
// Pro: storico delle proprie visite a un cantiere
router.get('/coordinator/pro/:token/site/:siteId/visits', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data, error } = await supabase
    .from('coordinator_visits')
    .select('id, accessed_via, visited_at')
    .eq('invite_id', invite.id)
    .order('visited_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

module.exports = router;
