'use strict';
/**
 * routes/v1/consultantProfile.js
 * Onboarding e gestione profilo consulente RSPP + relazioni con imprese clienti.
 *
 * POST /api/v1/consultant/onboard                       — crea/completa profilo (step 1-2)
 * GET  /api/v1/consultant/me                            — legge profilo proprio
 * PUT  /api/v1/consultant/me                            — aggiorna profilo
 * GET  /api/v1/consultant/clients                       — lista imprese clienti
 * POST /api/v1/consultant/clients/invite                — invita impresa per companyId o email
 * PUT  /api/v1/consultant/clients/:id                   — aggiorna relazione (stato, permessi)
 * GET  /api/v1/consultant/clients/:companyId/formazione — vista read-only formazione impresa
 * POST /api/v1/consultant/clients/accept/:token         — impresa accetta invito consulente
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const supabase = require('../../lib/supabase');
const { verifyConsultantJwt, verifyConsultantOrCreate } = require('../../middleware/verifyConsultant');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// ── POST /api/v1/consultant/onboard ───────────────────────────────────────────

router.post('/consultant/onboard', verifyConsultantOrCreate, async (req, res) => {
  const {
    company_name, vat_number, registration_number, operative_regions,
    bio, photo_url, accreditation_bodies, years_experience,
  } = req.body || {};

  if (!company_name && !req.consultant) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'company_name obbligatorio al primo onboarding' });
  }

  const upsertData = {
    user_id:               req.user.id,
    company_name:          company_name?.trim(),
    vat_number:            vat_number?.trim() || null,
    registration_number:   registration_number?.trim() || null,
    operative_regions:     operative_regions || [],
    bio:                   bio?.trim() || null,
    photo_url:             photo_url || null,
    accreditation_bodies:  accreditation_bodies || [],
    years_experience:      years_experience || null,
    onboarding_completed:  true,
  };

  // Rimuove i null per non sovrascrivere campi esistenti
  Object.keys(upsertData).forEach(k => {
    if (upsertData[k] === undefined) delete upsertData[k];
  });

  const { data, error } = await supabase
    .from('consultant_profiles')
    .upsert(upsertData, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ profile: data });
});

// ── GET /api/v1/consultant/me ─────────────────────────────────────────────────

router.get('/consultant/me', verifyConsultantJwt, async (req, res) => {
  res.json({ profile: req.consultant });
});

// ── PUT /api/v1/consultant/me ─────────────────────────────────────────────────

router.put('/consultant/me', verifyConsultantJwt, async (req, res) => {
  const allowed = [
    'company_name','vat_number','registration_number','operative_regions',
    'bio','photo_url','accreditation_bodies','years_experience',
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('consultant_profiles')
    .update(updates)
    .eq('user_id', req.consultantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ profile: data });
});

// ── GET /api/v1/consultant/clients ────────────────────────────────────────────

router.get('/consultant/clients', verifyConsultantJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('consultant_clients')
    .select(`
      id, status, invited_at, accepted_at, invite_email,
      can_view_workers, can_view_certificates, can_view_sites,
      companies ( id, name )
    `)
    .eq('consultant_id', req.consultantId)
    .order('invited_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Per ogni cliente attivo aggiungi contatori rapidi
  const clientIds = (data || []).filter(c => c.status === 'active' && c.companies).map(c => c.companies.id);

  let workerCounts = {};
  let expiringCounts = {};

  if (clientIds.length > 0) {
    // Conta lavoratori attivi per impresa
    const { data: wc } = await supabase
      .from('workers')
      .select('company_id')
      .in('company_id', clientIds)
      .eq('is_active', true);

    for (const w of wc || []) {
      workerCounts[w.company_id] = (workerCounts[w.company_id] || 0) + 1;
    }

    // Conta attestati in scadenza entro 30 giorni
    const in30 = new Date(); in30.setDate(in30.getDate() + 30);
    const { data: ec } = await supabase
      .from('worker_certificates')
      .select('company_id')
      .in('company_id', clientIds)
      .lte('expiry_date', in30.toISOString().slice(0, 10))
      .gte('expiry_date', new Date().toISOString().slice(0, 10));

    for (const e of ec || []) {
      expiringCounts[e.company_id] = (expiringCounts[e.company_id] || 0) + 1;
    }
  }

  const enriched = (data || []).map(c => ({
    ...c,
    workers_count:    c.companies ? (workerCounts[c.companies.id] || 0)   : 0,
    expiring_count:   c.companies ? (expiringCounts[c.companies.id] || 0) : 0,
  }));

  res.json({ clients: enriched });
});

// ── POST /api/v1/consultant/clients/invite ────────────────────────────────────

router.post('/consultant/clients/invite', verifyConsultantJwt, async (req, res) => {
  const { company_id, invite_email } = req.body || {};

  if (!company_id && !invite_email) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'company_id o invite_email obbligatorio' });
  }

  const token = crypto.randomBytes(24).toString('hex');

  const row = {
    consultant_id: req.consultantId,
    invite_token:  token,
    status:        'pending',
  };

  if (company_id) {
    // Verifica che l'azienda esista
    const { data: co } = await supabase.from('companies').select('id, name').eq('id', company_id).maybeSingle();
    if (!co) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
    row.company_id = company_id;
  } else {
    row.invite_email = invite_email.toLowerCase().trim();
  }

  const { data, error } = await supabase
    .from('consultant_clients')
    .insert(row)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'ALREADY_INVITED' });
    return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  }

  // TODO: invia email di invito (quando email template pronto)
  res.status(201).json({ client: data, invite_link: `${process.env.FRONTEND_URL || ''}/formazione/accetta-consulente/${token}` });
});

// ── PUT /api/v1/consultant/clients/:id ────────────────────────────────────────

router.put('/consultant/clients/:id', verifyConsultantJwt, async (req, res) => {
  const { id } = req.params;
  const allowed = ['status','can_view_workers','can_view_certificates','can_view_sites'];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('consultant_clients')
    .update(updates)
    .eq('id', id)
    .eq('consultant_id', req.consultantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ client: data });
});

// ── GET /api/v1/consultant/clients/:companyId/formazione ──────────────────────

router.get('/consultant/clients/:companyId/formazione', verifyConsultantJwt, async (req, res) => {
  const { companyId } = req.params;

  // Verifica relazione attiva
  const { data: rel } = await supabase
    .from('consultant_clients')
    .select('id, can_view_certificates, can_view_workers')
    .eq('consultant_id', req.consultantId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();

  if (!rel)                    return res.status(403).json({ error: 'NOT_AUTHORIZED' });
  if (!rel.can_view_certificates) return res.status(403).json({ error: 'NO_CERT_PERMISSION' });

  // Riusa la stessa logica di certificates.js dashboard
  const { data: workers } = await supabase
    .from('workers')
    .select('id, full_name, photo_url')
    .eq('company_id', companyId)
    .eq('is_active', true);

  const workerIds = (workers || []).map(w => w.id);

  const { data: certs } = await supabase
    .from('worker_certificates')
    .select(`
      id, worker_id, expiry_date, issue_date, issuing_body,
      course_types ( name, validity_years, risk_level )
    `)
    .eq('company_id', companyId)
    .in('worker_id', workerIds.length > 0 ? workerIds : ['00000000-0000-0000-0000-000000000000']);

  function certStatus(exp) {
    const d = Math.floor((new Date(exp) - Date.now()) / 86_400_000);
    if (d < 0)   return 'scaduto';
    if (d < 30)  return 'critico';
    if (d < 90)  return 'in_scadenza';
    return 'valido';
  }

  const certsByWorker = {};
  for (const c of certs || []) {
    if (!certsByWorker[c.worker_id]) certsByWorker[c.worker_id] = [];
    certsByWorker[c.worker_id].push({
      ...c,
      status:    certStatus(c.expiry_date),
      days_left: Math.floor((new Date(c.expiry_date) - Date.now()) / 86_400_000),
    });
  }

  const stats = { scaduti: 0, critici: 0, in_scadenza: 0, validi: 0 };
  const result = (workers || []).map(w => {
    const wc = certsByWorker[w.id] || [];
    for (const c of wc) {
      if (c.status === 'scaduto')      stats.scaduti++;
      else if (c.status === 'critico') stats.critici++;
      else if (c.status === 'in_scadenza') stats.in_scadenza++;
      else stats.validi++;
    }
    return { ...w, certificates: wc.sort((a, b) => a.days_left - b.days_left) };
  }).sort((a, b) => {
    const order = { scaduto: 0, critico: 1, in_scadenza: 2, valido: 3 };
    const wa = a.certificates.reduce((acc, c) => Math.min(acc, order[c.status] ?? 3), 3);
    const wb = b.certificates.reduce((acc, c) => Math.min(acc, order[c.status] ?? 3), 3);
    return wa - wb;
  });

  res.json({ stats, workers: result });
});

// ── POST /api/v1/consultant/clients/accept/:token ─────────────────────────────
// Chiamato dall'impresa (JWT impresa) per accettare l'invito del consulente

router.post('/consultant/clients/accept/:token', verifySupabaseJwt, async (req, res) => {
  const { token } = req.params;

  const { data: rel } = await supabase
    .from('consultant_clients')
    .select('id, status, company_id')
    .eq('invite_token', token)
    .maybeSingle();

  if (!rel) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
  if (rel.status === 'active') return res.json({ ok: true, already_active: true });

  // Verifica che chi accetta sia un membro dell'azienda (già fatto da verifySupabaseJwt)
  if (rel.company_id && rel.company_id !== req.companyId) {
    return res.status(403).json({ error: 'WRONG_COMPANY' });
  }

  const { error } = await supabase
    .from('consultant_clients')
    .update({
      status:      'active',
      accepted_at: new Date().toISOString(),
      company_id:  req.companyId,
    })
    .eq('id', rel.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
