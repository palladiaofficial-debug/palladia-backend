'use strict';
/**
 * routes/v1/consultantCourses.js
 * Gestione corsi pubblicati dal consulente nel marketplace.
 *
 * GET    /api/v1/consultant/courses              — lista corsi propri
 * POST   /api/v1/consultant/courses              — crea corso (+ sessioni opzionali)
 * PUT    /api/v1/consultant/courses/:id          — aggiorna corso
 * DELETE /api/v1/consultant/courses/:id          — disattiva (soft delete)
 * POST   /api/v1/consultant/courses/:id/sessions — aggiungi sessione
 * PUT    /api/v1/consultant/sessions/:id         — modifica sessione
 * DELETE /api/v1/consultant/sessions/:id         — cancella sessione
 * GET    /api/v1/consultant/courses/:id/public   — dettaglio pubblico (visibile alle imprese)
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifyConsultantJwt } = require('../../middleware/verifyConsultant');

const COMMISSION_RATE = 15; // % trattenuta da Palladia

router.use(verifyConsultantJwt);

// ── GET /api/v1/consultant/courses ────────────────────────────────────────────

router.get('/consultant/courses', async (req, res) => {
  const { include_draft = 'true' } = req.query;

  let query = supabase
    .from('marketplace_courses')
    .select(`
      id, title, description, price_cents, delivery_mode, location_city, location_address,
      duration_hours, max_participants, certificate_issued_days, is_active, is_draft,
      issuing_body_name, issuing_body_accreditation, total_bookings, total_revenue_cents,
      created_at,
      course_types ( id, name, risk_level, validity_years )
    `)
    .eq('consultant_id', req.consultantId)
    .order('created_at', { ascending: false });

  if (include_draft !== 'true') query = query.eq('is_draft', false);

  const { data: courses, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Aggiungi prossima sessione per ogni corso
  const courseIds = (courses || []).map(c => c.id);
  let nextSessions = {};

  if (courseIds.length > 0) {
    const { data: sessions } = await supabase
      .from('course_sessions')
      .select('id, course_id, start_date, end_date, available_spots, booked_spots, is_cancelled')
      .in('course_id', courseIds)
      .eq('is_cancelled', false)
      .gt('start_date', new Date().toISOString())
      .order('start_date', { ascending: true });

    for (const s of sessions || []) {
      if (!nextSessions[s.course_id]) nextSessions[s.course_id] = s;
    }
  }

  const result = (courses || []).map(c => ({
    ...c,
    commission_rate: COMMISSION_RATE,
    payout_per_participant: Math.round(c.price_cents * (1 - COMMISSION_RATE / 100)),
    next_session: nextSessions[c.id] || null,
  }));

  res.json({ courses: result });
});

// ── POST /api/v1/consultant/courses ───────────────────────────────────────────

router.post('/consultant/courses', async (req, res) => {
  const {
    course_type_id, title, description, price_cents, delivery_mode,
    location_city, location_address, duration_hours, max_participants,
    certificate_issued_days, issuing_body_name, issuing_body_accreditation,
    is_draft, sessions,
  } = req.body || {};

  if (!course_type_id || !title || !price_cents || !duration_hours || !issuing_body_name) {
    return res.status(400).json({
      error: 'MISSING_FIELDS',
      message: 'course_type_id, title, price_cents, duration_hours, issuing_body_name obbligatori',
    });
  }

  // Verifica course_type esiste
  const { data: ct } = await supabase
    .from('course_types')
    .select('id, name')
    .eq('id', course_type_id)
    .maybeSingle();

  if (!ct) return res.status(400).json({ error: 'INVALID_COURSE_TYPE' });

  const { data: course, error } = await supabase
    .from('marketplace_courses')
    .insert({
      consultant_id:              req.consultantId,
      course_type_id,
      title:                      title.trim(),
      description:                description?.trim() || null,
      price_cents:                parseInt(price_cents, 10),
      delivery_mode:              delivery_mode || 'presenza',
      location_city:              location_city?.trim() || null,
      location_address:           location_address?.trim() || null,
      duration_hours:             parseInt(duration_hours, 10),
      max_participants:           max_participants ? parseInt(max_participants, 10) : null,
      certificate_issued_days:    certificate_issued_days || 7,
      issuing_body_name:          issuing_body_name.trim(),
      issuing_body_accreditation: issuing_body_accreditation?.trim() || null,
      is_draft:                   is_draft !== false,  // default: draft = true
      is_active:                  true,
      is_featured:                false,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Crea sessioni iniziali se fornite
  let createdSessions = [];
  if (Array.isArray(sessions) && sessions.length > 0) {
    const sessionRows = sessions.map(s => ({
      course_id:         course.id,
      start_date:        s.start_date,
      end_date:          s.end_date,
      available_spots:   s.available_spots || (max_participants || 20),
      location_override: s.location_override || null,
      notes:             s.notes || null,
    }));

    const { data: sess } = await supabase
      .from('course_sessions')
      .insert(sessionRows)
      .select();

    createdSessions = sess || [];
  }

  res.status(201).json({
    course:   { ...course, commission_rate: COMMISSION_RATE, payout_per_participant: Math.round(course.price_cents * (1 - COMMISSION_RATE / 100)) },
    sessions: createdSessions,
  });
});

// ── PUT /api/v1/consultant/courses/:id ───────────────────────────────────────

router.put('/consultant/courses/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = [
    'title','description','price_cents','delivery_mode','location_city','location_address',
    'duration_hours','max_participants','certificate_issued_days','issuing_body_name',
    'issuing_body_accreditation','is_draft','is_active',
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('marketplace_courses')
    .update(updates)
    .eq('id', id)
    .eq('consultant_id', req.consultantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ course: data });
});

// ── DELETE /api/v1/consultant/courses/:id ─────────────────────────────────────

router.delete('/consultant/courses/:id', async (req, res) => {
  const { id } = req.params;

  // Soft delete: disattiva il corso senza cancellare
  const { error } = await supabase
    .from('marketplace_courses')
    .update({ is_active: false })
    .eq('id', id)
    .eq('consultant_id', req.consultantId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── POST /api/v1/consultant/courses/:id/sessions ──────────────────────────────

router.post('/consultant/courses/:id/sessions', async (req, res) => {
  const { id: course_id } = req.params;
  const { start_date, end_date, available_spots, location_override, notes } = req.body || {};

  if (!start_date || !end_date || !available_spots) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'start_date, end_date, available_spots obbligatori' });
  }

  // Verifica corso appartiene al consulente
  const { data: course } = await supabase
    .from('marketplace_courses')
    .select('id, max_participants')
    .eq('id', course_id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (!course) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });

  const { data, error } = await supabase
    .from('course_sessions')
    .insert({ course_id, start_date, end_date, available_spots, location_override: location_override || null, notes: notes || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json({ session: data });
});

// ── PUT /api/v1/consultant/sessions/:id ──────────────────────────────────────

router.put('/consultant/sessions/:id', async (req, res) => {
  const { id } = req.params;

  // Verifica che la sessione appartiene a un corso del consulente
  const { data: sess } = await supabase
    .from('course_sessions')
    .select('id, course_id')
    .eq('id', id)
    .maybeSingle();

  if (!sess) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: course } = await supabase
    .from('marketplace_courses')
    .select('id')
    .eq('id', sess.course_id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (!course) return res.status(403).json({ error: 'FORBIDDEN' });

  const allowed = ['start_date','end_date','available_spots','location_override','notes'];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('course_sessions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ session: data });
});

// ── DELETE /api/v1/consultant/sessions/:id ────────────────────────────────────

router.delete('/consultant/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  const { data: sess } = await supabase
    .from('course_sessions')
    .select('id, course_id, booked_spots')
    .eq('id', id)
    .maybeSingle();

  if (!sess) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: course } = await supabase
    .from('marketplace_courses')
    .select('id')
    .eq('id', sess.course_id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (!course) return res.status(403).json({ error: 'FORBIDDEN' });

  const { error } = await supabase
    .from('course_sessions')
    .update({ is_cancelled: true, cancellation_reason: reason || null })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── GET /api/v1/consultant/courses/:id/public ─────────────────────────────────

router.get('/consultant/courses/:id/public', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('marketplace_courses')
    .select(`
      *,
      course_types ( id, name, risk_level, validity_years )
    `)
    .eq('id', id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: sessions } = await supabase
    .from('course_sessions')
    .select('id, start_date, end_date, available_spots, booked_spots, location_override, notes')
    .eq('course_id', id)
    .eq('is_cancelled', false)
    .gt('start_date', new Date().toISOString())
    .order('start_date', { ascending: true });

  res.json({
    course: {
      ...data,
      sessions: (sessions || []).map(s => ({ ...s, spots_left: s.available_spots - (s.booked_spots || 0) })),
      commission_rate: COMMISSION_RATE,
      payout_per_participant: Math.round(data.price_cents * (1 - COMMISSION_RATE / 100)),
    },
  });
});

module.exports = router;
