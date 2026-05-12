'use strict';
/**
 * routes/v1/studio.js
 * Portale Studio CDL Partner — Consulenti del Lavoro che gestiscono N imprese clienti.
 *
 * POST /api/v1/studio/onboard                             — crea/aggiorna profilo studio
 * GET  /api/v1/studio/me                                  — profilo studio corrente
 * PUT  /api/v1/studio/me                                  — aggiorna profilo studio
 * GET  /api/v1/studio/clients                             — lista imprese clienti (attive + pending)
 * POST /api/v1/studio/clients/invite                      — invita impresa per P.IVA + email (o company_id legacy)
 * POST /api/v1/studio/clients/accept/:token               — impresa Palladia accetta invito
 * POST /api/v1/studio/pending-invites/accept/:token       — nuova impresa accetta invito pending
 * GET  /api/v1/studio/clients/:companyId                  — dettaglio impresa cliente
 * GET  /api/v1/studio/clients/:companyId/report-vigilanza.pdf — PDF report vigilanza
 * DELETE /api/v1/studio/clients/:companyId                — rimuovi relazione
 * GET  /api/v1/studio/dashboard                           — dashboard aggregato con semaforo
 * POST /api/v1/studio/digest/preview                      — anteprima digest (test/manuale)
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
    .select('*')
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
