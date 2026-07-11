'use strict';
/**
 * routes/v1/formazioneProvider.js
 * Portale Enti Formazione — accesso via magic link, gestione corsi e sessioni.
 *
 * POST /api/v1/formazione/provider/register        — auto-registrazione ente
 * POST /api/v1/formazione/provider/request-link    — richiesta magic link (login)
 * GET  /api/v1/formazione/provider/:token/dashboard
 * GET  /api/v1/formazione/provider/:token/profile
 * PATCH /api/v1/formazione/provider/:token/profile
 * GET  /api/v1/formazione/provider/:token/courses
 * POST /api/v1/formazione/provider/:token/courses
 * PUT  /api/v1/formazione/provider/:token/courses/:courseId
 * DELETE /api/v1/formazione/provider/:token/courses/:courseId
 * POST /api/v1/formazione/provider/:token/courses/:courseId/sessions
 * PATCH /api/v1/formazione/provider/:token/courses/:courseId/sessions/:sessionId
 * DELETE /api/v1/formazione/provider/:token/courses/:courseId/sessions/:sessionId
 * GET  /api/v1/formazione/provider/:token/bookings
 * PATCH /api/v1/formazione/provider/:token/bookings/:bookingId/confirm
 * PATCH /api/v1/formazione/provider/:token/bookings/:bookingId/complete
 * GET  /api/v1/formazione/course-types              — lista tipi corso (pubblica)
 */

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { validate } = require('../../middleware/validate');
const {
  registerProviderSchema,
  requestLinkSchema,
  patchProviderProfileSchema,
  createProviderCourseSchema,
  putProviderCourseSchema,
  createProviderSessionSchema,
  patchProviderSessionSchema,
  completeProviderBookingSchema,
} = require('../../lib/schemas/formazioneProvider');

const PROVIDER_TOKEN_TTL_DAYS = 365;

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}
function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}
function appUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
}

// Risolve la sessione provider dal token
async function resolveProviderSession(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('training_provider_sessions')
    .select('id, provider_id, email')
    .eq('token_hash', hashToken(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!data) return null;
  // Aggiorna last_used_at
  supabase.from('training_provider_sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id).then(() => {});
  return data;
}

// Genera e invia magic link al provider
async function sendProviderMagicLink(providerId, email, name) {
  const token    = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PROVIDER_TOKEN_TTL_DAYS * 86400000).toISOString();
  const { error } = await supabase
    .from('training_provider_sessions')
    .insert({ provider_id: providerId, email, token_hash: hashToken(token), expires_at: expiresAt });
  if (error) throw new Error(error.message);
  const { sendProviderMagicLinkEmail } = require('../../services/email');
  await sendProviderMagicLinkEmail({
    to:        email,
    name,
    accessUrl: `${appUrl()}/formazione/provider/accesso/${token}`,
  });
}

// ── GET /api/v1/formazione/course-types (pubblica) ────────────────────────────
router.get('/formazione/course-types', async (req, res) => {
  const { data, error } = await supabase
    .from('course_types')
    .select('id, name, validity_years, legal_reference')
    .order('name');
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/formazione/provider/register ─────────────────────────────────
router.post('/formazione/provider/register', validate(registerProviderSchema), async (req, res) => {
  const email     = (req.body?.email              || '').trim().toLowerCase();
  const name      = (req.body?.name               || '').trim();
  const city      = (req.body?.city               || '').trim();
  const province  = (req.body?.province           || '').trim();
  const phone     = (req.body?.phone              || '').trim() || null;
  const website   = (req.body?.website            || '').trim() || null;
  const accCode   = (req.body?.accreditation_code || '').trim() || null;
  const accRegion = (req.body?.accreditation_region || '').trim() || null;

  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }
  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'NAME_REQUIRED', message: 'Nome ente obbligatorio' });
  }
  if (!city || !province) {
    return res.status(400).json({ error: 'LOCATION_REQUIRED', message: 'Città e provincia obbligatorie' });
  }

  // Risposta immediata — tutto il resto in background
  res.json({ ok: true, message: 'Richiesta ricevuta. Sarai contattato a breve.' });

  try {
    const { data: existing } = await supabase
      .from('training_providers')
      .select('id, is_active, name')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) {
        // Già attivo: manda magic link
        await sendProviderMagicLink(existing.id, email, existing.name);
      } else {
        // In attesa di approvazione: invia conferma
        const { sendProviderPendingEmail } = require('../../services/email');
        await sendProviderPendingEmail({ to: email, name: existing.name });
      }
      return;
    }

    // Crea nuovo provider inattivo (richiede approvazione admin)
    const { data: provider } = await supabase
      .from('training_providers')
      .insert({
        name, email, phone, website,
        location_city:         city,
        location_province:     province,
        accreditation_code:    accCode,
        accreditation_region:  accRegion,
        is_active:             false,
        is_featured:           false,
        commission_rate:       15,
      })
      .select('id')
      .single();

    if (!provider) return;

    const { sendProviderRegistrationEmail } = require('../../services/email');
    await Promise.all([
      // Notifica admin Palladia
      sendProviderRegistrationEmail({ to: process.env.ADMIN_EMAIL || 'admin@palladia.net', providerName: name, email, city, province, accCode }),
      // Conferma al provider
      sendProviderRegistrationEmail({ to: email, providerName: name, email, city, province, accCode, isProvider: true }),
    ]).catch(() => {});
  } catch (e) {
    console.error('[provider-register] background error:', e.message);
  }
});

// ── POST /api/v1/formazione/provider/request-link ────────────────────────────
router.post('/formazione/provider/request-link', validate(requestLinkSchema), async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }
  res.json({ ok: true });

  try {
    const { data: provider } = await supabase
      .from('training_providers')
      .select('id, name, is_active')
      .eq('email', email)
      .maybeSingle();

    if (!provider || !provider.is_active) return;
    await sendProviderMagicLink(provider.id, email, provider.name);
  } catch (e) {
    console.error('[provider-request-link] error:', e.message);
  }
});

// ── GET /api/v1/formazione/provider/:token/profile ────────────────────────────
router.get('/formazione/provider/:token/profile', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('training_providers')
    .select('id, name, email, phone, website, location_city, location_province, address, bio, logo_url, accreditation_code, accreditation_region, is_active, is_featured, rating, total_reviews, commission_rate')
    .eq('id', session.provider_id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'PROVIDER_NOT_FOUND' });
  res.json(data);
});

// ── PATCH /api/v1/formazione/provider/:token/profile ─────────────────────────
router.patch('/formazione/provider/:token/profile', validate(patchProviderProfileSchema), async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const ALLOWED = ['name', 'phone', 'website', 'address', 'bio', 'logo_url', 'accreditation_code', 'accreditation_region', 'location_city', 'location_province'];
  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k] ? String(req.body[k]).trim() : null;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

  const { data, error } = await supabase
    .from('training_providers')
    .update(updates)
    .eq('id', session.provider_id)
    .select('id, name, email')
    .single();

  if (error || !data) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, provider: data });
});

// ── GET /api/v1/formazione/provider/:token/dashboard ─────────────────────────
router.get('/formazione/provider/:token/dashboard', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const providerId = session.provider_id;

  const [providerRes, coursesRes] = await Promise.all([
    supabase.from('training_providers')
      .select('id, name, email, location_city, location_province, is_active, is_featured, rating, total_reviews, commission_rate')
      .eq('id', providerId).maybeSingle(),
    supabase.from('marketplace_courses')
      .select('id, title, price_cents, delivery_mode, is_active, is_draft, course_types(name), course_sessions(id, start_date, booked_spots, available_spots)')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false }),
  ]);

  const courses = coursesRes.data || [];

  // Raccoglie tutti i session IDs per recuperare le prenotazioni
  const sessionIds = courses.flatMap(c => (c.course_sessions || []).map(s => s.id));
  let bookings = [];
  if (sessionIds.length > 0) {
    const { data: bData } = await supabase
      .from('course_bookings')
      .select('id, status, booked_at, session_id')
      .in('session_id', sessionIds)
      .order('booked_at', { ascending: false })
      .limit(200);
    bookings = bData || [];
  }

  // Prossime sessioni (entro 60gg)
  const in60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const upcomingSessions = courses.flatMap(c =>
    (c.course_sessions || [])
      .filter(s => s.start_date >= today && s.start_date <= in60)
      .map(s => ({
        session_id:   s.id,
        course_title: c.title,
        start_date:   s.start_date,
        booked:       s.booked_spots || 0,
        available:    s.available_spots || 0,
      }))
  ).sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, 10);

  const stats = {
    total_courses:       courses.length,
    active_courses:      courses.filter(c => c.is_active && !c.is_draft).length,
    draft_courses:       courses.filter(c => c.is_draft).length,
    pending_bookings:    bookings.filter(b => b.status === 'pending').length,
    confirmed_bookings:  bookings.filter(b => b.status === 'confirmed').length,
    completed_bookings:  bookings.filter(b => b.status === 'completed').length,
    upcoming_sessions:   upcomingSessions.length,
  };

  res.json({
    provider:          providerRes.data,
    stats,
    courses:           courses.slice(0, 5),       // top 5 for dashboard preview
    upcoming_sessions: upcomingSessions,
    recent_bookings:   bookings.slice(0, 10),
  });
});

// ── GET /api/v1/formazione/provider/:token/courses ───────────────────────────
router.get('/formazione/provider/:token/courses', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data, error } = await supabase
    .from('marketplace_courses')
    .select(`
      id, title, description, price_cents, delivery_mode, location_city, duration_hours,
      max_participants, includes_exam, certificate_issued_days, is_active, is_draft, is_featured,
      created_at,
      course_types(id, name, validity_years),
      course_sessions(id, start_date, end_date, available_spots, booked_spots, notes, location_override)
    `)
    .eq('provider_id', session.provider_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/formazione/provider/:token/courses ──────────────────────────
router.post('/formazione/provider/:token/courses', validate(createProviderCourseSchema), async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { title, description, course_type_id, price_cents, delivery_mode, location_city, duration_hours, max_participants, includes_exam, certificate_issued_days } = req.body || {};

  if (!title || String(title).trim().length < 3) return res.status(400).json({ error: 'TITLE_REQUIRED' });
  if (!course_type_id) return res.status(400).json({ error: 'COURSE_TYPE_REQUIRED' });
  if (!price_cents || isNaN(parseInt(price_cents))) return res.status(400).json({ error: 'PRICE_REQUIRED' });

  const { data, error } = await supabase
    .from('marketplace_courses')
    .insert({
      provider_id:            session.provider_id,
      title:                  String(title).trim().slice(0, 200),
      description:            description ? String(description).trim().slice(0, 2000) : null,
      course_type_id,
      price_cents:            Math.max(0, parseInt(price_cents)),
      delivery_mode:          ['in_aula', 'online', 'blended'].includes(delivery_mode) ? delivery_mode : 'in_aula',
      location_city:          location_city ? String(location_city).trim() : null,
      duration_hours:         Math.max(1, parseInt(duration_hours) || 8),
      max_participants:       max_participants ? Math.max(1, parseInt(max_participants)) : null,
      includes_exam:          !!includes_exam,
      certificate_issued_days: Math.max(1, parseInt(certificate_issued_days) || 30),
      is_active:              false,   // parte come bozza — richiede revisione admin
      is_draft:               true,
    })
    .select('id, title, is_draft, is_active')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ ok: true, course: data, message: 'Corso in attesa di revisione dal team Palladia.' });
});

// ── PUT /api/v1/formazione/provider/:token/courses/:courseId ─────────────────
router.put('/formazione/provider/:token/courses/:courseId', validate(putProviderCourseSchema), async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const ALLOWED = ['title', 'description', 'price_cents', 'delivery_mode', 'location_city', 'duration_hours', 'max_participants', 'includes_exam', 'certificate_issued_days'];
  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });
  if (updates.title) updates.title = String(updates.title).trim().slice(0, 200);
  if (updates.description) updates.description = String(updates.description).trim().slice(0, 2000);

  const { data, error } = await supabase
    .from('marketplace_courses')
    .update(updates)
    .eq('id', req.params.courseId)
    .eq('provider_id', session.provider_id)
    .select('id, title')
    .single();

  if (error || !data) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
  res.json({ ok: true, course: data });
});

// ── DELETE /api/v1/formazione/provider/:token/courses/:courseId ───────────────
router.delete('/formazione/provider/:token/courses/:courseId', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  // Soft delete — non cancella la storia
  const { data, error } = await supabase
    .from('marketplace_courses')
    .update({ is_active: false, is_draft: true })
    .eq('id', req.params.courseId)
    .eq('provider_id', session.provider_id)
    .select('id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
  res.json({ ok: true });
});

// ── POST /api/v1/formazione/provider/:token/courses/:courseId/sessions ────────
router.post('/formazione/provider/:token/courses/:courseId/sessions', validate(createProviderSessionSchema), async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: course } = await supabase
    .from('marketplace_courses')
    .select('id, max_participants')
    .eq('id', req.params.courseId)
    .eq('provider_id', session.provider_id)
    .maybeSingle();

  if (!course) return res.status(403).json({ error: 'COURSE_NOT_FOUND' });

  const { start_date, end_date, available_spots, notes, location_override } = req.body || {};

  if (!start_date || !/^\d{4}-\d{2}-\d{2}/.test(start_date)) {
    return res.status(400).json({ error: 'START_DATE_REQUIRED' });
  }

  const { data, error } = await supabase
    .from('course_sessions')
    .insert({
      course_id:         req.params.courseId,
      start_date,
      // end_date è NOT NULL a DB — un corso in un solo giorno (caso comune,
      // il campo nel form provider non è obbligatorio) altrimenti falliva
      // sempre con un errore di constraint. Default: stesso giorno di inizio.
      end_date:          end_date || start_date,
      available_spots:   available_spots ? Math.max(1, parseInt(available_spots)) : (course.max_participants || 20),
      booked_spots:      0,
      notes:             notes ? String(notes).trim().slice(0, 500) : null,
      location_override: location_override ? String(location_override).trim().slice(0, 200) : null,
    })
    .select('id, start_date, end_date, available_spots, booked_spots')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ ok: true, session: data });
});

// ── PATCH /api/v1/formazione/provider/:token/courses/:courseId/sessions/:sessionId ─
router.patch('/formazione/provider/:token/courses/:courseId/sessions/:sessionId', validate(patchProviderSessionSchema), async (req, res) => {
  const pSession = await resolveProviderSession(req.params.token);
  if (!pSession) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  // Verifica ownership via course
  const { data: course } = await supabase
    .from('marketplace_courses').select('id')
    .eq('id', req.params.courseId).eq('provider_id', pSession.provider_id).maybeSingle();
  if (!course) return res.status(403).json({ error: 'COURSE_NOT_FOUND' });

  const ALLOWED = ['start_date', 'end_date', 'available_spots', 'notes', 'location_override'];
  const updates = {};
  for (const k of ALLOWED) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

  const { data, error } = await supabase
    .from('course_sessions')
    .update(updates)
    .eq('id', req.params.sessionId)
    .eq('course_id', req.params.courseId)
    .select('id, start_date, end_date, available_spots')
    .single();

  if (error || !data) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  res.json({ ok: true, session: data });
});

// ── DELETE /api/v1/formazione/provider/:token/courses/:courseId/sessions/:sessionId ─
router.delete('/formazione/provider/:token/courses/:courseId/sessions/:sessionId', async (req, res) => {
  const pSession = await resolveProviderSession(req.params.token);
  if (!pSession) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: course } = await supabase
    .from('marketplace_courses').select('id')
    .eq('id', req.params.courseId).eq('provider_id', pSession.provider_id).maybeSingle();
  if (!course) return res.status(403).json({ error: 'COURSE_NOT_FOUND' });

  // Controlla se ci sono prenotazioni — non eliminare se ci sono
  const { data: bookings } = await supabase
    .from('course_bookings')
    .select('id').eq('session_id', req.params.sessionId).eq('status', 'confirmed').limit(1);
  if (bookings && bookings.length > 0) {
    return res.status(409).json({ error: 'SESSION_HAS_CONFIRMED_BOOKINGS', message: 'Impossibile eliminare una sessione con prenotazioni confermate.' });
  }

  await supabase.from('course_bookings').delete().eq('session_id', req.params.sessionId).in('status', ['pending']);
  const { error } = await supabase.from('course_sessions').delete().eq('id', req.params.sessionId).eq('course_id', req.params.courseId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── GET /api/v1/formazione/provider/:token/bookings ──────────────────────────
router.get('/formazione/provider/:token/bookings', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: myCoursesData } = await supabase
    .from('marketplace_courses').select('id')
    .eq('provider_id', session.provider_id);

  if (!myCoursesData || myCoursesData.length === 0) return res.json([]);

  const courseIds = myCoursesData.map(c => c.id);
  const { data: sessData } = await supabase.from('course_sessions').select('id').in('course_id', courseIds);
  if (!sessData || sessData.length === 0) return res.json([]);

  const sessionIds = sessData.map(s => s.id);

  const { status } = req.query;
  let query = supabase
    .from('course_bookings')
    .select(`
      id, status, booked_at, payment_status, completed_at,
      worker_id,
      workers(full_name, fiscal_code),
      course_sessions(
        id, start_date, end_date,
        marketplace_courses(id, title, price_cents, duration_hours)
      )
    `)
    .in('session_id', sessionIds)
    .order('booked_at', { ascending: false })
    .limit(200);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── PATCH /api/v1/formazione/provider/:token/bookings/:bookingId/confirm ──────
router.patch('/formazione/provider/:token/bookings/:bookingId/confirm', async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: booking } = await supabase
    .from('course_bookings')
    .select(`
      id, status, session_id,
      course_sessions(
        id,
        marketplace_courses(training_providers(id))
      )
    `)
    .eq('id', req.params.bookingId)
    .maybeSingle();

  if (!booking || booking.status !== 'pending') {
    return res.status(404).json({ error: 'BOOKING_NOT_FOUND_OR_NOT_PENDING' });
  }

  // Verifica che la prenotazione appartenga a questo provider
  const providerId = booking.course_sessions?.marketplace_courses?.training_providers?.id;
  if (providerId !== session.provider_id) {
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  }

  const { data, error } = await supabase
    .from('course_bookings')
    .update({ status: 'confirmed' })
    .eq('id', req.params.bookingId)
    .select('id, status')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Notifica al lavoratore/azienda (best-effort)
  try {
    const { sendBookingConfirmedEmail } = require('../../services/email');
    await sendBookingConfirmedEmail({ bookingId: booking.id });
  } catch { /* non blocca */ }

  res.json({ ok: true, booking: data });
});

// ── PATCH /api/v1/formazione/provider/:token/bookings/:bookingId/complete ─────
router.patch('/formazione/provider/:token/bookings/:bookingId/complete', validate(completeProviderBookingSchema), async (req, res) => {
  const session = await resolveProviderSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { certificate_number, notes } = req.body || {};

  const { data: booking } = await supabase
    .from('course_bookings')
    .select(`
      id, status, worker_id,
      workers(company_id),
      course_sessions(
        id, course_id,
        marketplace_courses(
          id, course_type_id, certificate_issued_days,
          training_providers(id)
        )
      )
    `)
    .eq('id', req.params.bookingId)
    .maybeSingle();

  if (!booking || !['pending', 'confirmed'].includes(booking.status)) {
    return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
  }

  // Verifica che la prenotazione appartenga a questo provider
  const providerId = booking.course_sessions?.marketplace_courses?.training_providers?.id;
  if (providerId !== session.provider_id) {
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  }

  const course  = booking.course_sessions?.marketplace_courses;
  const now     = new Date();
  const issueDate = now.toISOString().split('T')[0];
  const validityDays = course?.certificate_issued_days || 30;
  const expiryDate   = new Date(now.getTime() + validityDays * 86400000).toISOString().split('T')[0];

  const [updateRes, certRes] = await Promise.all([
    supabase.from('course_bookings')
      .update({ status: 'completed', completed_at: now.toISOString(), payment_status: 'paid' })
      .eq('id', req.params.bookingId)
      .select('id, status'),
    (course?.course_type_id && booking.worker_id)
      ? supabase.from('worker_certificates').insert({
          worker_id:          booking.worker_id,
          company_id:         booking.workers?.company_id || null,
          course_type_id:     course.course_type_id,
          issue_date:         issueDate,
          expiry_date:        expiryDate,
          certificate_number: certificate_number || null,
          notes:              notes ? String(notes).trim() : null,
        }).select('id')
      : Promise.resolve({ data: null }),
  ]);

  if (updateRes.error) return res.status(500).json({ error: 'DB_ERROR' });

  // Aggiorna safety_training_expiry sul lavoratore (best-effort — non blocca la risposta)
  if (booking.worker_id && expiryDate) {
    supabase.from('workers')
      .update({ safety_training_expiry: expiryDate })
      .eq('id', booking.worker_id)
      .then(() => {})
      .catch(() => {});
  }

  res.json({ ok: true, booking: updateRes.data?.[0], certificate_issued: !!certRes.data });
});

module.exports = router;
