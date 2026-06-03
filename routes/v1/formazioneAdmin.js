'use strict';
/**
 * routes/v1/formazioneAdmin.js
 * Admin Formazione — visibile solo a utenti con email in SUPER_ADMIN_EMAILS.
 *
 * GET    /api/v1/admin/providers                         — lista enti
 * POST   /api/v1/admin/providers                         — crea ente
 * PUT    /api/v1/admin/providers/:id                     — modifica ente
 * POST   /api/v1/admin/providers/:id/courses             — aggiungi corso
 * PUT    /api/v1/admin/courses/:id                       — modifica corso
 * POST   /api/v1/admin/courses/:id/sessions              — aggiungi sessione
 * GET    /api/v1/admin/bookings                          — tutte le prenotazioni
 * PATCH  /api/v1/admin/bookings/:id/complete             — segna completato + carica attestato
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendProviderApprovedEmail } = require('../../services/email');
const { syncToFormazione } = require('../../services/documentAI');
const { validate } = require('../../middleware/validate');
const {
  createAdminProviderSchema,
  putAdminProviderSchema,
  createAdminCourseSchema,
  putAdminCourseSchema,
  createAdminSessionSchema,
  completeAdminBookingSchema,
} = require('../../lib/schemas/formazioneAdmin');

// ── Super-admin guard ─────────────────────────────────────────────────────────

const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function isSuperAdmin(req) {
  return SUPER_ADMIN_EMAILS.includes(req.user?.email?.toLowerCase());
}

router.use(verifySupabaseJwt);

router.use((req, res, next) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Accesso riservato al team Palladia' });
  next();
});

// ── GET /api/v1/admin/providers ───────────────────────────────────────────────

router.get('/admin/providers', async (req, res) => {
  const { data, error } = await supabase
    .from('training_providers')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ providers: data || [] });
});

// ── POST /api/v1/admin/providers ──────────────────────────────────────────────

router.post('/admin/providers', validate(createAdminProviderSchema), async (req, res) => {
  const {
    name, description, logo_url, location_city, location_province, address,
    phone, email, website, accreditation_code, accreditation_region,
    is_featured, commission_rate,
  } = req.body || {};

  if (!name || !location_city || !location_province || !email) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  const { data, error } = await supabase
    .from('training_providers')
    .insert({
      name, description, logo_url, location_city, location_province, address,
      phone, email, website, accreditation_code, accreditation_region,
      is_featured: is_featured || false,
      commission_rate: commission_rate || 15,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'EMAIL_DUPLICATE' });
    return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  }
  res.status(201).json({ provider: data });
});

// ── PUT /api/v1/admin/providers/:id ──────────────────────────────────────────

router.put('/admin/providers/:id', validate(putAdminProviderSchema), async (req, res) => {
  const { id } = req.params;
  const allowed = [
    'name','description','logo_url','location_city','location_province','address',
    'phone','email','website','accreditation_code','accreditation_region',
    'is_featured','is_active','commission_rate','rating','total_reviews',
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('training_providers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ provider: data });
});

// ── PATCH /api/v1/admin/providers/:id/approve ─────────────────────────────────

router.patch('/admin/providers/:id/approve', async (req, res) => {
  const { id } = req.params;

  const { data: provider, error: fetchErr } = await supabase
    .from('training_providers')
    .select('id, name, email, is_active')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!provider) return res.status(404).json({ error: 'NOT_FOUND' });
  if (provider.is_active) return res.status(400).json({ error: 'ALREADY_ACTIVE', message: 'Provider già attivo' });

  const { error: updateErr } = await supabase
    .from('training_providers')
    .update({ is_active: true })
    .eq('id', id);

  if (updateErr) return res.status(500).json({ error: 'DB_ERROR', detail: updateErr.message });

  sendProviderApprovedEmail({ to: provider.email, providerName: provider.name }).catch(e =>
    console.error('[admin] sendProviderApprovedEmail error:', e.message)
  );

  console.log(`[admin] provider ${id} (${provider.name}) approvato`);
  res.json({ ok: true });
});

// ── POST /api/v1/admin/providers/:id/courses ──────────────────────────────────

router.post('/admin/providers/:id/courses', validate(createAdminCourseSchema), async (req, res) => {
  const { id: provider_id } = req.params;
  const {
    course_type_id, title, description, price_cents, delivery_mode,
    location_city, location_address, duration_hours, max_participants,
    includes_exam, certificate_issued_days, is_featured,
  } = req.body || {};

  if (!course_type_id || !title || !price_cents || !duration_hours) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  const { data, error } = await supabase
    .from('marketplace_courses')
    .insert({
      provider_id, course_type_id, title, description,
      price_cents, delivery_mode, location_city, location_address,
      duration_hours, max_participants, includes_exam,
      certificate_issued_days: certificate_issued_days || 7,
      is_featured: is_featured || false,
      is_active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ course: data });
});

// ── PUT /api/v1/admin/courses/:id ─────────────────────────────────────────────

router.put('/admin/courses/:id', validate(putAdminCourseSchema), async (req, res) => {
  const { id } = req.params;
  const allowed = [
    'title','description','price_cents','delivery_mode','location_city','location_address',
    'duration_hours','max_participants','includes_exam','certificate_issued_days',
    'is_featured','is_active','course_type_id',
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('marketplace_courses').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ course: data });
});

// ── POST /api/v1/admin/courses/:id/sessions ───────────────────────────────────

router.post('/admin/courses/:id/sessions', validate(createAdminSessionSchema), async (req, res) => {
  const { id: course_id } = req.params;
  const { start_date, end_date, available_spots, location_override, notes } = req.body || {};

  if (!start_date || !end_date || !available_spots) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  const { data, error } = await supabase
    .from('course_sessions')
    .insert({ course_id, start_date, end_date, available_spots, location_override, notes })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ session: data });
});

// ── GET /api/v1/admin/bookings ────────────────────────────────────────────────

router.get('/admin/bookings', async (req, res) => {
  const { status, limit: rawLimit = '100', offset: rawOffset = '0' } = req.query;
  const limit  = Math.min(parseInt(rawLimit,  10) || 100, 200);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  let query = supabase
    .from('course_bookings')
    .select(`
      *,
      workers    ( id, full_name, fiscal_code ),
      companies  ( id, name ),
      marketplace_courses ( id, title, training_providers ( id, name ) ),
      course_sessions ( id, start_date, end_date )
    `, { count: 'exact' })
    .order('booked_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ bookings: data || [], total: count || 0 });
});

// ── PATCH /api/v1/admin/bookings/:id/complete ─────────────────────────────────

router.patch('/admin/bookings/:id/complete', validate(completeAdminBookingSchema), async (req, res) => {
  const { id } = req.params;
  const {
    issue_date, issuing_body, certificate_number, pdf_url,
  } = req.body || {};

  if (!issue_date || !issuing_body) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'issue_date e issuing_body obbligatori' });
  }

  const { data: booking } = await supabase
    .from('course_bookings')
    .select('id, worker_id, company_id, course_id, status')
    .eq('id', id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
  if (booking.status === 'completed') return res.status(400).json({ error: 'ALREADY_COMPLETED' });

  // Get course type from course
  const { data: course } = await supabase
    .from('marketplace_courses')
    .select('course_type_id')
    .eq('id', booking.course_id)
    .maybeSingle();

  if (!course) return res.status(500).json({ error: 'COURSE_NOT_FOUND' });

  const { data: ct } = await supabase
    .from('course_types')
    .select('validity_years')
    .eq('id', course.course_type_id)
    .maybeSingle();

  if (!ct) return res.status(500).json({ error: 'COURSE_TYPE_NOT_FOUND' });

  if (!ct.validity_years) return res.status(400).json({ error: 'VALIDITY_NOT_SET', message: 'Validità del corso non configurata' });

  // Compute expiry
  const expiryD = new Date(issue_date);
  expiryD.setFullYear(expiryD.getFullYear() + ct.validity_years);
  const expiry_date = expiryD.toISOString().slice(0, 10);

  // Create new certificate
  const { data: cert, error: cErr } = await supabase
    .from('worker_certificates')
    .insert({
      company_id:         booking.company_id,
      worker_id:          booking.worker_id,
      course_type_id:     course.course_type_id,
      issue_date,
      expiry_date,
      issuing_body,
      certificate_number: certificate_number || null,
      pdf_url:            pdf_url || null,
    })
    .select()
    .single();

  if (cErr) return res.status(500).json({ error: 'DB_ERROR', detail: cErr.message });

  // Update booking
  const { error: bErr } = await supabase
    .from('course_bookings')
    .update({ status: 'completed', completed_at: new Date().toISOString(), new_certificate_id: cert.id })
    .eq('id', id);

  if (bErr) {
    console.error('[admin] booking complete update error:', bErr.message);
    return res.status(500).json({ error: 'BOOKING_UPDATE_ERROR', certificate_id: cert.id });
  }

  res.json({ ok: true, certificate: cert });
});

// ── POST /api/v1/admin/migrate-formazione ─────────────────────────────────────
// Migrazione one-shot: sincronizza tutti i worker_documents formativi esistenti
// verso worker_certificates. Idempotente: rilancia più volte senza duplicati.

router.post('/admin/migrate-formazione', async (req, res) => {
  const FORMAZIONE_TYPES = ['formazione_sicurezza', 'primo_soccorso', 'antincendio', 'lavori_quota', 'ponteggi', 'gruista'];

  // Carica tutti i worker_documents formativi con almeno una scadenza
  const { data: docs, error } = await supabase
    .from('worker_documents')
    .select('id, company_id, worker_id, doc_type, name, issued_date, expiry_date, ai_expiry_date, ai_issued_by, file_url')
    .in('doc_type', FORMAZIONE_TYPES)
    .limit(5000);

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  const stats = { total: docs.length, processed: 0, skipped_no_date: 0, errors: 0 };

  for (const doc of docs) {
    const expiryDate = doc.expiry_date || doc.ai_expiry_date;
    if (!expiryDate) { stats.skipped_no_date++; continue; }

    try {
      await syncToFormazione(
        doc.id, doc.worker_id, doc.company_id,
        doc.doc_type, doc.name,
        doc.issued_date, expiryDate,
        doc.ai_issued_by, doc.file_url,
      );
      stats.processed++;
    } catch (e) {
      console.error('[migrate-formazione]', doc.id, e.message);
      stats.errors++;
    }
  }

  res.json({ ok: true, ...stats });
});

module.exports = router;
