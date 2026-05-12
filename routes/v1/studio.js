'use strict';
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

router.post('/studio/onboard', verifyStudioOrCreate, async (req, res) => {
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

router.get('/studio/me', verifyStudioJwt, async (req, res) => {
  res.json({ studio: req.studio });
});

router.put('/studio/me', verifyStudioJwt, async (req, res) => {
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
router.post('/studio/clients/invite', verifyStudioJwt, async (req, res) => {
  const {
    company_id,     // legacy — UUID diretto
    vat_number,     // P.IVA — cerca per corrispondenza
    contact_email,  // email del titolare/contatto
    contact_name,   // nome del contatto (opzionale)
    company_name,   // nome azienda (opzionale, per pending invite)
  } = req.body || {};

  const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://palladia-kappa.vercel.app').replace(/\/$/, '');

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

  const now  = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);

  const [
    { data: company },
    { data: sites },
    { data: workers },
    { data: dvrs },
    { data: subcontractors },
    { data: certs },
    { data: subDocs },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, status, address').eq('company_id', companyId).neq('status', 'chiuso').order('created_at', { ascending: false }),
    supabase.from('workers').select('id, full_name, fiscal_code, is_active').eq('company_id', companyId).eq('is_active', true).limit(300),
    supabase.from('dvr_documents').select('id, revision, dvr_data, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(5),
    supabase.from('subcontractors').select('id, company_name, status, piva').eq('company_id', companyId),
    supabase.from('worker_certificates').select('id, worker_id, expiry_date, course_types(name), workers(full_name)').eq('company_id', companyId).order('expiry_date', { ascending: true }).limit(200),
    supabase.from('subcontractor_documents').select('id, company_id, doc_type, valid_until').eq('company_id', companyId).limit(50),
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

  const hasIssues = expiredCerts.length > 0 || (!latestDvr && (workers || []).length > 0);
  const semaforo  = hasIssues ? 'rosso' : soonCerts.length > 0 ? 'giallo' : 'verde';
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
      <div class="brand">Palladia — Report Vigilanza</div>
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
router.post('/studio/clients/create-direct', verifyStudioJwt, async (req, res) => {
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

  res.status(201).json({ company, client });
});

// ── Aggiorna profilo impresa CDL-owned ────────────────────────────────────────
router.put('/studio/clients/:companyId/profile', verifyStudioJwt, async (req, res) => {
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
    .select('id, full_name, fiscal_code, is_active, created_at')
    .eq('company_id', companyId)
    .order('full_name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ workers: data || [], owned_by_studio: access.isOwner });
});

router.post('/studio/clients/:companyId/workers', verifyStudioJwt, async (req, res) => {
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
  res.status(201).json({ worker: data });
});

router.put('/studio/clients/:companyId/workers/:workerId', verifyStudioJwt, async (req, res) => {
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
    .order('expiry_date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ certificates: data || [], owned_by_studio: access.isOwner });
});

router.post('/studio/clients/:companyId/certificates', verifyStudioJwt, async (req, res) => {
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
  res.status(201).json({ certificate: data });
});

router.put('/studio/clients/:companyId/certificates/:certId', verifyStudioJwt, async (req, res) => {
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
    .delete()
    .eq('id', certId)
    .eq('company_id', companyId);

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
router.post('/studio/clients/:companyId/import-csv', verifyStudioJwt, async (req, res) => {
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
      if (!results._existingWorkers?.includes(fiscal_code.toUpperCase())) results.workers_created++;

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
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('studio_partners').select('*').eq('id', req.studioId).maybeSingle(),
    supabase.from('worker_certificates')
      .select('id, expiry_date, issue_date, issuing_body, workers(full_name, fiscal_code), course_types(name, validity_years)')
      .eq('company_id', companyId)
      .lt('expiry_date', in60.toISOString().slice(0, 10))
      .order('expiry_date', { ascending: true })
      .limit(100),
  ]);

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtDateLong(d) {
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const expired  = (certs || []).filter(c => new Date(c.expiry_date) < now);
  const expiring = (certs || []).filter(c => new Date(c.expiry_date) >= now);

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
      <div class="studio-sub">Studio di Consulenza del Lavoro${studio?.registration_number ? ' · Albo n. ' + studio.registration_number : ''}</div>
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

  ${(certs || []).length > 0 ? `
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
    <tbody>${(certs || []).map(certRow).join('')}</tbody>
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
    .select('company_id, companies(id, name)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) {
    return res.json({
      clients: [],
      alerts:  [],
      summary: { total: 0, verde: 0, giallo: 0, rosso: 0 },
    });
  }

  const companyIds = clients.map(c => c.company_id);
  const now    = new Date();
  const in30   = new Date(now.getTime() + 30 * 86400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86400_000);

  // Fetch parallelo di tutti i dati necessari
  const [
    { data: sites        },
    { data: workers      },
    { data: dvrs         },
    { data: certExpired  },
    { data: certSoon     },
    { data: subDocs      },
  ] = await Promise.all([
    supabase.from('sites').select('id, company_id').in('company_id', companyIds).neq('status', 'chiuso'),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true),
    supabase.from('dvr_documents').select('id, company_id, created_at').in('company_id', companyIds).order('created_at', { ascending: false }),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds).lt('expiry_date', now.toISOString().slice(0,10)),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds)
      .gte('expiry_date', now.toISOString().slice(0,10)).lt('expiry_date', in30.toISOString().slice(0,10)),
    supabase.from('subcontractor_documents').select('id, company_id, valid_until').in('company_id', companyIds),
  ]);

  // Inizializza metriche per ogni impresa
  const metrics = {};
  for (const c of clients) {
    metrics[c.company_id] = {
      company_id:               c.company_id,
      company_name:             c.companies.name,
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
// Permette di inviare il digest settimanale on-demand (pulsante nel portale CDL).
router.post('/studio/digest/send-now', verifyStudioJwt, async (req, res) => {
  const { runStudioDigest } = require('../../services/studioDigestCron');
  // Esegui solo per questo studio
  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);

  try {
    // processStudio non è esportata — usiamo runStudioDigest filtrato
    // Alternativa semplice: restituiamo i dati al frontend senza inviare email
    const { data: clients } = await supabase
      .from('studio_clients')
      .select('company_id, companies(id, name)')
      .eq('studio_id', req.studioId)
      .eq('status', 'active');

    if (!clients?.length) return res.json({ sent: false, reason: 'Nessun cliente attivo' });

    const companyIds = clients.map(c => c.company_id);
    const [
      { data: certExpired },
      { data: certSoon },
      { data: dvrs },
      { data: workers },
    ] = await Promise.all([
      supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds).lt('expiry_date', now.toISOString().slice(0, 10)),
      supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds)
        .gte('expiry_date', now.toISOString().slice(0, 10)).lt('expiry_date', in30.toISOString().slice(0, 10)),
      supabase.from('dvr_documents').select('id, company_id, created_at').in('company_id', companyIds).order('created_at', { ascending: false }),
      supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true),
    ]);

    const metrics = {};
    for (const c of clients) metrics[c.company_id] = { company_name: c.companies.name, workers: 0, dvr: false, alerts: [] };
    for (const w of workers || []) if (metrics[w.company_id]) metrics[w.company_id].workers++;
    const latestDvr = {};
    for (const d of dvrs || []) if (!latestDvr[d.company_id]) latestDvr[d.company_id] = d;
    for (const [cid, dvr] of Object.entries(latestDvr)) {
      if (!metrics[cid]) continue;
      metrics[cid].dvr = true;
      if (new Date(dvr.created_at) < oneYearAgo) metrics[cid].alerts.push({ type: 'dvr_old', message: 'DVR non aggiornato da oltre 12 mesi', severity: 'warning' });
    }
    for (const c of certExpired || []) if (metrics[c.company_id]) metrics[c.company_id].alerts.push({ type: 'cert_expired', message: 'Attestato scaduto', severity: 'critical' });
    for (const c of certSoon   || []) if (metrics[c.company_id]) metrics[c.company_id].alerts.push({ type: 'cert_expiring', message: 'Attestato in scadenza', severity: 'warning' });
    for (const m of Object.values(metrics)) {
      if (!m.dvr && m.workers > 0) m.alerts.push({ type: 'dvr_missing', message: 'DVR assente', severity: 'critical' });
      m.alerts = [...new Map(m.alerts.map(a => [a.type, a])).values()];
      m.semaforo = m.alerts.some(a => a.severity === 'critical') ? 'rosso' : m.alerts.some(a => a.severity === 'warning') ? 'giallo' : 'verde';
    }

    const summary = {
      total:  Object.keys(metrics).length,
      verde:  Object.values(metrics).filter(m => m.semaforo === 'verde').length,
      giallo: Object.values(metrics).filter(m => m.semaforo === 'giallo').length,
      rosso:  Object.values(metrics).filter(m => m.semaforo === 'rosso').length,
    };
    const issues = Object.entries(metrics).flatMap(([cid, m]) =>
      m.alerts.map(a => ({ ...a, company_id: cid, company_name: m.company_name }))
    );

    const { sendStudioWeeklyDigest } = require('../../services/email');
    const { data: { user: owner } } = await supabase.auth.admin.getUserById(req.user.id);
    if (owner?.email) {
      await sendStudioWeeklyDigest({ to: owner.email, studioName: req.studio.studio_name, summary, issues });
    }

    res.json({ sent: true, summary, issues_count: issues.length });
  } catch (err) {
    console.error('[studio] digest/send-now errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
