'use strict';
const { logStudioAction } = require('../../lib/studioAudit');
const { pairLogsByDay, shiftDateStr } = require('../../lib/presencePairing');
/**
 * routes/v1/studio.js
 * Portale Studio CDL Partner — Consulenti del Lavoro che gestiscono N imprese clienti.
 *
 * Il CDL è il data controller. Le imprese non devono essere su Palladia.
 *
 * ── Profilo studio ──────────────────────────────────────────────────────────
 * POST /api/v1/studio/onboard
 * GET  /api/v1/studio/me
 * PUT  /api/v1/studio/me
 *
 * ── Gestione clienti ────────────────────────────────────────────────────────
 * GET  /api/v1/studio/clients                             lista (attivi + pending)
 * POST /api/v1/studio/clients/create-direct              CDL crea impresa cliente direttamente
 * POST /api/v1/studio/clients/invite                      invita impresa esistente su Palladia
 * POST /api/v1/studio/clients/accept/:token               impresa Palladia accetta invito
 * POST /api/v1/studio/pending-invites/accept/:token       nuova impresa accetta pending invite
 * GET  /api/v1/studio/clients/:companyId                  dettaglio impresa
 * PUT  /api/v1/studio/clients/:companyId/profile          aggiorna profilo impresa (CDL-owned)
 * DELETE /api/v1/studio/clients/:companyId                rimuovi relazione
 *
 * ── Gestione lavoratori (CDL-owned) ────────────────────────────────────────
 * GET    /api/v1/studio/clients/:companyId/workers
 * POST   /api/v1/studio/clients/:companyId/workers
 * PUT    /api/v1/studio/clients/:companyId/workers/:workerId
 * DELETE /api/v1/studio/clients/:companyId/workers/:workerId
 *
 * ── Gestione certificati (CDL-owned) ───────────────────────────────────────
 * GET    /api/v1/studio/clients/:companyId/certificates
 * POST   /api/v1/studio/clients/:companyId/certificates
 * PUT    /api/v1/studio/clients/:companyId/certificates/:certId
 * DELETE /api/v1/studio/clients/:companyId/certificates/:certId
 *
 * ── Import e report ─────────────────────────────────────────────────────────
 * POST /api/v1/studio/clients/:companyId/import-csv       import CSV lavoratori + certificati
 * GET  /api/v1/studio/clients/:companyId/lettera-scadenze.pdf  lettera formale CDL all'impresa
 * GET  /api/v1/studio/clients/:companyId/report-vigilanza.pdf  report per ispezioni
 *
 * ── Dashboard e digest ──────────────────────────────────────────────────────
 * GET  /api/v1/studio/dashboard
 * POST /api/v1/studio/digest/send-now
 */

const router   = require('express').Router();
const crypto   = require('crypto');
const supabase = require('../../lib/supabase');
const { verifyStudioJwt, verifyStudioOrCreate } = require('../../middleware/verifyStudio');
const {
  sendStudioInviteEmail,
  sendStudioPendingInviteEmail,
} = require('../../services/email');
const { rendererPool } = require('../../pdf-renderer');
const { validate } = require('../../middleware/validate');
const {
  onboardSchema,
  putStudioMeSchema,
  inviteClientSchema,
  createDirectClientSchema,
  putClientProfileSchema,
  createWorkerSchema,
  putWorkerSchema,
  putSorveglianzaSchema,
  putComplianceSchema,
  createCertificateSchema,
  putCertificateSchema,
  importCsvSchema,
  createSafetyRoleSchema,
  createDocumentRequestSchema,
  reviewDocumentRequestSchema,
  uploadDocumentSchema,
  claimCompanySchema,
  inviteTeamMemberSchema,
  patchTeamRoleSchema,
} = require('../../lib/schemas/studio');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verifica che lo studio abbia accesso all'impresa.
 * Se requireOwnership=true, verifica che lo studio sia anche il data controller.
 */
async function checkStudioAccess(studioId, companyId, requireOwnership = false) {
  const { data, error } = await supabase
    .from('studio_clients')
    .select('id, owned_by_studio')
    .eq('studio_id', studioId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, status: 403, error: 'Azienda non associata a questo studio' };
  }
  if (requireOwnership && !data.owned_by_studio) {
    return { ok: false, status: 403, error: 'Questa azienda è gestita autonomamente — il CDL non può modificare i dati direttamente' };
  }
  return { ok: true, isOwner: !!data.owned_by_studio };
}

const ALERT_DEFAULTS = {
  cert_expiry:   { warn: 60, critical: 30 },
  health_expiry: { warn: 60, critical: 30 },
  durc_expiry:   { warn: 90, critical: 30 },
  dvr_age:       { warn: 365, critical: 365 },
  riunione:      { warn: 365, critical: 365 },
  safety_role:   { warn: 60, critical: 30 },
};

async function getAlertThresholds(studioId) {
  const { data } = await supabase
    .from('studio_alert_config')
    .select('alert_type, warn_days, critical_days, enabled')
    .eq('studio_id', studioId);
  const cfg = {};
  for (const [type, defaults] of Object.entries(ALERT_DEFAULTS)) {
    const row = (data || []).find(r => r.alert_type === type);
    cfg[type] = {
      warn:     row?.warn_days     ?? defaults.warn,
      critical: row?.critical_days ?? defaults.critical,
      enabled:  row?.enabled       ?? true,
    };
  }
  return cfg;
}

async function filterClientsByCollaborator(studioId, userId, studioRole, companyIds) {
  if (studioRole === 'owner' || studioRole === 'admin') return companyIds;
  const { data } = await supabase
    .from('studio_user_clients')
    .select('company_id')
    .eq('studio_id', studioId)
    .eq('user_id', userId);
  if (!data?.length) return companyIds;
  const assigned = new Set(data.map(r => r.company_id));
  return companyIds.filter(id => assigned.has(id));
}

/**
 * Trova o crea un course_type per nome (case-insensitive match sul nome esatto,
 * poi fallback a INSERT ... ON CONFLICT DO NOTHING).
 * Restituisce l'id del course_type.
 */
async function resolveOrCreateCourseType(name) {
  const trimmed = name.trim();
  const { data: existing } = await supabase
    .from('course_types')
    .select('id')
    .ilike('name', trimmed)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created } = await supabase
    .from('course_types')
    .insert({
      name:            trimmed,
      legal_reference: 'D.Lgs 81/2008',
      validity_years:  5,
      renewal_hours:   0,
    })
    .select('id')
    .single();
  return created?.id || null;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

router.post('/studio/onboard', verifyStudioOrCreate, validate(onboardSchema), async (req, res) => {
  const {
    studio_name, vat_number, registration_number,
    operative_regions, bio, logo_url, edil_connect_code,
  } = req.body || {};

  if (!studio_name?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'studio_name obbligatorio' });
  }

  const { data: studio, error: sErr } = await supabase
    .from('studio_partners')
    .upsert({
      user_id:              req.user.id,
      studio_name:          studio_name.trim(),
      vat_number:           vat_number?.trim()          || null,
      registration_number:  registration_number?.trim() || null,
      operative_regions:    operative_regions           || [],
      bio:                  bio?.trim()                 || null,
      logo_url:             logo_url                    || null,
      edil_connect_code:    edil_connect_code?.trim()   || null,
      onboarding_completed: true,
    }, { onConflict: 'user_id' })
    .select()
    .single();

  if (sErr) return res.status(500).json({ error: sErr.message });

  // Garantisce record studio_users come owner
  await supabase.from('studio_users').upsert({
    studio_id: studio.id,
    user_id:   req.user.id,
    role:      'owner',
    joined_at: new Date().toISOString(),
  }, { onConflict: 'studio_id,user_id' });

  res.json({ studio });
});

// ── Profilo ───────────────────────────────────────────────────────────────────

router.get('/studio/me', verifyStudioOrCreate, async (req, res) => {
  res.json({ studio: req.studio });
});

router.put('/studio/me', verifyStudioJwt, validate(putStudioMeSchema), async (req, res) => {
  const allowed = ['studio_name','vat_number','registration_number','operative_regions','bio','logo_url','edil_connect_code'];
  const update  = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

  const { data, error } = await supabase
    .from('studio_partners')
    .update(update)
    .eq('id', req.studioId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ studio: data });
});

// ── Clienti ───────────────────────────────────────────────────────────────────

router.get('/studio/clients', verifyStudioJwt, async (req, res) => {
  const [
    { data: clients, error },
    { data: pending },
  ] = await Promise.all([
    supabase.from('studio_clients').select('*, companies(id, name)').eq('studio_id', req.studioId).order('created_at', { ascending: false }),
    supabase.from('studio_pending_invites').select('*').eq('studio_id', req.studioId).eq('status', 'pending').order('created_at', { ascending: false }),
  ]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: clients || [], pending_invites: pending || [] });
});

/**
 * Invita un'impresa per P.IVA + email (nuovo flusso) o per company_id (legacy).
 *
 * Caso A — impresa già su Palladia (trovata per piva o company_id):
 *   - crea studio_clients pending, invia email all'owner Palladia
 *
 * Caso B — impresa non ancora su Palladia (solo email fornita):
 *   - crea studio_pending_invites, invia email "registrati su Palladia"
 *   - quando l'impresa si registra e accetta il token, la relazione si attiva
 */
router.post('/studio/clients/invite', verifyStudioJwt, validate(inviteClientSchema), async (req, res) => {
  const {
    company_id,     // legacy — UUID diretto
    vat_number,     // P.IVA — cerca per corrispondenza
    contact_email,  // email del titolare/contatto
    contact_name,   // nome del contatto (opzionale)
    company_name,   // nome azienda (opzionale, per pending invite)
  } = req.body || {};

  const APP_BASE_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

  // ── Risolvi company da P.IVA o UUID ────────────────────────────────────────
  let company = null;

  if (company_id) {
    const { data } = await supabase.from('companies').select('id, name').eq('id', company_id).maybeSingle();
    company = data;
  } else if (vat_number?.trim()) {
    const normalizedVat = vat_number.trim().toUpperCase().replace(/\s/g, '');
    const { data } = await supabase.from('companies').select('id, name').eq('piva', normalizedVat).maybeSingle();
    company = data;
  }

  // ── CASO A: impresa già su Palladia ────────────────────────────────────────
  if (company) {
    const { data: existing } = await supabase
      .from('studio_clients')
      .select('id, status')
      .eq('studio_id', req.studioId)
      .eq('company_id', company.id)
      .maybeSingle();

    if (existing?.status === 'active') {
      return res.status(409).json({ error: 'ALREADY_ACTIVE', message: 'Questa azienda è già un cliente attivo del tuo studio.' });
    }

    const invite_token = crypto.randomBytes(24).toString('hex');

    const { data, error } = await supabase
      .from('studio_clients')
      .upsert({
        studio_id:      req.studioId,
        company_id:     company.id,
        status:         'pending',
        invited_by:     req.user.id,
        invite_token,
        invite_sent_at: new Date().toISOString(),
      }, { onConflict: 'studio_id,company_id' })
      .select('*, companies(id, name)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const accept_url = `${APP_BASE_URL}/studio/accetta/${invite_token}`;

    // Trova l'email dell'owner e invia (fire-and-forget)
    supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', company.id)
      .eq('role', 'owner')
      .maybeSingle()
      .then(async ({ data: owner }) => {
        const recipientEmail = contact_email?.trim() || null;
        let ownerEmail = null;
        if (owner?.user_id) {
          const { data: { user } } = await supabase.auth.admin.getUserById(owner.user_id);
          ownerEmail = user?.email || null;
        }
        const to = ownerEmail || recipientEmail;
        if (!to) return;
        await sendStudioInviteEmail({ to, studioName: req.studio.studio_name, acceptUrl: accept_url });
      })
      .catch(err => console.error('[studio] sendStudioInviteEmail:', err.message));

    return res.json({
      type:         'palladia_invite',
      client:       data,
      company_name: company.name,
      invite_token,
      accept_url,
    });
  }

  // ── CASO B: impresa non ancora su Palladia — pending invite ────────────────
  if (!contact_email?.trim()) {
    return res.status(400).json({
      error:   'MISSING_CONTACT',
      message: 'Inserisci P.IVA (se l\'impresa è già su Palladia) oppure email di contatto per inviare un invito.',
    });
  }

  const email = contact_email.trim().toLowerCase();

  // Controlla se esiste già un pending invite attivo per questa email + studio
  const { data: existingPending } = await supabase
    .from('studio_pending_invites')
    .select('id, invite_token, status')
    .eq('studio_id', req.studioId)
    .eq('contact_email', email)
    .maybeSingle();

  if (existingPending?.status === 'accepted') {
    return res.status(409).json({ error: 'ALREADY_ACCEPTED', message: 'Questa email ha già accettato l\'invito.' });
  }

  const invite_token = crypto.randomBytes(24).toString('hex');

  const { data: pendingInvite, error: piErr } = await supabase
    .from('studio_pending_invites')
    .upsert({
      studio_id:     req.studioId,
      contact_email: email,
      contact_name:  contact_name?.trim() || null,
      company_name:  company_name?.trim() || null,
      vat_number:    vat_number?.trim()   || null,
      invite_token,
      status:        'pending',
      invited_by:    req.user.id,
    }, { onConflict: 'studio_id,contact_email' })
    .select()
    .single();

  if (piErr) return res.status(500).json({ error: piErr.message });

  const accept_url = `${APP_BASE_URL}/studio/accetta/${invite_token}`;

  // Invia email di onboarding (fire-and-forget)
  sendStudioPendingInviteEmail({
    to:              email,
    studioName:      req.studio.studio_name,
    companyNameHint: company_name?.trim() || null,
    acceptUrl:       accept_url,
    registerUrl:     APP_BASE_URL,
  }).catch(err => console.error('[studio] sendStudioPendingInviteEmail:', err.message));

  return res.json({
    type:         'pending_invite',
    pending:      pendingInvite,
    contact_email: email,
    invite_token,
    accept_url,
    message:      `Invito inviato a ${email}. Riceveranno un link per registrarsi su Palladia e collegarsi al tuo studio.`,
  });
});

// Accetta un pending invite (impresa appena registrata su Palladia).
// Il token viene dalla email "pending invite" — l'impresa si è registrata, ora collega l'azienda.
router.post('/studio/pending-invites/accept/:token', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { token } = req.params;

  const { data: pending } = await supabase
    .from('studio_pending_invites')
    .select('*, studio_partners(id, studio_name)')
    .eq('invite_token', token)
    .maybeSingle();

  if (!pending) return res.status(404).json({ error: 'Invito non trovato o non valido' });
  if (pending.status === 'accepted') {
    return res.status(409).json({ error: 'ALREADY_ACCEPTED', studio_name: pending.studio_partners?.studio_name });
  }

  // L'utente deve essere owner/admin di almeno un'azienda
  const { data: membership } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', user.id)
    .in('role', ['owner', 'admin'])
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({
      error:   'NO_COMPANY',
      message: 'Prima crea un\'azienda su Palladia, poi torna su questo link per completare il collegamento.',
    });
  }

  const studioId    = pending.studio_id;
  const companyId   = membership.company_id;
  const studioName  = pending.studio_partners?.studio_name;

  // Crea relazione studio_clients
  const invite_token_sc = crypto.randomBytes(24).toString('hex');
  const { data: relation, error: rErr } = await supabase
    .from('studio_clients')
    .upsert({
      studio_id:      studioId,
      company_id:     companyId,
      status:         'active',
      invited_by:     pending.invited_by,
      invite_token:   invite_token_sc,
      accepted_at:    new Date().toISOString(),
    }, { onConflict: 'studio_id,company_id' })
    .select()
    .single();

  if (rErr) return res.status(500).json({ error: rErr.message });

  // Marca il pending invite come accettato
  await supabase
    .from('studio_pending_invites')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', pending.id);

  res.json({ ok: true, studio_name: studioName, client: relation });
});

// Impresa accetta l'invito dello studio — NON richiede X-Company-Id.
// Verifica server-side che il JWT appartenga a un membro dell'impresa invitata.
router.post('/studio/clients/accept/:token', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { token } = req.params;

  const { data: relation, error: relErr } = await supabase
    .from('studio_clients')
    .select('*, studio_partners(id, studio_name)')
    .eq('invite_token', token)
    .maybeSingle();

  if (relErr || !relation) {
    return res.status(404).json({ error: 'Invito non trovato o non valido' });
  }

  // Verifica che l'utente sia owner/admin dell'impresa invitata
  const { data: membership } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', relation.company_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({ error: 'Non sei membro di questa azienda' });
  }
  if (!['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: 'Solo owner o admin possono accettare inviti' });
  }
  if (relation.status === 'active') {
    return res.status(409).json({ error: 'Relazione già attiva', studio_name: relation.studio_partners?.studio_name });
  }

  const { data, error } = await supabase
    .from('studio_clients')
    .update({ status: 'active', accepted_at: new Date().toISOString() })
    .eq('id', relation.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, studio_name: relation.studio_partners?.studio_name, client: data });
});

// Dettaglio impresa cliente
router.get('/studio/clients/:companyId', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;

  const { data: relation } = await supabase
    .from('studio_clients')
    .select('*, owned_by_studio')
    .eq('studio_id', req.studioId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();

  if (!relation) return res.status(403).json({ error: 'Azienda non associata a questo studio' });

  const [
    { data: company },
    { data: sites },
    { data: workers },
    { data: dvrs },
    { data: subcontractors },
    { data: certs },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, status, address').eq('company_id', companyId).order('created_at', { ascending: false }),
    supabase.from('workers').select('id, full_name, fiscal_code, is_active').eq('company_id', companyId).eq('is_active', true).limit(200),
    supabase.from('dvr_documents').select('id, revision, dvr_data, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(5),
    supabase.from('subcontractors').select('id, company_name, status').eq('company_id', companyId),
    supabase.from('worker_certificates').select('id, worker_id, expiry_date, course_types(name)').eq('company_id', companyId).order('expiry_date', { ascending: true }).limit(100),
  ]);

  res.json({
    company,
    owned_by_studio: !!relation.owned_by_studio,
    sites:          sites          || [],
    workers:        workers        || [],
    dvrs:           dvrs           || [],
    subcontractors: subcontractors || [],
    certificates:   certs          || [],
  });
});

// ── Report Vigilanza PDF ──────────────────────────────────────────────────────
// Genera un PDF di conformità dell'impresa per ispezioni INAIL/ASL/Ispettorato.
router.get('/studio/clients/:companyId/report-vigilanza.pdf', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;

  const { data: relation } = await supabase
    .from('studio_clients')
    .select('*')
    .eq('studio_id', req.studioId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();

  if (!relation) return res.status(403).json({ error: 'Azienda non associata a questo studio' });

  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const todayStr   = now.toISOString().slice(0, 10);
  const in30Str    = in30.toISOString().slice(0, 10);

  const [
    { data: company },
    { data: sites },
    { data: workers },
    { data: dvrs },
    { data: subcontractors },
    { data: certs },
    { data: subDocs },
    { data: ssorvExpired },
    { data: ssorvSoon },
    { data: compData },
    { data: safetyRoles },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, status, address').eq('company_id', companyId).neq('status', 'chiuso').order('created_at', { ascending: false }),
    supabase.from('workers').select('id, full_name, fiscal_code, is_active').eq('company_id', companyId).eq('is_active', true).limit(300),
    supabase.from('dvr_documents').select('id, revision, dvr_data, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(5),
    supabase.from('subcontractors').select('id, company_name, status, piva').eq('company_id', companyId),
    supabase.from('worker_certificates').select('id, worker_id, expiry_date, course_types(name), workers(full_name)').eq('company_id', companyId).is('deleted_at', null).order('expiry_date', { ascending: true }).limit(200),
    supabase.from('subcontractor_documents').select('id, company_id, doc_type, valid_until').eq('company_id', companyId).limit(50),
    supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true).not('health_fitness_expiry', 'is', null).lt('health_fitness_expiry', todayStr),
    supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true).not('health_fitness_expiry', 'is', null).gte('health_fitness_expiry', todayStr).lt('health_fitness_expiry', in30Str),
    supabase.from('companies').select('durc_expiry_date, last_safety_meeting_at').eq('id', companyId).maybeSingle(),
    supabase.from('company_safety_roles').select('role_type').eq('company_id', companyId),
  ]);

  const expiredCerts = (certs || []).filter(c => c.expiry_date && new Date(c.expiry_date) < now);
  const soonCerts    = (certs || []).filter(c => c.expiry_date && new Date(c.expiry_date) >= now && new Date(c.expiry_date) < in30);
  const latestDvr    = dvrs?.[0] || null;
  const dvrAge       = latestDvr ? Math.floor((now - new Date(latestDvr.created_at)) / 86_400_000) : null;

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function semColor(s) { return { verde: '#10b981', giallo: '#f59e0b', rosso: '#ef4444' }[s] || '#6b7280'; }

  // Semaforo: logica completa allineata a dashboard e digest cron
  const _sv = [];
  const _workerCount = (workers || []).length;
  if (!latestDvr && _workerCount > 0)
    _sv.push('critical');
  else if (latestDvr && new Date(latestDvr.created_at) < oneYearAgo)
    _sv.push('warning');
  if (expiredCerts.length > 0) _sv.push('critical');
  if (soonCerts.length > 0)    _sv.push('warning');
  for (const d of subDocs || []) {
    if (!d.valid_until) continue;
    const vd = new Date(d.valid_until);
    if (vd < now) _sv.push('critical'); else if (vd < in30) _sv.push('warning');
  }
  if ((ssorvExpired || []).length > 0) _sv.push('critical');
  if ((ssorvSoon    || []).length > 0) _sv.push('warning');
  if (compData?.durc_expiry_date) {
    if (compData.durc_expiry_date < todayStr)       _sv.push('critical');
    else if (compData.durc_expiry_date < in30Str)   _sv.push('warning');
  }
  if (compData?.last_safety_meeting_at) {
    const nextDue = new Date(new Date(compData.last_safety_meeting_at).getTime() + 365 * 86_400_000);
    if (nextDue < now) _sv.push('warning');
  }
  if (_workerCount > 0 && !(safetyRoles || []).some(r => r.role_type === 'rspp'))
    _sv.push('warning');

  const semaforo      = _sv.includes('critical') ? 'rosso' : _sv.includes('warning') ? 'giallo' : 'verde';
  const hasIssues     = _sv.length > 0;
  const semaforoLabel = { verde: 'CONFORME', giallo: 'ATTENZIONE', rosso: 'NON CONFORME' }[semaforo];

  const certRows = (certs || []).map(c => {
    const exp = c.expiry_date ? new Date(c.expiry_date) : null;
    const stato = !exp ? 'N/D' : exp < now ? 'SCADUTO' : exp < in30 ? 'IN SCADENZA' : 'VALIDO';
    const color = !exp ? '#9ca3af' : exp < now ? '#ef4444' : exp < in30 ? '#f59e0b' : '#10b981';
    return `<tr>
      <td>${esc(c.workers?.full_name || '—')}</td>
      <td>${esc(c.course_types?.name || '—')}</td>
      <td>${fmtDate(c.expiry_date)}</td>
      <td style="color:${color};font-weight:700;">${stato}</td>
    </tr>`;
  }).join('');

  const siteRows = (sites || []).map(s =>
    `<tr><td>${esc(s.name)}</td><td>${esc(s.address || '—')}</td><td>${esc(s.status || 'attivo')}</td></tr>`
  ).join('');

  const subRows = (subcontractors || []).map(s => {
    const docs  = (subDocs || []).filter(d => d.company_id === s.id);
    const expiredDoc = docs.some(d => d.valid_until && new Date(d.valid_until) < now);
    return `<tr>
      <td>${esc(s.company_name)}</td>
      <td>${esc(s.piva || '—')}</td>
      <td>${esc(s.status || '—')}</td>
      <td style="color:${expiredDoc ? '#ef4444' : '#10b981'};font-weight:700;">${expiredDoc ? 'DOC. SCADUTO' : 'OK'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; }
  .page { padding: 30mm 20mm 25mm; }
  .cover { border-bottom: 3px solid #1a1a1a; padding-bottom: 20px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 10px; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; color: #9ca3af; margin-bottom: 8px; }
  .company-name { font-size: 22px; font-weight: 800; color: #1a1a1a; line-height: 1.2; }
  .semaforo { text-align: right; }
  .sem-badge { display: inline-block; padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 800; letter-spacing: 0.06em; }
  .sem-date { font-size: 10px; color: #9ca3af; margin-top: 6px; }
  .meta-row { display: flex; gap: 32px; font-size: 11px; color: #6b7280; margin-bottom: 28px; flex-wrap: wrap; }
  .meta-item strong { color: #1a1a1a; font-weight: 700; }
  h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6b7280; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f9fafb; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #9ca3af; padding: 7px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
  .kpi { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; text-align: center; }
  .kpi-val { font-size: 24px; font-weight: 800; color: #1a1a1a; line-height: 1; }
  .kpi-label { font-size: 9px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.07em; margin-top: 5px; }
  .dvr-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; }
  .dvr-ok { border-left: 4px solid #10b981; }
  .dvr-warn { border-left: 4px solid #f59e0b; }
  .dvr-miss { border-left: 4px solid #ef4444; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; height: 18mm; display: flex; align-items: center; justify-content: space-between; padding: 0 20mm; border-top: 1px solid #e5e7eb; font-size: 9px; color: #9ca3af; }
  .empty { color: #9ca3af; font-size: 11px; padding: 12px 0; text-align: center; }
  .alert-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
  .alert-box p { font-size: 11px; color: #991b1b; }
</style>
</head><body>
<div class="page">
  <div class="cover">
    <div>
      <div class="brand" style="display:flex;align-items:center;gap:6px"><svg width="9" height="10" viewBox="0 0 544 592" style="flex-shrink:0"><path fill="currentColor" fill-rule="evenodd" d="M 4 4 L 311 4 L 333 6 L 365 12 L 394 21 L 430 38 L 450 51 L 478 75 L 493 92 L 507 112 L 526 151 L 537 195 L 539 214 L 539 245 L 533 285 L 521 321 L 511 341 L 498 361 L 487 375 L 465 397 L 447 411 L 406 434 L 372 446 L 340 453 L 310 456 L 148 456 L 147 587 L 4 587 L 4 4 Z M 107 100 L 305 100 L 329 103 L 354 110 L 370 117 L 389 129 L 413 153 L 421 165 L 429 182 L 434 199 L 437 219 L 437 240 L 433 265 L 428 280 L 419 298 L 408 313 L 394 327 L 377 339 L 359 348 L 338 355 L 305 360 L 148 360 L 147 443 L 107 483 L 107 100 Z"/></svg>Palladia — Report Vigilanza</div>
      <div class="company-name">${esc(company?.name || 'Azienda')}</div>
      ${company?.piva ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">P.IVA ${esc(company.piva)}</div>` : ''}
    </div>
    <div class="semaforo">
      <div class="sem-badge" style="background:${semColor(semaforo)}20;color:${semColor(semaforo)};">${semaforoLabel}</div>
      <div class="sem-date">Generato il ${fmtDate(now.toISOString())}</div>
      <div class="sem-date">Studio: ${esc(req.studio.studio_name)}</div>
    </div>
  </div>

  ${hasIssues ? `<div class="alert-box"><p>⚠️ Sono presenti non conformità che richiedono intervento immediato.</p></div>` : ''}

  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-val">${(sites || []).length}</div><div class="kpi-label">Cantieri attivi</div></div>
    <div class="kpi"><div class="kpi-val">${(workers || []).length}</div><div class="kpi-label">Lavoratori</div></div>
    <div class="kpi"><div class="kpi-val" style="color:${expiredCerts.length > 0 ? '#ef4444' : '#10b981'}">${expiredCerts.length}</div><div class="kpi-label">Attestati scaduti</div></div>
    <div class="kpi"><div class="kpi-val" style="color:${soonCerts.length > 0 ? '#f59e0b' : '#1a1a1a'}">${soonCerts.length}</div><div class="kpi-label">In scadenza 30gg</div></div>
  </div>

  <h2>Documento di Valutazione dei Rischi (DVR)</h2>
  ${latestDvr ? `
  <div class="dvr-box ${dvrAge && dvrAge > 365 ? 'dvr-warn' : 'dvr-ok'}">
    <div style="font-size:12px;font-weight:700;">Revisione ${latestDvr.revision || 1} — ${fmtDate(latestDvr.created_at)}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      ${dvrAge !== null ? `Documento redatto da ${dvrAge} giorni` : ''}.
      ${latestDvr.dvr_data?.datoreLavoro ? `Datore di lavoro: ${esc(latestDvr.dvr_data.datoreLavoro)}` : ''}
      ${dvrAge && dvrAge > 365 ? ' — <strong style="color:#f59e0b;">Aggiornamento consigliato (>12 mesi)</strong>' : ''}
    </div>
  </div>` : `
  <div class="dvr-box dvr-miss">
    <div style="font-size:12px;font-weight:700;color:#ef4444;">DVR non presente</div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">Obbligatorio ai sensi del D.Lgs 81/2008 Art. 28 per tutte le aziende con lavoratori dipendenti.</div>
  </div>`}

  <h2>Cantieri attivi (${(sites || []).length})</h2>
  ${(sites || []).length === 0 ? '<div class="empty">Nessun cantiere attivo</div>' : `
  <table><thead><tr><th>Nome cantiere</th><th>Indirizzo</th><th>Stato</th></tr></thead>
  <tbody>${siteRows}</tbody></table>`}

  <h2>Formazione lavoratori (${(certs || []).length} attestati)</h2>
  ${(certs || []).length === 0 ? '<div class="empty">Nessun attestato registrato</div>' : `
  <table><thead><tr><th>Lavoratore</th><th>Corso</th><th>Scadenza</th><th>Stato</th></tr></thead>
  <tbody>${certRows}</tbody></table>`}

  <h2>Subappaltatori (${(subcontractors || []).length})</h2>
  ${(subcontractors || []).length === 0 ? '<div class="empty">Nessun subappaltatore registrato</div>' : `
  <table><thead><tr><th>Ragione sociale</th><th>P.IVA</th><th>Stato</th><th>Documenti</th></tr></thead>
  <tbody>${subRows}</tbody></table>`}
</div>

<div class="footer">
  <span>Palladia — Gestione Sicurezza Cantieri</span>
  <span>${esc(company?.name || '')} — ${esc(req.studio.studio_name)} — ${fmtDate(now.toISOString())}</span>
</div>
</body></html>`;

  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, { docTitle: `Report Vigilanza — ${company?.name}`, rev: 1 });
  } catch (renderErr) {
    console.error('[studio] report vigilanza render error:', renderErr.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  const safeName = (company?.name || 'impresa').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-vigilanza-${safeName}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// ── Crea impresa cliente direttamente (CDL data controller) ──────────────────
// Non richiede che l'impresa sia su Palladia. Il CDL crea il profilo e poi
// gestisce lavoratori e certificati in autonomia.
router.post('/studio/clients/create-direct', verifyStudioJwt, validate(createDirectClientSchema), async (req, res) => {
  const { company_name, piva, address, phone, contact_email, safety_manager } = req.body || {};

  if (!company_name?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Il nome azienda è obbligatorio' });
  }

  // Verifica che non esista già un'impresa con questa P.IVA collegata a questo studio
  if (piva?.trim()) {
    const normalizedVat = piva.trim().toUpperCase().replace(/\s/g, '');
    const { data: existingCompany } = await supabase
      .from('companies')
      .select('id')
      .eq('piva', normalizedVat)
      .maybeSingle();

    if (existingCompany) {
      const { data: existingRelation } = await supabase
        .from('studio_clients')
        .select('id, status')
        .eq('studio_id', req.studioId)
        .eq('company_id', existingCompany.id)
        .maybeSingle();

      if (existingRelation?.status === 'active') {
        return res.status(409).json({ error: 'ALREADY_LINKED', message: 'Un\'impresa con questa P.IVA è già collegata al tuo studio.' });
      }
    }
  }

  // Crea il record azienda
  const { data: company, error: cErr } = await supabase
    .from('companies')
    .insert({
      name:                 company_name.trim(),
      piva:                 piva?.trim().toUpperCase().replace(/\s/g, '') || null,
      address:              address?.trim()        || null,
      phone:                phone?.trim()          || null,
      contact_email:        contact_email?.trim()  || null,
      safety_manager:       safety_manager?.trim() || null,
      created_by_studio_id: req.studioId,
    })
    .select()
    .single();

  if (cErr) return res.status(500).json({ error: cErr.message });

  // Crea la relazione studio_clients (già attiva, owned_by_studio=true)
  const { data: client, error: scErr } = await supabase
    .from('studio_clients')
    .insert({
      studio_id:      req.studioId,
      company_id:     company.id,
      status:         'active',
      owned_by_studio: true,
      invited_by:     req.user.id,
      invite_token:   crypto.randomBytes(24).toString('hex'),
      accepted_at:    new Date().toISOString(),
    })
    .select()
    .single();

  if (scErr) {
    await supabase.from('companies').delete().eq('id', company.id);
    return res.status(500).json({ error: scErr.message });
  }

  logStudioAction(req.studioId, req.user.id, 'client.create', { companyId: company.id, payload: { name: company.name } });
  res.status(201).json({ company, client });
});

// ── Aggiorna profilo impresa CDL-owned ────────────────────────────────────────
router.put('/studio/clients/:companyId/profile', verifyStudioJwt, validate(putClientProfileSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const allowed = ['name', 'piva', 'address', 'phone', 'contact_email', 'safety_manager'];
  const update  = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k] || null;

  if (update.piva) update.piva = update.piva.trim().toUpperCase().replace(/\s/g, '');

  const { data, error } = await supabase
    .from('companies')
    .update(update)
    .eq('id', companyId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ company: data });
});

// ── Lavoratori CDL-owned ──────────────────────────────────────────────────────

router.get('/studio/clients/:companyId/workers', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code, is_active, health_fitness_expiry, safety_training_expiry, created_at')
    .eq('company_id', companyId)
    .order('full_name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ workers: data || [], owned_by_studio: access.isOwner });
});

router.post('/studio/clients/:companyId/workers', verifyStudioJwt, validate(createWorkerSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { full_name, fiscal_code } = req.body || {};
  if (!full_name?.trim() || !fiscal_code?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Nome e codice fiscale sono obbligatori' });
  }

  const { data, error } = await supabase
    .from('workers')
    .upsert({
      company_id:  companyId,
      full_name:   full_name.trim(),
      fiscal_code: fiscal_code.trim().toUpperCase(),
      is_active:   true,
    }, { onConflict: 'company_id,fiscal_code' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  logStudioAction(req.studioId, req.user.id, 'worker.create', { companyId, targetType: 'worker', targetId: data.id, payload: { full_name: data.full_name } });
  res.status(201).json({ worker: data });
});

router.put('/studio/clients/:companyId/workers/:workerId', verifyStudioJwt, validate(putWorkerSchema), async (req, res) => {
  const { companyId, workerId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const allowed = ['full_name', 'fiscal_code', 'is_active'];
  const update  = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
  if (update.fiscal_code) update.fiscal_code = update.fiscal_code.trim().toUpperCase();
  if (update.full_name)   update.full_name   = update.full_name.trim();

  const { data, error } = await supabase
    .from('workers')
    .update(update)
    .eq('id', workerId)
    .eq('company_id', companyId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ worker: data });
});

router.delete('/studio/clients/:companyId/workers/:workerId', verifyStudioJwt, async (req, res) => {
  const { companyId, workerId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { error } = await supabase
    .from('workers')
    .update({ is_active: false })
    .eq('id', workerId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Certificati CDL-owned ─────────────────────────────────────────────────────

router.get('/studio/clients/:companyId/certificates', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { data, error } = await supabase
    .from('worker_certificates')
    .select('id, worker_id, course_type_id, issue_date, expiry_date, issuing_body, certificate_number, workers(full_name, fiscal_code), course_types(id, name, validity_years)')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('expiry_date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ certificates: data || [], owned_by_studio: access.isOwner });
});

router.post('/studio/clients/:companyId/certificates', verifyStudioJwt, validate(createCertificateSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const {
    worker_id,
    course_type_name,   // nome libero — risolviamo o creiamo il course_type
    issue_date,
    expiry_date,
    issuing_body = 'Non specificato',
    certificate_number,
  } = req.body || {};

  if (!worker_id || !course_type_name?.trim() || !expiry_date) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'worker_id, course_type_name ed expiry_date sono obbligatori' });
  }

  // Verifica che il lavoratore appartenga all'impresa
  const { data: worker } = await supabase.from('workers').select('id').eq('id', worker_id).eq('company_id', companyId).maybeSingle();
  if (!worker) return res.status(404).json({ error: 'Lavoratore non trovato per questa impresa' });

  const courseTypeId = await resolveOrCreateCourseType(course_type_name);
  if (!courseTypeId) return res.status(500).json({ error: 'Impossibile risolvere il tipo di corso' });

  const resolvedIssueDate = issue_date || (() => {
    // Stima issue_date dalla expiry_date se non fornita (fallback a 5 anni prima)
    const exp = new Date(expiry_date);
    exp.setFullYear(exp.getFullYear() - 5);
    return exp.toISOString().slice(0, 10);
  })();

  const { data, error } = await supabase
    .from('worker_certificates')
    .insert({
      company_id:         companyId,
      worker_id,
      course_type_id:     courseTypeId,
      issue_date:         resolvedIssueDate,
      expiry_date,
      issuing_body:       issuing_body.trim(),
      certificate_number: certificate_number?.trim() || null,
    })
    .select('*, workers(full_name), course_types(name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  logStudioAction(req.studioId, req.user.id, 'cert.create', { companyId, targetType: 'certificate', targetId: data.id });
  res.status(201).json({ certificate: data });
});

router.put('/studio/clients/:companyId/certificates/:certId', verifyStudioJwt, validate(putCertificateSchema), async (req, res) => {
  const { companyId, certId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { course_type_name, issue_date, expiry_date, issuing_body, certificate_number } = req.body || {};
  const update = {};
  if (issue_date)          update.issue_date          = issue_date;
  if (expiry_date)         update.expiry_date          = expiry_date;
  if (issuing_body)        update.issuing_body         = issuing_body.trim();
  if (certificate_number !== undefined) update.certificate_number = certificate_number?.trim() || null;
  if (course_type_name?.trim()) {
    const id = await resolveOrCreateCourseType(course_type_name);
    if (id) update.course_type_id = id;
  }

  const { data, error } = await supabase
    .from('worker_certificates')
    .update(update)
    .eq('id', certId)
    .eq('company_id', companyId)
    .select('*, workers(full_name), course_types(name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ certificate: data });
});

router.delete('/studio/clients/:companyId/certificates/:certId', verifyStudioJwt, async (req, res) => {
  const { companyId, certId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { error } = await supabase
    .from('worker_certificates')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', certId)
    .eq('company_id', companyId)
    .is('deleted_at', null);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Import CSV ────────────────────────────────────────────────────────────────
// Formato CSV (separatore , o ;):
//   nome_lavoratore,codice_fiscale,tipo_corso,data_scadenza[,ente_erogatore][,data_inizio]
//
// La prima riga deve essere l'intestazione (qualsiasi testo, viene saltata).
// Esempio:
//   Nome,CF,Corso,Scadenza,Ente
//   Mario Rossi,RSSMRA80A01H501Z,Formazione lavoratori - Rischio Alto,2026-06-30,Formedil MI
//   Mario Rossi,RSSMRA80A01H501Z,Idoneità medica,2025-12-01,Dr. Bianchi
//
router.post('/studio/clients/:companyId/import-csv', verifyStudioJwt, validate(importCsvSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { csv_text } = req.body || {};
  if (!csv_text?.trim()) return res.status(400).json({ error: 'csv_text obbligatorio' });

  // ── Parse CSV ──────────────────────────────────────────────────────────────
  const lines = csv_text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV deve avere almeno un\'intestazione e una riga di dati' });

  // Rileva separatore (virgola o punto e virgola)
  const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

  // Salta intestazione
  const dataLines = lines.slice(1);

  // Pre-carica i CF già presenti per contare correttamente i nuovi lavoratori
  const { data: existingWorkersData } = await supabase
    .from('workers')
    .select('fiscal_code')
    .eq('company_id', companyId);
  const existingFiscalCodes = new Set((existingWorkersData || []).map(w => w.fiscal_code.toUpperCase()));

  const results = { imported: 0, workers_created: 0, certs_created: 0, errors: [] };

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i].trim();
    if (!line) continue;

    const cols = line.split(sep).map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
    const [full_name, fiscal_code, course_name, expiry_date, issuing_body_raw, issue_date_raw] = cols;

    if (!full_name || !fiscal_code || !course_name || !expiry_date) {
      results.errors.push({ row: i + 2, line, error: 'Colonne mancanti (richieste: nome, CF, corso, scadenza)' });
      continue;
    }

    // Valida data
    const expDate = new Date(expiry_date);
    if (isNaN(expDate.getTime())) {
      results.errors.push({ row: i + 2, line, error: `Data scadenza non valida: "${expiry_date}"` });
      continue;
    }

    try {
      // Upsert lavoratore
      const { data: worker, error: wErr } = await supabase
        .from('workers')
        .upsert({
          company_id:  companyId,
          full_name:   full_name.trim(),
          fiscal_code: fiscal_code.trim().toUpperCase(),
          is_active:   true,
        }, { onConflict: 'company_id,fiscal_code' })
        .select('id')
        .single();

      if (wErr) { results.errors.push({ row: i + 2, error: wErr.message }); continue; }
      const cfNorm = fiscal_code.trim().toUpperCase();
      if (!existingFiscalCodes.has(cfNorm)) {
        results.workers_created++;
        existingFiscalCodes.add(cfNorm);
      }

      // Risolvi o crea course_type
      const courseTypeId = await resolveOrCreateCourseType(course_name);
      if (!courseTypeId) { results.errors.push({ row: i + 2, error: 'Impossibile creare tipo corso' }); continue; }

      const resolvedIssueDate = issue_date_raw?.trim() || (() => {
        const exp = new Date(expiry_date);
        exp.setFullYear(exp.getFullYear() - 5);
        return exp.toISOString().slice(0, 10);
      })();

      // Insert certificato (non upsert — può avere più certificati dello stesso tipo)
      const { error: certErr } = await supabase
        .from('worker_certificates')
        .insert({
          company_id:     companyId,
          worker_id:      worker.id,
          course_type_id: courseTypeId,
          issue_date:     resolvedIssueDate,
          expiry_date,
          issuing_body:   issuing_body_raw?.trim() || 'Non specificato',
        });

      if (certErr) { results.errors.push({ row: i + 2, error: certErr.message }); continue; }

      results.certs_created++;
      results.imported++;
    } catch (err) {
      results.errors.push({ row: i + 2, error: err.message });
    }
  }

  res.json({
    ok:              true,
    imported:        results.imported,
    workers_created: results.workers_created,
    certs_created:   results.certs_created,
    errors:          results.errors,
    total_rows:      dataLines.length,
  });
});

// ── Import anagrafica lavoratori ─────────────────────────────────────────────
// POST /api/v1/studio/clients/:companyId/workers/import
// Formato CSV (sep virgola o punto e virgola):
//   nome_cognome,codice_fiscale[,data_nascita,data_assunzione,qualifica,ruolo,scad_formazione,scad_idoneita]
// Prima riga = intestazione (saltata). Colonne opzionali: lasciarle vuote è OK.
// Risposta: { imported, created, updated, skipped, errors }
//
router.post('/studio/clients/:companyId/workers/import', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { csv_text } = req.body || {};
  if (!csv_text?.trim()) return res.status(400).json({ error: 'csv_text obbligatorio' });

  const lines = csv_text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV deve contenere almeno intestazione + 1 riga dati' });

  const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';

  // Pre-carica CF esistenti per sapere se stiamo creando o aggiornando
  const { data: existing } = await supabase
    .from('workers')
    .select('fiscal_code')
    .eq('company_id', companyId);
  const existingCFs = new Set((existing || []).map(w => w.fiscal_code.toUpperCase()));

  const results = { imported: 0, created: 0, updated: 0, skipped: 0, errors: [] };

  function parseCol(v) {
    if (!v) return null;
    const s = v.trim().replace(/^"(.*)"$/, '$1').trim();
    return s || null;
  }
  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    // Accetta YYYY-MM-DD o DD/MM/YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }
  function isValidCF(cf) {
    return typeof cf === 'string' && /^[A-Z0-9]{16}$/i.test(cf.trim());
  }
  function generateBadgeCode() {
    return require('crypto').randomBytes(9).toString('hex').toUpperCase();
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(sep).map(parseCol);
    const [full_name_raw, cf_raw, birth_raw, hire_raw, qual_raw, role_raw, scad_form_raw, scad_idon_raw] = cols;

    const full_name   = full_name_raw?.trim() || null;
    const fiscal_code = cf_raw?.trim().toUpperCase() || null;

    if (!full_name || !fiscal_code) {
      results.errors.push({ row: i + 1, error: 'nome_cognome e codice_fiscale sono obbligatori' });
      continue;
    }
    if (!isValidCF(fiscal_code)) {
      results.errors.push({ row: i + 1, error: `Codice fiscale non valido: "${fiscal_code}"` });
      continue;
    }

    const record = {
      company_id:              companyId,
      full_name:               full_name,
      fiscal_code:             fiscal_code,
      is_active:               true,
      birth_date:              parseDate(birth_raw),
      hire_date:               parseDate(hire_raw),
      qualification:           qual_raw  || null,
      role:                    role_raw  || null,
      safety_training_expiry:  parseDate(scad_form_raw),
      health_fitness_expiry:   parseDate(scad_idon_raw),
    };

    const isNew = !existingCFs.has(fiscal_code);
    if (isNew) record.badge_code = generateBadgeCode();

    try {
      const { error } = await supabase
        .from('workers')
        .upsert(record, { onConflict: 'company_id,fiscal_code' });

      if (error) {
        results.errors.push({ row: i + 1, error: error.message });
        continue;
      }

      results.imported++;
      if (isNew) { results.created++; existingCFs.add(fiscal_code); }
      else results.updated++;
    } catch (err) {
      results.errors.push({ row: i + 1, error: err.message });
    }
  }

  res.json({
    ok:       true,
    imported: results.imported,
    created:  results.created,
    updated:  results.updated,
    skipped:  results.skipped,
    errors:   results.errors,
    total_rows: lines.length - 1,
  });
});

// ── Lettera formale scadenze ──────────────────────────────────────────────────
// Genera una lettera professionale da stampare/inviare all'impresa cliente.
router.get('/studio/clients/:companyId/lettera-scadenze.pdf', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const now  = new Date();
  const in60 = new Date(now.getTime() + 60 * 86_400_000);

  const [
    { data: company },
    { data: studio  },
    { data: certs   },
    { data: medici  },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('studio_partners').select('*').eq('id', req.studioId).maybeSingle(),
    supabase.from('worker_certificates')
      .select('id, expiry_date, issue_date, issuing_body, workers(full_name, fiscal_code), course_types(name, validity_years)')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .lt('expiry_date', in60.toISOString().slice(0, 10))
      .order('expiry_date', { ascending: true })
      .limit(100),
    supabase.from('workers')
      .select('id, full_name, fiscal_code, health_fitness_expiry')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .not('health_fitness_expiry', 'is', null)
      .lt('health_fitness_expiry', in60.toISOString().slice(0, 10))
      .order('health_fitness_expiry', { ascending: true }),
  ]);

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtDateLong(d) {
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Converti idoneità mediche nello stesso formato dei certificati per la tabella
  const mediciRows = (medici || []).map(w => ({
    expiry_date:  w.health_fitness_expiry,
    issue_date:   null,
    issuing_body: 'Medico Competente',
    workers:      { full_name: w.full_name, fiscal_code: w.fiscal_code },
    course_types: { name: 'Idoneità medica (sorveglianza sanitaria)', validity_years: 1 },
  }));

  const allItems = [...(certs || []), ...mediciRows].sort((a, b) =>
    new Date(a.expiry_date) - new Date(b.expiry_date)
  );

  const expired  = allItems.filter(c => new Date(c.expiry_date) < now);
  const expiring = allItems.filter(c => new Date(c.expiry_date) >= now);

  const certRow = (c) => {
    const isExp = new Date(c.expiry_date) < now;
    const color = isExp ? '#dc2626' : '#d97706';
    const stato = isExp ? 'SCADUTO' : 'IN SCADENZA';
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;">${esc(c.workers?.full_name || '—')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280;">${esc(c.workers?.fiscal_code || '—')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;">${esc(c.course_types?.name || '—')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;">${fmtDate(c.expiry_date)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;font-weight:700;color:${color};">${stato}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280;">${esc(c.issuing_body || '—')}</td>
    </tr>`;
  };

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; }
  .page { padding: 25mm 22mm 30mm; max-width: 210mm; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 16px; border-bottom: 2px solid #1a1a1a; margin-bottom: 24px; }
  .studio-name { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; color: #1a1a1a; }
  .studio-sub  { font-size: 10px; color: #6b7280; margin-top: 3px; }
  .studio-meta { font-size: 10px; color: #6b7280; text-align: right; line-height: 1.8; }
  .date-line   { font-size: 11px; color: #6b7280; margin-bottom: 20px; }
  .recipient   { margin-bottom: 20px; }
  .recipient-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; margin-bottom: 6px; }
  .recipient-name  { font-size: 13px; font-weight: 700; }
  .recipient-meta  { font-size: 11px; color: #6b7280; line-height: 1.7; }
  .object { font-size: 12px; font-weight: 700; margin-bottom: 20px; padding: 10px 14px; background: #f9fafb; border-left: 3px solid #1a1a1a; }
  .body-text { font-size: 12px; line-height: 1.8; color: #374151; margin-bottom: 16px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 20px 0 10px; padding-bottom: 5px; border-bottom: 1px solid #e5e7eb; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f9fafb; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #9ca3af; padding: 7px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  .alert-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; font-size: 11px; color: #991b1b; }
  .footer-sig { margin-top: 32px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
  .sig-label { font-size: 10px; color: #9ca3af; margin-bottom: 6px; }
  .sig-name { font-size: 13px; font-weight: 700; }
  .sig-meta { font-size: 11px; color: #6b7280; margin-top: 2px; }
  .page-footer { position: fixed; bottom: 0; left: 0; right: 0; height: 16mm; display: flex; align-items: center; justify-content: space-between; padding: 0 22mm; border-top: 1px solid #e5e7eb; font-size: 9px; color: #9ca3af; }
  .legal-note { margin-top: 24px; padding: 10px 14px; background: #f9fafb; border-radius: 4px; font-size: 10px; color: #6b7280; line-height: 1.6; }
</style>
</head><body>
<div class="page">

  <div class="letterhead">
    <div>
      <div class="studio-name">${esc(studio?.studio_name || 'Studio CDL')}</div>
      <div class="studio-sub">Studio di Consulenza del Lavoro${studio?.registration_number ? ' · Albo n. ' + esc(studio.registration_number) : ''}</div>
    </div>
    <div class="studio-meta">
      ${studio?.vat_number ? `P.IVA ${esc(studio.vat_number)}<br>` : ''}
      ${studio?.operative_regions?.length ? esc(studio.operative_regions.join(', ')) + '<br>' : ''}
      Generato tramite Palladia
    </div>
  </div>

  <div class="date-line">${esc(fmtDateLong(now))}</div>

  <div class="recipient">
    <div class="recipient-label">Destinatario</div>
    <div class="recipient-name">${esc(company?.name || 'Impresa')}</div>
    <div class="recipient-meta">
      ${company?.piva ? 'P.IVA ' + esc(company.piva) : ''}
      ${company?.address ? '<br>' + esc(company.address) : ''}
      ${company?.contact_email ? '<br>' + esc(company.contact_email) : ''}
    </div>
  </div>

  <div class="object">
    Oggetto: Comunicazione scadenze certificazioni sicurezza — ai sensi del D.Lgs. 81/2008 art. 37
  </div>

  <div class="body-text">
    Gentile Cliente,<br><br>
    con la presente Vi comunichiamo che la verifica periodica delle certificazioni di sicurezza
    del personale in forza alla Vostra azienda ha evidenziato
    ${expired.length > 0 ? `<strong>${expired.length} certificato${expired.length > 1 ? 'i' : ''} già scaduto${expired.length > 1 ? 'i' : ''}</strong>` : ''}
    ${expired.length > 0 && expiring.length > 0 ? ' e ' : ''}
    ${expiring.length > 0 ? `<strong>${expiring.length} certificato${expiring.length > 1 ? 'i' : ''} in scadenza nei prossimi 60 giorni</strong>` : ''}
    che richiedono la Vostra immediata attenzione.
  </div>

  ${expired.length > 0 ? '<div class="alert-box">⚠️ I certificati scaduti espongono l\'azienda a responsabilità penali e civili ai sensi del D.Lgs. 81/2008. È necessario procedere con urgenza al rinnovo.</div>' : ''}

  ${allItems.length > 0 ? `
  <div class="section-title">Dettaglio certificazioni da rinnovare</div>
  <table>
    <thead>
      <tr>
        <th>Lavoratore</th>
        <th>Codice Fiscale</th>
        <th>Tipo corso</th>
        <th>Scadenza</th>
        <th>Stato</th>
        <th>Ente erogatore</th>
      </tr>
    </thead>
    <tbody>${allItems.map(certRow).join('')}</tbody>
  </table>
  ` : '<div class="body-text">Nessuna scadenza imminente rilevata nel periodo considerato.</div>'}

  <div class="body-text" style="margin-top:20px;">
    Vi invitiamo a procedere con il rinnovo delle certificazioni entro i termini indicati,
    avvalendovi degli enti di formazione accreditati. Lo Studio rimane a Vostra disposizione
    per qualsiasi chiarimento o assistenza nella gestione delle scadenze.
  </div>

  <div class="legal-note">
    La presente comunicazione è predisposta nell'ambito del servizio di monitoraggio della conformità
    prestato dallo Studio ai sensi del D.Lgs. 81/2008. Il responsabile delle misure di prevenzione
    rimane il datore di lavoro ai sensi dell'art. 18 del medesimo decreto.
  </div>

  <div class="footer-sig">
    <div class="sig-label">Firma dello Studio</div>
    <div class="sig-name">${esc(studio?.studio_name || 'Studio CDL')}</div>
    <div class="sig-meta">
      Consulente del Lavoro${studio?.registration_number ? ' — Albo n. ' + esc(studio.registration_number) : ''}
    </div>
    <div style="margin-top:40px;border-top:1px solid #d1d5db;width:200px;padding-top:4px;font-size:10px;color:#9ca3af;">Timbro e firma</div>
  </div>

</div>

<div class="page-footer">
  <span>${esc(studio?.studio_name || '')} — Studio di Consulenza del Lavoro</span>
  <span>Generato il ${fmtDate(now.toISOString())} tramite Palladia</span>
</div>
</body></html>`;

  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, { docTitle: `Lettera scadenze — ${company?.name}`, rev: 1 });
  } catch (err) {
    console.error('[studio] lettera render error:', err.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  const safeName = (company?.name || 'impresa').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const dateStr  = now.toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="lettera-scadenze-${safeName}-${dateStr}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// ── Lista clienti (attivi + pending) ─────────────────────────────────────────

// Rimuovi relazione studio-impresa
router.delete('/studio/clients/:companyId', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;

  if (!['owner', 'admin'].includes(req.studioRole)) {
    return res.status(403).json({ error: 'Solo owner/admin dello studio possono rimuovere un cliente' });
  }

  const { error } = await supabase
    .from('studio_clients')
    .delete()
    .eq('studio_id', req.studioId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Dashboard aggregato ───────────────────────────────────────────────────────

router.get('/studio/dashboard', verifyStudioJwt, async (req, res) => {
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, owned_by_studio, companies(id, name)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) {
    return res.json({
      clients: [],
      alerts:  [],
      summary: { total: 0, verde: 0, giallo: 0, rosso: 0 },
    });
  }

  const allCompanyIds = clients.map(c => c.company_id);
  const companyIds    = await filterClientsByCollaborator(req.studioId, req.user.id, req.studioRole, allCompanyIds);
  const thresholds    = await getAlertThresholds(req.studioId);
  const now           = new Date();
  const in30          = new Date(now.getTime() + (thresholds.cert_expiry.critical || 30) * 86400_000);
  const oneYearAgo    = new Date(now.getTime() - (thresholds.dvr_age.warn || 365) * 86400_000);
  const todayStr      = now.toISOString().slice(0, 10);
  const in30Str    = in30.toISOString().slice(0, 10);

  // Fetch parallelo di tutti i dati necessari (incluse le nuove dimensioni conformità)
  const [
    { data: sites        },
    { data: workers      },
    { data: dvrs         },
    { data: certExpired  },
    { data: certSoon     },
    { data: subDocs      },
    { data: ssorvExpired },
    { data: ssorvSoon    },
    { data: compData     },
    { data: safetyRoles  },
  ] = await Promise.all([
    supabase.from('sites').select('id, company_id').in('company_id', companyIds).neq('status', 'chiuso'),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true),
    supabase.from('dvr_documents').select('id, company_id, created_at').in('company_id', companyIds).order('created_at', { ascending: false }),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds).is('deleted_at', null).lt('expiry_date', todayStr),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds).is('deleted_at', null)
      .gte('expiry_date', todayStr).lt('expiry_date', in30Str),
    supabase.from('subcontractor_documents').select('id, company_id, valid_until').in('company_id', companyIds),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true)
      .not('health_fitness_expiry', 'is', null).lt('health_fitness_expiry', todayStr),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true)
      .not('health_fitness_expiry', 'is', null).gte('health_fitness_expiry', todayStr).lt('health_fitness_expiry', in30Str),
    supabase.from('companies').select('id, durc_expiry_date, last_safety_meeting_at').in('id', companyIds),
    supabase.from('company_safety_roles').select('company_id, role_type').in('company_id', companyIds),
  ]);

  // Inizializza metriche per ogni impresa
  const metrics = {};
  for (const c of clients) {
    metrics[c.company_id] = {
      company_id:               c.company_id,
      company_name:             c.companies?.name || '—',
      owned_by_studio:          c.owned_by_studio || false,
      cantieri_attivi:          0,
      lavoratori_totali:        0,
      dvr_presente:             false,
      dvr_data:                 null,
      certificati_scaduti:      0,
      certificati_in_scadenza:  0,
      sub_docs_scaduti:         0,
      semaforo:                 'verde',
      alerts:                   [],
    };
  }

  for (const s of sites   || []) if (metrics[s.company_id]) metrics[s.company_id].cantieri_attivi++;
  for (const w of workers || []) if (metrics[w.company_id]) metrics[w.company_id].lavoratori_totali++;

  // DVR — solo il più recente per company
  const latestDvr = {};
  for (const d of dvrs || []) if (!latestDvr[d.company_id]) latestDvr[d.company_id] = d;
  for (const [cid, dvr] of Object.entries(latestDvr)) {
    if (!metrics[cid]) continue;
    metrics[cid].dvr_presente = true;
    metrics[cid].dvr_data     = dvr.created_at;
    if (new Date(dvr.created_at) < oneYearAgo) {
      metrics[cid].alerts.push({ type: 'dvr_old', message: 'DVR non aggiornato (>12 mesi)', severity: 'warning' });
    }
  }

  for (const c of certExpired || []) {
    if (!metrics[c.company_id]) continue;
    metrics[c.company_id].certificati_scaduti++;
    metrics[c.company_id].alerts.push({ type: 'cert_expired', message: 'Attestato formazione scaduto', severity: 'critical' });
  }
  for (const c of certSoon || []) {
    if (!metrics[c.company_id]) continue;
    metrics[c.company_id].certificati_in_scadenza++;
    metrics[c.company_id].alerts.push({ type: 'cert_expiring', message: 'Attestato in scadenza (30 gg)', severity: 'warning' });
  }
  for (const d of subDocs || []) {
    if (!metrics[d.company_id] || !d.valid_until) continue;
    const vDate = new Date(d.valid_until);
    if (vDate < now) {
      metrics[d.company_id].sub_docs_scaduti++;
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expired', message: 'Documento subappaltatore scaduto', severity: 'critical' });
    } else if (vDate < in30) {
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expiring', message: 'Documento subappaltatore in scadenza', severity: 'warning' });
    }
  }

  // ── Sorveglianza sanitaria ─────────────────────────────────────────────────
  for (const w of ssorvExpired || []) {
    if (!metrics[w.company_id]) continue;
    metrics[w.company_id].alerts.push({ type: 'sorv_expired', message: 'Idoneità medica scaduta', severity: 'critical' });
  }
  for (const w of ssorvSoon || []) {
    if (!metrics[w.company_id]) continue;
    metrics[w.company_id].alerts.push({ type: 'sorv_expiring', message: 'Idoneità medica in scadenza (30 gg)', severity: 'warning' });
  }

  // ── DURC e riunione periodica ──────────────────────────────────────────────
  for (const co of compData || []) {
    if (!metrics[co.id]) continue;
    if (co.durc_expiry_date) {
      if (co.durc_expiry_date < todayStr) {
        metrics[co.id].alerts.push({ type: 'durc_expired',   message: 'DURC scaduto',               severity: 'critical' });
      } else if (co.durc_expiry_date < in30Str) {
        metrics[co.id].alerts.push({ type: 'durc_expiring',  message: 'DURC in scadenza (30 gg)',    severity: 'warning' });
      }
    }
    if (co.last_safety_meeting_at) {
      const nextDue = new Date(new Date(co.last_safety_meeting_at).getTime() + 365 * 86_400_000);
      if (nextDue < now) {
        metrics[co.id].alerts.push({ type: 'riunione_scaduta', message: 'Riunione periodica art.35 da rinnovare', severity: 'warning' });
      }
    }
  }

  // ── RSPP non nominato ──────────────────────────────────────────────────────
  const rolesByCompany = {};
  for (const r of safetyRoles || []) {
    if (!rolesByCompany[r.company_id]) rolesByCompany[r.company_id] = new Set();
    rolesByCompany[r.company_id].add(r.role_type);
  }
  for (const [cid, m] of Object.entries(metrics)) {
    if (m.lavoratori_totali > 0 && !rolesByCompany[cid]?.has('rspp')) {
      m.alerts.push({ type: 'rspp_mancante', message: 'RSPP non nominato', severity: 'warning' });
    }
  }

  // DVR mancante
  const allAlerts = [];
  for (const m of Object.values(metrics)) {
    if (!m.dvr_presente && m.lavoratori_totali > 0) {
      m.alerts.push({ type: 'dvr_missing', message: 'DVR assente', severity: 'critical' });
    }

    const hasCritical = m.alerts.some(a => a.severity === 'critical');
    const hasWarning  = m.alerts.some(a => a.severity === 'warning');
    m.semaforo = hasCritical ? 'rosso' : hasWarning ? 'giallo' : 'verde';

    for (const alert of m.alerts) {
      allAlerts.push({ ...alert, company_id: m.company_id, company_name: m.company_name });
    }
    // Deduplica alert per tipo
    m.alerts = [...new Map(m.alerts.map(a => [a.type, a])).values()];
  }

  allAlerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

  const clientList = Object.values(metrics);
  const summary = {
    total:  clientList.length,
    verde:  clientList.filter(c => c.semaforo === 'verde').length,
    giallo: clientList.filter(c => c.semaforo === 'giallo').length,
    rosso:  clientList.filter(c => c.semaforo === 'rosso').length,
  };

  res.json({ clients: clientList, alerts: allAlerts.slice(0, 60), summary });
});

// ── Digest manuale ────────────────────────────────────────────────────────────
// Esegue un ciclo completo (identico al cron settimanale) on-demand.
router.post('/studio/digest/send-now', verifyStudioJwt, async (req, res) => {
  const { processStudio } = require('../../services/studioDigestCron');
  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);

  try {
    const studio = {
      id:          req.studioId,
      studio_name: req.studio.studio_name,
      user_id:     req.user.id,
    };
    await processStudio(studio, now, in30, oneYearAgo);
    res.json({ sent: true });
  } catch (err) {
    console.error('[studio] digest/send-now errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sorveglianza sanitaria ────────────────────────────────────────────────────

router.get('/studio/clients/:companyId/sorveglianza', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code, health_fitness_expiry, safety_training_expiry, is_active')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('health_fitness_expiry', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ workers: data || [], owned_by_studio: access.isOwner });
});

router.put('/studio/clients/:companyId/workers/:workerId/sorveglianza', verifyStudioJwt, validate(putSorveglianzaSchema), async (req, res) => {
  const { companyId, workerId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { health_fitness_expiry, safety_training_expiry } = req.body || {};
  const update = {};
  if (health_fitness_expiry  !== undefined) update.health_fitness_expiry  = health_fitness_expiry  || null;
  if (safety_training_expiry !== undefined) update.safety_training_expiry = safety_training_expiry || null;

  const { data, error } = await supabase
    .from('workers')
    .update(update)
    .eq('id', workerId)
    .eq('company_id', companyId)
    .select('id, full_name, health_fitness_expiry, safety_training_expiry')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ worker: data });
});

// ── Conformità impresa (DURC + riunione periodica) ────────────────────────────

router.get('/studio/clients/:companyId/compliance', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const [{ data: company }, { data: roles }] = await Promise.all([
    supabase.from('companies')
      .select('durc_expiry_date, last_safety_meeting_at, safety_meeting_threshold')
      .eq('id', companyId).maybeSingle(),
    supabase.from('company_safety_roles')
      .select('*').eq('company_id', companyId).order('role_type'),
  ]);

  res.json({
    durc_expiry_date:         company?.durc_expiry_date         || null,
    last_safety_meeting_at:   company?.last_safety_meeting_at   || null,
    safety_meeting_threshold: company?.safety_meeting_threshold ?? 15,
    safety_roles:             roles || [],
  });
});

router.put('/studio/clients/:companyId/compliance', verifyStudioJwt, validate(putComplianceSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const allowed = ['durc_expiry_date', 'last_safety_meeting_at'];
  const update  = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k] || null;

  const { data, error } = await supabase
    .from('companies').update(update).eq('id', companyId)
    .select('durc_expiry_date, last_safety_meeting_at').single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Figure sicurezza ──────────────────────────────────────────────────────────

const VALID_SAFETY_ROLES = ['rspp','mc','rls','preposto','aspp','addetto_ps','addetto_antincendio'];
const SAFETY_ROLE_LABELS = {
  rspp: 'RSPP', mc: 'Medico Competente', rls: 'RLS', preposto: 'Preposto',
  aspp: 'ASPP', addetto_ps: 'Addetto Primo Soccorso', addetto_antincendio: 'Addetto Antincendio',
};

router.post('/studio/clients/:companyId/safety-roles', verifyStudioJwt, validate(createSafetyRoleSchema), async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { role_type, full_name, appointment_date, expiry_date, qualification, notes } = req.body || {};
  if (!role_type || !full_name?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'role_type e full_name obbligatori' });
  }
  if (!VALID_SAFETY_ROLES.includes(role_type)) {
    return res.status(400).json({ error: 'INVALID_ROLE_TYPE', message: `role_type deve essere uno di: ${VALID_SAFETY_ROLES.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('company_safety_roles')
    .upsert({
      company_id:       companyId,
      role_type,
      full_name:        full_name.trim(),
      appointment_date: appointment_date || null,
      expiry_date:      expiry_date      || null,
      qualification:    qualification?.trim() || null,
      notes:            notes?.trim()    || null,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'company_id,role_type' })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ role: data });
});

router.delete('/studio/clients/:companyId/safety-roles/:roleId', verifyStudioJwt, async (req, res) => {
  const { companyId, roleId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { error } = await supabase
    .from('company_safety_roles').delete()
    .eq('id', roleId).eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Scadenziario unificato ────────────────────────────────────────────────────
// Vista cronologica di TUTTE le scadenze di TUTTI i clienti dello studio.
// Include: attestati, sorveglianza, DURC, DVR vecchio, riunione periodica, figure sicurezza.

router.get('/studio/scadenziario', verifyStudioJwt, async (req, res) => {
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) return res.json({ items: [], total_critical: 0 });

  const allCompanyIds = clients.map(c => c.company_id);
  const companyIds    = await filterClientsByCollaborator(req.studioId, req.user.id, req.studioRole, allCompanyIds);
  const companyMap    = Object.fromEntries(clients.map(c => [c.company_id, c.companies?.name || '—']));
  const thresholds    = await getAlertThresholds(req.studioId);
  const now           = new Date();
  const maxWarn       = Math.max(...Object.values(thresholds).map(t => t.warn));
  const horizonMs     = maxWarn * 86_400_000;
  const inHorizon     = new Date(now.getTime() + horizonMs);
  const oneYearAgo    = new Date(now.getTime() - (thresholds.dvr_age.warn || 365) * 86_400_000);
  const todayStr      = now.toISOString().slice(0, 10);
  const in90Str       = inHorizon.toISOString().slice(0, 10);

  const [
    { data: certs     },
    { data: sorv      },
    { data: companies },
    { data: dvrs      },
    { data: roles     },
  ] = await Promise.all([
    supabase.from('worker_certificates')
      .select('id, company_id, expiry_date, workers(full_name), course_types(name)')
      .in('company_id', companyIds).lt('expiry_date', in90Str).order('expiry_date'),
    supabase.from('workers')
      .select('id, company_id, full_name, health_fitness_expiry')
      .in('company_id', companyIds).eq('is_active', true)
      .not('health_fitness_expiry', 'is', null).lt('health_fitness_expiry', in90Str),
    supabase.from('companies')
      .select('id, durc_expiry_date, last_safety_meeting_at')
      .in('id', companyIds),
    supabase.from('dvr_documents')
      .select('id, company_id, created_at').in('company_id', companyIds)
      .order('created_at', { ascending: false }),
    supabase.from('company_safety_roles')
      .select('id, company_id, role_type, full_name, expiry_date')
      .in('company_id', companyIds).not('expiry_date', 'is', null).lt('expiry_date', in90Str),
  ]);

  const items = [];

  for (const c of certs || []) {
    if (!companyMap[c.company_id]) continue;
    items.push({
      type: 'cert', company_id: c.company_id, company_name: companyMap[c.company_id],
      expiry_date: c.expiry_date,
      label: `${c.course_types?.name || 'Attestato'} — ${c.workers?.full_name || '—'}`,
      severity: c.expiry_date < todayStr ? 'critical' : 'warning',
    });
  }

  for (const w of sorv || []) {
    if (!companyMap[w.company_id]) continue;
    items.push({
      type: 'sorveglianza', company_id: w.company_id, company_name: companyMap[w.company_id],
      expiry_date: w.health_fitness_expiry,
      label: `Idoneità medica — ${w.full_name}`,
      severity: w.health_fitness_expiry < todayStr ? 'critical' : 'warning',
    });
  }

  for (const co of companies || []) {
    if (!companyMap[co.id]) continue;
    if (co.durc_expiry_date && co.durc_expiry_date < in90Str) {
      items.push({
        type: 'durc', company_id: co.id, company_name: companyMap[co.id],
        expiry_date: co.durc_expiry_date,
        label: 'DURC — scadenza',
        severity: co.durc_expiry_date < todayStr ? 'critical' : 'warning',
      });
    }
    if (co.last_safety_meeting_at) {
      const nextDue    = new Date(new Date(co.last_safety_meeting_at).getTime() + 365 * 86_400_000);
      const nextDueStr = nextDue.toISOString().slice(0, 10);
      if (nextDueStr < in90Str) {
        items.push({
          type: 'riunione', company_id: co.id, company_name: companyMap[co.id],
          expiry_date: nextDueStr,
          label: 'Riunione periodica art.35 D.Lgs.81/2008',
          severity: nextDueStr < todayStr ? 'critical' : 'warning',
        });
      }
    }
  }

  // DVR vecchio (>12 mesi dall'ultima revisione)
  const latestDvr = {};
  for (const d of dvrs || []) if (!latestDvr[d.company_id]) latestDvr[d.company_id] = d;
  for (const [cid, dvr] of Object.entries(latestDvr)) {
    if (!companyMap[cid]) continue;
    const dvrDate = new Date(dvr.created_at);
    if (dvrDate < oneYearAgo) {
      const dueStr = new Date(dvrDate.getTime() + 365 * 86_400_000).toISOString().slice(0, 10);
      items.push({
        type: 'dvr', company_id: cid, company_name: companyMap[cid],
        expiry_date: dueStr,
        label: `DVR da aggiornare — ultima rev. ${dvrDate.toLocaleDateString('it-IT')}`,
        severity: 'warning',
      });
    }
  }

  for (const r of roles || []) {
    if (!companyMap[r.company_id]) continue;
    items.push({
      type: 'safety_role', company_id: r.company_id, company_name: companyMap[r.company_id],
      expiry_date: r.expiry_date,
      label: `Nomina ${SAFETY_ROLE_LABELS[r.role_type] || r.role_type} — ${r.full_name}`,
      severity: r.expiry_date < todayStr ? 'critical' : 'warning',
    });
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return (a.expiry_date || '').localeCompare(b.expiry_date || '');
  });

  // CSV export
  if (req.query.format === 'csv') {
    const header = 'Tipo,Impresa,Scadenza,Descrizione,Severità';
    const rows = items.map(i =>
      `"${i.type}","${(i.company_name||'').replace(/"/g,'""')}","${i.expiry_date || ''}","${(i.label||'').replace(/"/g,'""')}","${i.severity}"`
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scadenziario_${todayStr}.csv"`);
    return res.send('﻿' + [header, ...rows].join('\r\n'));
  }

  res.json({ items, total_critical: items.filter(i => i.severity === 'critical').length });
});

// ── Report conformità completo PDF ────────────────────────────────────────────
// Documento di audit completo che il CDL porta alle ispezioni ASL/INAIL.

router.get('/studio/clients/:companyId/report-conformita.pdf', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const in60       = new Date(now.getTime() + 60 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const todayStr   = now.toISOString().slice(0, 10);

  const [
    { data: company  },
    { data: studio   },
    { data: workers  },
    { data: dvrs     },
    { data: certs    },
    { data: roles    },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('studio_partners').select('*').eq('id', req.studioId).maybeSingle(),
    supabase.from('workers').select('id, full_name, fiscal_code, health_fitness_expiry, is_active').eq('company_id', companyId).eq('is_active', true).order('full_name'),
    supabase.from('dvr_documents').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(1),
    supabase.from('worker_certificates').select('*, workers(full_name, fiscal_code), course_types(name)').eq('company_id', companyId).order('expiry_date'),
    supabase.from('company_safety_roles').select('*').eq('company_id', companyId),
  ]);

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(iso) { if(!iso)return '—'; return new Date(iso).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}); }

  const latestDvr   = dvrs?.[0];
  const dvrOld      = latestDvr && new Date(latestDvr.created_at) < oneYearAgo;
  const expiredCerts = (certs||[]).filter(c => c.expiry_date && c.expiry_date < todayStr);
  const soonCerts    = (certs||[]).filter(c => c.expiry_date && c.expiry_date >= todayStr && new Date(c.expiry_date) < in60);
  const expiredSorv  = (workers||[]).filter(w => w.health_fitness_expiry && w.health_fitness_expiry < todayStr);
  const soonSorv     = (workers||[]).filter(w => w.health_fitness_expiry && w.health_fitness_expiry >= todayStr && new Date(w.health_fitness_expiry) < in60);

  const durcDate    = company?.durc_expiry_date;
  const durcExpired = durcDate && durcDate < todayStr;
  const durcSoon    = durcDate && durcDate >= todayStr && new Date(durcDate) < in30;
  const meetingNext = company?.last_safety_meeting_at
    ? new Date(new Date(company.last_safety_meeting_at).getTime() + 365 * 86_400_000)
    : null;
  const meetingDue  = meetingNext && meetingNext < now;

  const hasCritical = (!latestDvr && (workers||[]).length > 0) || expiredCerts.length > 0 || expiredSorv.length > 0 || durcExpired;
  const hasWarning  = dvrOld || soonCerts.length > 0 || soonSorv.length > 0 || durcSoon || meetingDue;
  const semaforo    = hasCritical ? 'rosso' : hasWarning ? 'giallo' : 'verde';
  const semColor    = semaforo === 'rosso' ? '#dc2626' : semaforo === 'giallo' ? '#d97706' : '#059669';
  const semLabel    = semaforo === 'rosso' ? 'NON CONFORME' : semaforo === 'giallo' ? 'ATTENZIONE' : 'CONFORME';

  function chip(ok, okLabel, koLabel) {
    return ok
      ? `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">${okLabel}</span>`
      : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">${koLabel}</span>`;
  }

  function certColor(expStr) {
    if (!expStr) return '#6b7280';
    if (expStr < todayStr) return '#dc2626';
    if (new Date(expStr) < in60) return '#d97706';
    return '#059669';
  }
  function certLabel(expStr) {
    if (!expStr) return 'N/D';
    if (expStr < todayStr) return 'SCADUTO';
    if (new Date(expStr) < in60) return 'IN SCADENZA';
    return 'VALIDO';
  }

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Arial,sans-serif;font-size:12px;color:#1a1a1a;background:#fff}
  .page{padding:20mm 22mm 28mm;max-width:210mm}
  .lh{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:2px solid #1a1a1a;margin-bottom:18px}
  .sn{font-size:16px;font-weight:800}.ss{font-size:10px;color:#6b7280;margin-top:2px}.sm{font-size:10px;color:#6b7280;text-align:right;line-height:1.8}
  .sec{margin-bottom:18px}
  .sec-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:7px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
  table{width:100%;border-collapse:collapse}
  th{background:#f9fafb;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af;padding:5px 8px;text-align:left;border-bottom:1px solid #e5e7eb}
  td{padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:11px;vertical-align:middle}
  .cr{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:1px solid #f3f4f6}
  .cl{font-size:12px}.cd{font-size:11px;color:#6b7280;margin-top:1px}
  .sf{margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between}
  .sb{font-size:11px;color:#6b7280}.sb strong{display:block;font-size:12px;color:#1a1a1a;margin-bottom:2px}
  .pf{position:fixed;bottom:0;left:0;right:0;height:12mm;display:flex;align-items:center;justify-content:space-between;padding:0 22mm;border-top:1px solid #e5e7eb;font-size:9px;color:#9ca3af}
  .sg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
  .sb2{background:#f9fafb;border-radius:6px;padding:9px;text-align:center}
  .sn2{font-size:20px;font-weight:800}.sl{font-size:10px;color:#6b7280;margin-top:2px}
</style>
</head><body><div class="page">

<div class="lh">
  <div>
    <div class="sn">${esc(studio?.studio_name||'Studio CDL')}</div>
    <div class="ss">Studio di Consulenza del Lavoro${studio?.registration_number?' · Albo n. '+esc(studio.registration_number):''}</div>
  </div>
  <div class="sm">${studio?.vat_number?`P.IVA ${esc(studio.vat_number)}<br>`:''}Generato ${fmtDate(now.toISOString())} via Palladia</div>
</div>

<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;gap:16px">
  <div>
    <div style="font-size:14px;font-weight:800">Report di Conformità D.Lgs. 81/2008</div>
    <div style="font-size:11px;color:#6b7280;margin-top:3px">${esc(company?.name||'Impresa')}${company?.piva?' — P.IVA '+esc(company.piva):''}${company?.address?'<br>'+esc(company.address):''}</div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <span style="background:${semColor}22;color:${semColor};border:1px solid ${semColor}44;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:800">${semLabel}</span>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">${fmtDate(now.toISOString())}</div>
  </div>
</div>

<div class="sec">
  <div class="sec-t">Sommario</div>
  <div class="sg">
    <div class="sb2"><div class="sn2">${(workers||[]).length}</div><div class="sl">Lavoratori</div></div>
    <div class="sb2"><div class="sn2" style="${expiredCerts.length>0?'color:#dc2626':''}">${expiredCerts.length}</div><div class="sl">Attestati scaduti</div></div>
    <div class="sb2"><div class="sn2" style="${expiredSorv.length>0?'color:#dc2626':''}">${expiredSorv.length}</div><div class="sl">Idon. med. scadute</div></div>
    <div class="sb2"><div class="sn2" style="${soonCerts.length>0?'color:#d97706':''}">${soonCerts.length}</div><div class="sl">In scadenza 60gg</div></div>
  </div>
</div>

<div class="sec">
  <div class="sec-t">Checklist conformità</div>
  <div style="background:#f9fafb;border-radius:6px;overflow:hidden;border:1px solid #e5e7eb">
    <div class="cr"><div><div class="cl">DVR (Documento Valutazione Rischi)</div><div class="cd">${latestDvr?'Ultima rev.: '+fmtDate(latestDvr.created_at):'Non presente'}</div></div>
      ${latestDvr?(dvrOld?chip(false,'','DA AGGIORNARE'):chip(true,'AGGIORNATO','')):((workers||[]).length>0?chip(false,'','ASSENTE OBBLIGATORIO'):chip(true,'N/A',''))}</div>
    <div class="cr"><div><div class="cl">DURC (Regolarità Contributiva)</div><div class="cd">${durcDate?'Scadenza: '+fmtDate(durcDate):'Non registrato'}</div></div>
      ${durcDate?(durcExpired?chip(false,'','SCADUTO'):durcSoon?chip(false,'','IN SCADENZA'):chip(true,'VALIDO','')):chip(false,'','NON REGISTRATO')}</div>
    <div class="cr"><div><div class="cl">Riunione periodica (art. 35 D.Lgs.81/2008)</div><div class="cd">${company?.last_safety_meeting_at?'Ultima: '+fmtDate(company.last_safety_meeting_at):'Non registrata'}</div></div>
      ${company?.last_safety_meeting_at?(meetingDue?chip(false,'','DA RINNOVARE'):chip(true,'OK','')):chip(false,'','NON REGISTRATA')}</div>
    ${!(roles||[]).length
      ? `<div class="cr"><div><div class="cl">Figure sicurezza (RSPP, MC, RLS)</div><div class="cd">Nessuna figura nominata</div></div>${chip(false,'','VERIFICARE')}</div>`
      : (roles||[]).map(r=>`<div class="cr"><div><div class="cl">${esc(SAFETY_ROLE_LABELS[r.role_type]||r.role_type)}: ${esc(r.full_name)}</div><div class="cd">${r.appointment_date?'Nomina: '+fmtDate(r.appointment_date):''}${r.expiry_date?' · Scad.: '+fmtDate(r.expiry_date):''}</div></div>${r.expiry_date?(r.expiry_date<todayStr?chip(false,'','SCADUTO'):chip(true,'OK','')):chip(true,'OK','')}</div>`).join('')}
  </div>
</div>

${(workers||[]).some(w=>w.health_fitness_expiry)?`<div class="sec">
  <div class="sec-t">Sorveglianza sanitaria — idoneità lavorativa</div>
  <table><thead><tr><th>Lavoratore</th><th>CF</th><th>Scadenza</th><th>Stato</th></tr></thead>
  <tbody>${(workers||[]).filter(w=>w.health_fitness_expiry).map(w=>`<tr>
    <td>${esc(w.full_name)}</td><td style="color:#6b7280;font-size:11px">${esc(w.fiscal_code||'—')}</td>
    <td>${fmtDate(w.health_fitness_expiry)}</td>
    <td><span style="color:${certColor(w.health_fitness_expiry)};font-weight:700;font-size:10px">${certLabel(w.health_fitness_expiry)}</span></td>
  </tr>`).join('')}</tbody></table>
</div>`:''}

${(certs||[]).length>0?`<div class="sec">
  <div class="sec-t">Attestati di formazione</div>
  <table><thead><tr><th>Lavoratore</th><th>Tipo corso</th><th>Scadenza</th><th>Ente</th><th>Stato</th></tr></thead>
  <tbody>${(certs||[]).map(c=>`<tr>
    <td>${esc(c.workers?.full_name||'—')}</td><td>${esc(c.course_types?.name||'—')}</td>
    <td>${fmtDate(c.expiry_date)}</td><td style="color:#6b7280">${esc(c.issuing_body||'—')}</td>
    <td><span style="color:${certColor(c.expiry_date)};font-weight:700;font-size:10px">${certLabel(c.expiry_date)}</span></td>
  </tr>`).join('')}</tbody></table>
</div>`:''}

<div class="sf">
  <div class="sb"><strong>${esc(studio?.studio_name||'Studio CDL')}</strong>Consulente del Lavoro${studio?.registration_number?' — Albo n. '+esc(studio.registration_number):''}</div>
  <div style="margin-top:30px;border-top:1px solid #d1d5db;width:160px;padding-top:4px;font-size:10px;color:#9ca3af;text-align:center">Timbro e firma</div>
</div>

</div>
<div class="pf">
  <span>${esc(studio?.studio_name||'')} — Conformità ${esc(company?.name||'')}</span>
  <span>Generato ${fmtDate(now.toISOString())} via Palladia</span>
</div>
</body></html>`;

  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, { docTitle: `Report conformità — ${company?.name}`, rev: 1 });
  } catch (err) {
    console.error('[studio] report-conformita render error:', err.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  const safeName = (company?.name||'impresa').replace(/[^a-zA-Z0-9]/g,'-').toLowerCase();
  const dateStr  = now.toISOString().slice(0,10);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="report-conformita-${safeName}-${dateStr}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// ── Claim impresa CDL-owned ───────────────────────────────────────────────────
// Permette a un utente Palladia appena registrato di "rivendicare" il profilo
// della propria azienda, creato in precedenza dal CDL (owned_by_studio=true).
// Dopo il claim, l'utente diventa owner e può gestire l'azienda autonomamente,
// mentre il CDL mantiene la visibilità tramite studio_clients.
router.post('/studio/claim-company', validate(claimCompanySchema), async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { vat_number } = req.body || {};
  if (!vat_number?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'vat_number obbligatorio' });
  }

  const normalizedVat = vat_number.trim().toUpperCase().replace(/\s/g, '');

  const { data: company } = await supabase
    .from('companies')
    .select('id, name, claimed_at, created_by_studio_id, studio_partners(studio_name)')
    .eq('piva', normalizedVat)
    .not('created_by_studio_id', 'is', null)
    .maybeSingle();

  if (!company) {
    return res.status(404).json({
      error:   'COMPANY_NOT_FOUND',
      message: 'Nessun profilo trovato per questa P.IVA creato da uno studio CDL.',
    });
  }

  if (company.claimed_at) {
    return res.status(409).json({
      error:   'ALREADY_CLAIMED',
      message: 'Questo profilo è già stato rivendicato da un altro utente.',
    });
  }

  const { data: existingMembership } = await supabase
    .from('company_users')
    .select('id')
    .eq('company_id', company.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingMembership) {
    return res.status(409).json({ error: 'ALREADY_MEMBER', message: 'Sei già membro di questa azienda.' });
  }

  const [{ error: cuErr }, { error: clErr }] = await Promise.all([
    supabase.from('company_users').insert({
      company_id: company.id,
      user_id:    user.id,
      role:       'owner',
    }),
    supabase.from('companies')
      .update({ claimed_at: new Date().toISOString() })
      .eq('id', company.id),
  ]);

  if (cuErr || clErr) return res.status(500).json({ error: cuErr?.message || clErr?.message });

  res.json({
    ok:           true,
    company_id:   company.id,
    company_name: company.name,
    studio_name:  company.studio_partners?.studio_name || null,
    message:      `Profilo di ${company.name} rivendicato con successo. Ora puoi gestire la tua azienda su Palladia.`,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// RICHIESTE DOCUMENTI — CDL invia richiesta, cliente carica tramite link pubblico
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/studio/clients/:companyId/document-requests
router.get('/studio/clients/:companyId/document-requests', verifyStudioJwt, async (req, res) => {
  const studio = req.studio;
  const access = await checkStudioAccess(studio.id, req.params.companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { data, error } = await supabase
    .from('studio_document_requests')
    .select('id, title, description, document_type, due_date, status, upload_token, response_url, response_filename, response_notes, reviewer_notes, response_uploaded_at, reviewed_at, created_at')
    .eq('studio_id', studio.id)
    .eq('company_id', req.params.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// POST /api/v1/studio/clients/:companyId/document-requests
router.post('/studio/clients/:companyId/document-requests', verifyStudioJwt, validate(createDocumentRequestSchema), async (req, res) => {
  const studio = req.studio;
  const access = await checkStudioAccess(studio.id, req.params.companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { title, description, document_type, due_date } = req.body || {};
  if (!title || String(title).trim().length < 3) {
    return res.status(400).json({ error: 'TITLE_REQUIRED' });
  }

  const VALID_TYPES = ['durc', 'visura', 'dvr', 'polizza', 'certificato', 'idoneita', 'verbale', 'contratto', 'altro'];
  const safeType = VALID_TYPES.includes(document_type) ? document_type : 'altro';
  const safeDate = due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;

  const { data, error } = await supabase
    .from('studio_document_requests')
    .insert({
      studio_id:     studio.id,
      company_id:    req.params.companyId,
      title:         String(title).trim().slice(0, 200),
      description:   description ? String(description).trim().slice(0, 1000) : null,
      document_type: safeType,
      due_date:      safeDate,
    })
    .select('id, title, document_type, due_date, status, upload_token, created_at')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Invia email al cliente (best-effort)
  try {
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', req.params.companyId)
      .maybeSingle();

    // Recupera email owner/admin dell'impresa
    const { data: members } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', req.params.companyId)
      .in('role', ['owner', 'admin']);

    if (members && members.length > 0) {
      const emails = [];
      for (const m of members) {
        const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id).catch(() => ({ data: {} }));
        if (user?.email) emails.push(user.email);
      }
      if (emails.length > 0) {
        const appUrlBase = (process.env.FRONTEND_URL || 'https://palladia.net').replace(/\/$/, '');
        const { sendDocumentRequestEmail } = require('../../services/email');
        await sendDocumentRequestEmail({
          to:          emails[0],
          studioName:  studio.studio_name,
          companyName: company?.name || 'La tua impresa',
          title:       data.title,
          description: data.description,
          dueDate:     data.due_date,
          uploadUrl:   `${appUrlBase}/studio/upload/${data.upload_token}`,
        });
      }
    }
  } catch (e) {
    console.error('[studio] document-request email error:', e.message);
  }

  res.status(201).json({ ok: true, request: data });
});

// PATCH /api/v1/studio/clients/:companyId/document-requests/:reqId/review
router.patch('/studio/clients/:companyId/document-requests/:reqId/review', verifyStudioJwt, validate(reviewDocumentRequestSchema), async (req, res) => {
  const studio = req.studio;
  const access = await checkStudioAccess(studio.id, req.params.companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { status, reviewer_notes } = req.body || {};
  const VALID = ['reviewed', 'rejected'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });

  const { data, error } = await supabase
    .from('studio_document_requests')
    .update({ status, reviewer_notes: reviewer_notes || null, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.reqId)
    .eq('studio_id', studio.id)
    .eq('company_id', req.params.companyId)
    .select('id, status')
    .single();

  if (error || !data) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ ok: true, request: data });
});

// DELETE /api/v1/studio/clients/:companyId/document-requests/:reqId
router.delete('/studio/clients/:companyId/document-requests/:reqId', verifyStudioJwt, async (req, res) => {
  const studio = req.studio;
  const access = await checkStudioAccess(studio.id, req.params.companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { error } = await supabase
    .from('studio_document_requests')
    .delete()
    .eq('id', req.params.reqId)
    .eq('studio_id', studio.id)
    .eq('company_id', req.params.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

// ── Upload pubblico (cliente carica documento tramite token) ──────────────────
// GET  /api/v1/studio/upload/:token  — info sulla richiesta
// POST /api/v1/studio/upload/:token  — carica URL/filename del documento

router.get('/studio/upload/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('studio_document_requests')
    .select('id, title, description, document_type, due_date, status, studio_id, company_id')
    .eq('upload_token', req.params.token)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  if (data.status !== 'pending') return res.status(409).json({ error: 'ALREADY_UPLOADED', status: data.status });

  // Recupera nome studio e impresa (senza dati sensibili)
  const [studioRes, companyRes] = await Promise.all([
    supabase.from('studio_partners').select('studio_name').eq('id', data.studio_id).maybeSingle(),
    supabase.from('companies').select('name').eq('id', data.company_id).maybeSingle(),
  ]);

  res.json({
    id:            data.id,
    title:         data.title,
    description:   data.description,
    document_type: data.document_type,
    due_date:      data.due_date,
    studio_name:   studioRes.data?.studio_name || '—',
    company_name:  companyRes.data?.name || '—',
  });
});

router.post('/studio/upload/:token', validate(uploadDocumentSchema), async (req, res) => {
  const { response_url, response_filename, response_notes } = req.body || {};
  if (!response_url && !response_filename) {
    return res.status(400).json({ error: 'URL_OR_FILENAME_REQUIRED' });
  }

  const { data, error } = await supabase
    .from('studio_document_requests')
    .update({
      status:               'uploaded',
      response_url:         response_url    || null,
      response_filename:    response_filename || null,
      response_notes:       response_notes  || null,
      response_uploaded_at: new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq('upload_token', req.params.token)
    .eq('status', 'pending')
    .select('id, title, studio_id, company_id')
    .single();

  if (error || !data) return res.status(409).json({ error: 'ALREADY_UPLOADED_OR_NOT_FOUND' });

  // Notifica il CDL
  try {
    const [studioRes, companyRes] = await Promise.all([
      supabase.from('studio_partners').select('studio_name, user_id').eq('id', data.studio_id).maybeSingle(),
      supabase.from('companies').select('name').eq('id', data.company_id).maybeSingle(),
    ]);
    if (studioRes.data?.user_id) {
      const { data: { user } } = await supabase.auth.admin.getUserById(studioRes.data.user_id);
      if (user?.email) {
        const appUrlBase = (process.env.FRONTEND_URL || 'https://palladia.net').replace(/\/$/, '');
        const { sendDocumentUploadedEmail } = require('../../services/email');
        await sendDocumentUploadedEmail({
          to:          user.email,
          studioName:  studioRes.data.studio_name,
          companyName: companyRes.data?.name || '—',
          title:       data.title,
          portalUrl:   `${appUrlBase}/studio`,
        });
      }
    }
  } catch (e) {
    console.error('[studio] upload notify error:', e.message);
  }

  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEAM MANAGEMENT — aggiungi/rimuovi collaboratori dello studio
// (La tabella studio_users esiste già dalla migration 063)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/studio/team
router.get('/studio/team', verifyStudioJwt, async (req, res) => {
  const studio = req.studio;

  const { data, error } = await supabase
    .from('studio_users')
    .select('id, user_id, role, invited_at, joined_at')
    .eq('studio_id', studio.id)
    .order('invited_at');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Arricchisce con email degli utenti
  const members = [];
  for (const m of data || []) {
    let email = null, name = null;
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id);
      email = user?.email || null;
      name  = user?.user_metadata?.full_name || user?.user_metadata?.name || null;
    } catch { /* ignora */ }
    members.push({ ...m, email, name });
  }
  res.json(members);
});

// POST /api/v1/studio/team/invite — invita collaboratore per email
router.post('/studio/team/invite', verifyStudioJwt, validate(inviteTeamMemberSchema), async (req, res) => {
  const studio = req.studio;

  const email = (req.body?.email || '').trim().toLowerCase();
  const role  = ['admin', 'collaborator'].includes(req.body?.role) ? req.body.role : 'collaborator';

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'EMAIL_REQUIRED' });

  // Trova l'utente Palladia con questa email
  const { data: { users } } = await supabase.auth.admin.listUsers({ filter: `email.eq.${email}` }).catch(() => ({ data: { users: [] } }));
  const targetUser = users?.[0];
  if (!targetUser) {
    return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Nessun account Palladia trovato per questa email.' });
  }

  // Evita duplicati
  const { data: existing } = await supabase
    .from('studio_users')
    .select('id')
    .eq('studio_id', studio.id)
    .eq('user_id', targetUser.id)
    .maybeSingle();

  if (existing) return res.status(409).json({ error: 'ALREADY_IN_TEAM' });

  // Evita che il proprietario dello studio inviti sé stesso
  if (targetUser.id === studio.user_id) {
    return res.status(400).json({ error: 'CANNOT_INVITE_SELF' });
  }

  const { data, error } = await supabase
    .from('studio_users')
    .insert({ studio_id: studio.id, user_id: targetUser.id, role })
    .select('id, role, invited_at')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ ok: true, member: { ...data, email, user_id: targetUser.id } });
});

// PATCH /api/v1/studio/team/:memberId/role — modifica ruolo collaboratore
router.patch('/studio/team/:memberId/role', verifyStudioJwt, validate(patchTeamRoleSchema), async (req, res) => {
  const studio = req.studio;
  const role   = req.body?.role;
  if (!['admin', 'collaborator'].includes(role)) return res.status(400).json({ error: 'INVALID_ROLE' });

  const { data, error } = await supabase
    .from('studio_users')
    .update({ role })
    .eq('id', req.params.memberId)
    .eq('studio_id', studio.id)
    .select('id, role')
    .single();

  if (error || !data) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  res.json({ ok: true, member: data });
});

// DELETE /api/v1/studio/team/:memberId — rimuovi collaboratore
router.delete('/studio/team/:memberId', verifyStudioJwt, async (req, res) => {
  const studio = req.studio;

  // Non può rimuovere sé stesso (l'owner)
  const { data: member } = await supabase
    .from('studio_users')
    .select('id, user_id')
    .eq('id', req.params.memberId)
    .eq('studio_id', studio.id)
    .maybeSingle();

  if (!member) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  if (member.user_id === studio.user_id) return res.status(400).json({ error: 'CANNOT_REMOVE_OWNER' });

  const { error } = await supabase
    .from('studio_users')
    .delete()
    .eq('id', req.params.memberId)
    .eq('studio_id', studio.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

// ── DURC Records ─────────────────────────────────────────────────────────────

// GET /api/v1/studio/clients/:companyId/durc — storico DURC
router.get('/studio/clients/:companyId/durc', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { data, error } = await supabase
    .from('durc_records')
    .select('id, issue_date, expiry_date, protocol_number, notes, document_url, created_at')
    .eq('company_id', companyId)
    .order('expiry_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/v1/studio/clients/:companyId/durc — aggiunge DURC
router.post('/studio/clients/:companyId/durc', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { issue_date, expiry_date, protocol_number, notes, document_url } = req.body || {};
  if (!issue_date || !expiry_date) {
    return res.status(400).json({ error: 'issue_date e expiry_date obbligatori' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue_date) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry_date)) {
    return res.status(400).json({ error: 'Date in formato YYYY-MM-DD' });
  }
  if (expiry_date <= issue_date) {
    return res.status(400).json({ error: 'expiry_date deve essere successivo a issue_date' });
  }

  const { data, error } = await supabase
    .from('durc_records')
    .insert({
      company_id:      companyId,
      studio_id:       req.studioId,
      issue_date,
      expiry_date,
      protocol_number: protocol_number?.trim() || null,
      notes:           notes?.trim() || null,
      document_url:    document_url?.trim() || null,
      created_by:      req.studioId,
    })
    .select('id, issue_date, expiry_date, protocol_number, notes, document_url, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  logStudioAction(req.studioId, req.user.id, 'durc.add', { companyId, targetType: 'durc', targetId: data.id });
  res.status(201).json(data);
});

// DELETE /api/v1/studio/clients/:companyId/durc/:id
router.delete('/studio/clients/:companyId/durc/:id', verifyStudioJwt, async (req, res) => {
  const { companyId, id } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId, true);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { error } = await supabase
    .from('durc_records')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// GET /api/v1/studio/durc-overview — tutti i clienti con stato DURC
router.get('/studio/durc-overview', verifyStudioJwt, async (req, res) => {
  const studioId = req.studioId;
  if (!studioId) return res.status(403).json({ error: 'STUDIO_NOT_FOUND' });

  const { data: relations } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name, durc_expiry_date)')
    .eq('studio_id', studioId)
    .eq('status', 'active');

  const allowedIds = new Set(await filterClientsByCollaborator(
    studioId, req.user.id, req.studioRole, (relations || []).map(r => r.company_id)
  ));
  const visibleRelations = (relations || []).filter(r => allowedIds.has(r.company_id));

  const today  = new Date().toISOString().slice(0, 10);
  const in30   = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const in90   = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  const rows = visibleRelations.map(r => {
    const co  = r.companies;
    const exp = co?.durc_expiry_date || null;
    let status = 'missing';
    if (exp) {
      if (exp < today)  status = 'expired';
      else if (exp < in30) status = 'expiring_30';
      else if (exp < in90) status = 'expiring_90';
      else status = 'ok';
    }
    return {
      company_id:     co?.id,
      company_name:   co?.name,
      durc_expiry_date: exp,
      status,
    };
  });

  // Ordine: scaduti → scadenza 30gg → scadenza 90gg → mancante → ok
  const ORDER = { expired: 0, expiring_30: 1, expiring_90: 2, missing: 3, ok: 4 };
  rows.sort((a, b) => {
    const diff = (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5);
    if (diff !== 0) return diff;
    if (a.durc_expiry_date && b.durc_expiry_date) return a.durc_expiry_date.localeCompare(b.durc_expiry_date);
    return 0;
  });

  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Alert configurabili
// ═══════════════════════════════════════════════════════════════════════════════

const ALERT_TYPES = ['cert_expiry', 'health_expiry', 'durc_expiry', 'dvr_age', 'riunione', 'safety_role'];

router.get('/studio/alert-config', verifyStudioJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('studio_alert_config')
    .select('*')
    .eq('studio_id', req.studioId)
    .order('alert_type');
  if (error) return res.status(500).json({ error: error.message });

  const configMap = Object.fromEntries((data || []).map(c => [c.alert_type, c]));
  const result = ALERT_TYPES.map(t => configMap[t] || {
    alert_type: t, warn_days: 60, critical_days: 30, enabled: true,
  });
  res.json(result);
});

router.put('/studio/alert-config', verifyStudioJwt, async (req, res) => {
  const configs = req.body;
  if (!Array.isArray(configs)) return res.status(400).json({ error: 'Array di configurazioni richiesto' });

  const rows = configs.filter(c => ALERT_TYPES.includes(c.alert_type)).map(c => ({
    studio_id:     req.studioId,
    alert_type:    c.alert_type,
    warn_days:     Math.max(1, Number(c.warn_days) || 60),
    critical_days: Math.max(1, Number(c.critical_days) || 30),
    enabled:       c.enabled !== false,
  }));

  const { error } = await supabase
    .from('studio_alert_config')
    .upsert(rows, { onConflict: 'studio_id,alert_type' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, updated: rows.length });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Audit log azioni studio
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/studio/audit-log', verifyStudioJwt, async (req, res) => {
  const { company_id, action, limit: lim } = req.query;
  let q = supabase
    .from('studio_audit_log')
    .select('*')
    .eq('studio_id', req.studioId)
    .order('created_at', { ascending: false })
    .limit(Number(lim) || 200);

  if (company_id) q = q.eq('company_id', company_id);
  if (action)     q = q.eq('action', action);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Permessi collaboratori per cliente
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/studio/team/assignments', verifyStudioJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('studio_user_clients')
    .select('id, user_id, company_id, assigned_at')
    .eq('studio_id', req.studioId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/studio/team/assignments', verifyStudioJwt, async (req, res) => {
  if (req.studioRole !== 'owner' && req.studioRole !== 'admin') {
    return res.status(403).json({ error: 'Solo owner/admin possono assegnare collaboratori' });
  }
  const { user_id, company_id } = req.body;
  if (!user_id || !company_id) return res.status(400).json({ error: 'user_id e company_id obbligatori' });

  const { data: member } = await supabase
    .from('studio_users').select('id').eq('studio_id', req.studioId).eq('user_id', user_id).maybeSingle();
  if (!member) return res.status(400).json({ error: 'Utente non è membro dello studio' });

  const { error } = await supabase
    .from('studio_user_clients')
    .insert({ studio_id: req.studioId, user_id, company_id });
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Assegnazione già esistente' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ ok: true });
});

router.delete('/studio/team/assignments/:id', verifyStudioJwt, async (req, res) => {
  if (req.studioRole !== 'owner' && req.studioRole !== 'admin') {
    return res.status(403).json({ error: 'Solo owner/admin possono rimuovere assegnazioni' });
  }
  const { error } = await supabase
    .from('studio_user_clients')
    .delete()
    .eq('id', req.params.id)
    .eq('studio_id', req.studioId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Calendario ICS — feed scadenze
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/studio/scadenziario.ics', verifyStudioJwt, async (req, res) => {
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    return res.send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Palladia//Studio CDL//IT\r\nEND:VCALENDAR');
  }

  // Filtra per collaboratore assegnato
  const allIds = clients.map(c => c.company_id);
  const filteredIds = await filterClientsByCollaborator(req.studioId, req.user.id, req.studioRole, allIds);

  const companyIds = filteredIds;
  const companyMap = Object.fromEntries(clients.map(c => [c.company_id, c.companies?.name || '—']));
  const in90Str    = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  const [{ data: certs }, { data: health }, { data: companies }] = await Promise.all([
    supabase.from('worker_certificates')
      .select('company_id, course_name, worker:workers(full_name), expiry_date')
      .in('company_id', companyIds).lte('expiry_date', in90Str).is('deleted_at', null),
    supabase.from('workers')
      .select('company_id, full_name, health_fitness_expiry')
      .in('company_id', companyIds).lte('health_fitness_expiry', in90Str).eq('is_active', true),
    supabase.from('companies')
      .select('id, durc_expiry_date')
      .in('id', companyIds).lte('durc_expiry_date', in90Str),
  ]);

  const fmtDate = d => d.replace(/-/g, '');
  const events = [];

  for (const c of (certs || [])) {
    if (!c.expiry_date) continue;
    events.push({
      uid:     `cert-${c.company_id}-${c.expiry_date}-${(c.worker?.full_name||'').slice(0,10)}`,
      date:    fmtDate(c.expiry_date),
      summary: `Scad. ${c.course_name} — ${c.worker?.full_name || ''}`,
      desc:    `Impresa: ${companyMap[c.company_id]}`,
    });
  }
  for (const w of (health || [])) {
    if (!w.health_fitness_expiry) continue;
    events.push({
      uid:     `health-${w.company_id}-${w.health_fitness_expiry}-${(w.full_name||'').slice(0,10)}`,
      date:    fmtDate(w.health_fitness_expiry),
      summary: `Scad. idoneità — ${w.full_name}`,
      desc:    `Impresa: ${companyMap[w.company_id]}`,
    });
  }
  for (const co of (companies || [])) {
    if (!co.durc_expiry_date) continue;
    events.push({
      uid:     `durc-${co.id}-${co.durc_expiry_date}`,
      date:    fmtDate(co.durc_expiry_date),
      summary: `Scad. DURC — ${companyMap[co.id]}`,
      desc:    '',
    });
  }

  const icsEvents = events.map(e => [
    'BEGIN:VEVENT',
    `UID:${e.uid}@palladia.app`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,
    `DTSTART;VALUE=DATE:${e.date}`,
    `SUMMARY:${e.summary}`,
    e.desc ? `DESCRIPTION:${e.desc}` : '',
    'END:VEVENT',
  ].filter(Boolean).join('\r\n')).join('\r\n');

  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Palladia//Studio CDL//IT\r\nX-WR-CALNAME:Scadenze Palladia\r\n${icsEvents}\r\nEND:VCALENDAR`;

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="scadenze-palladia.ics"');
  res.send(ics);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Export ore/presenze per cedolini (payroll)
// ═══════════════════════════════════════════════════════════════════════════════

// Un consulente del lavoro deve poter distinguere una timbratura reale da una
// generata dal sistema o corretta a mano — vedi services/workerHoursReport.js.
const METHOD_NOTE = {
  admin_manual_correction:  'Corretto manualmente',
  auto_exit_on_site_change: 'Uscita auto (cambio cantiere)',
};

router.get('/studio/clients/:companyId/ore-mensili', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;
  const access = await checkStudioAccess(req.studioId, companyId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const { month } = req.query; // YYYY-MM
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month obbligatorio (YYYY-MM)' });
  }

  const from = `${month}-01`;
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;

  // Finestra allargata di 1 giorno intero su ciascun lato (oltre al consueto
  // +02:00/+01:00 invece di Z): permette di accoppiare correttamente anche un
  // turno a cavallo del bordo mese — il pairing avviene su tutto lo stream
  // cronologico del lavoratore (lib/presencePairing.js), poi si scartano i
  // giorni fuori dal mese richiesto.
  const fetchFrom = shiftDateStr(from, -1);
  const fetchTo   = shiftDateStr(to, 1);
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select('worker_id, event_type, timestamp_server, site_id, method, workers(full_name, fiscal_code)')
    .eq('company_id', companyId)
    .gte('timestamp_server', `${fetchFrom}T00:00:00+02:00`)
    .lte('timestamp_server', `${fetchTo}T23:59:59.999+01:00`)
    .order('worker_id').order('timestamp_server')
    .limit(50000);

  if (logsErr) return res.status(500).json({ error: logsErr.message });

  // Raggruppa per worker (stream cronologico completo, cross-giorno)
  const byWorker = new Map();
  for (const log of (logs || [])) {
    if (!log.workers) continue;
    if (!byWorker.has(log.worker_id)) {
      byWorker.set(log.worker_id, {
        full_name: log.workers.full_name,
        fiscal_code: log.workers.fiscal_code,
        logs: [],
      });
    }
    byWorker.get(log.worker_id).logs.push(log);
  }

  const results = [];
  for (const [workerId, worker] of byWorker) {
    const dayMap = pairLogsByDay(worker.logs);   // ← accoppia PRIMA, sull'intero stream
    let totalMinutes = 0;
    let totalDays = 0;
    const dayDetails = [];

    for (const [dateKey, { pairs }] of dayMap) {
      if (dateKey.slice(0, 7) !== month) continue;   // fuori dal mese richiesto

      let dayMinutes = 0;
      let dayNote = null;
      for (const { entry, exit } of pairs) {
        dayMinutes += (new Date(exit.timestamp_server) - new Date(entry.timestamp_server)) / 60000;
        dayNote = dayNote || METHOD_NOTE[exit.method] || METHOD_NOTE[entry.method] || null;
      }

      if (dayMinutes > 0) {
        totalDays++;
        totalMinutes += dayMinutes;
        dayDetails.push({ date: dateKey, hours: Math.round(dayMinutes / 60 * 100) / 100, note: dayNote });
      }
    }

    results.push({
      worker_id:   workerId,
      full_name:   worker.full_name,
      fiscal_code: worker.fiscal_code,
      total_hours: Math.round(totalMinutes / 60 * 100) / 100,
      total_days:  totalDays,
      days:        dayDetails,
    });
  }

  results.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  // CSV export
  if (req.query.format === 'csv') {
    const header = 'Cognome e Nome,Codice Fiscale,Ore Totali,Giorni Lavorati';
    const rows = results.map(r =>
      `"${(r.full_name||'').replace(/"/g,'""')}","${r.fiscal_code || ''}","${r.total_hours}","${r.total_days}"`
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ore_${month}_${companyId.slice(0,8)}.csv"`);
    return res.send('﻿' + [header, ...rows].join('\r\n'));
  }

  // CSV dettagliato (giorno per giorno)
  if (req.query.format === 'csv-detail') {
    const header = 'Cognome e Nome,Codice Fiscale,Data,Ore,Nota';
    const rows = [];
    for (const r of results) {
      for (const d of r.days) {
        rows.push(`"${(r.full_name||'').replace(/"/g,'""')}","${r.fiscal_code || ''}","${d.date}","${d.hours}","${d.note || ''}"`);
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ore_dettaglio_${month}_${companyId.slice(0,8)}.csv"`);
    return res.send('﻿' + [header, ...rows].join('\r\n'));
  }

  res.json({ month, company_id: companyId, workers: results, total_workers: results.length });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE: Dashboard CSV export
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/studio/dashboard.csv', verifyStudioJwt, async (req, res) => {
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name, durc_expiry_date)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('﻿Nessun cliente attivo');
  }

  const allCompanyIds = clients.map(c => c.company_id);
  const companyIds    = await filterClientsByCollaborator(req.studioId, req.user.id, req.studioRole, allCompanyIds);
  const visibleClients = clients.filter(c => companyIds.includes(c.company_id));

  const [{ data: sites }, { data: workers }] = await Promise.all([
    supabase.from('sites').select('company_id')
      .in('company_id', companyIds).eq('status', 'attivo'),
    supabase.from('workers').select('company_id')
      .in('company_id', companyIds).eq('is_active', true),
  ]);

  const sitesPerCo   = {};
  const workersPerCo = {};
  for (const s of (sites || []))   sitesPerCo[s.company_id]   = (sitesPerCo[s.company_id]   || 0) + 1;
  for (const w of (workers || [])) workersPerCo[w.company_id] = (workersPerCo[w.company_id] || 0) + 1;

  const header = 'Impresa,DURC Scadenza,Stato DURC,Cantieri,Lavoratori';
  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = visibleClients.map(c => {
    const co = c.companies;
    const exp = co?.durc_expiry_date;
    let stato = 'Mancante';
    if (exp) {
      if (exp < todayStr) stato = 'Scaduto';
      else if (exp < new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)) stato = 'In scadenza';
      else stato = 'Valido';
    }
    return `"${(co?.name||'').replace(/"/g,'""')}","${exp || ''}","${stato}","${sitesPerCo[c.company_id] || 0}","${workersPerCo[c.company_id] || 0}"`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clienti_studio_${todayStr}.csv"`);
  res.send('﻿' + [header, ...rows].join('\r\n'));
});

module.exports = router;
