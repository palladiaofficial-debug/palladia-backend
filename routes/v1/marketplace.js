'use strict';
/**
 * routes/v1/marketplace.js
 * Modulo Formazione — marketplace corsi di formazione.
 *
 * GET /api/v1/course-types                     — tipi corso (dropdown)
 * GET /api/v1/marketplace/courses              — lista corsi con filtri
 * GET /api/v1/marketplace/courses/:id          — dettaglio corso + sessioni + recensioni
 * GET /api/v1/marketplace/providers            — lista enti formatori
 * GET /api/v1/marketplace/providers/:id        — dettaglio ente + corsi
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// course-types è pubblico (usato anche in form add-certificate senza marketplace)
// I marketplace endpoint richiedono JWT per associare i lavoratori dell'impresa

// ── GET /api/v1/course-types ──────────────────────────────────────────────────

router.get('/course-types', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('course_types')
    .select('id, name, legal_reference, validity_years, renewal_hours, risk_level')
    .order('risk_level', { ascending: false })
    .order('name');

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ course_types: data || [] });
});

// ── GET /api/v1/marketplace/courses ──────────────────────────────────────────

router.get('/marketplace/courses', verifySupabaseJwt, async (req, res) => {
  const {
    course_type_id,
    delivery_mode,
    city,
    min_price,
    max_price,
    has_reviews,
    sort = 'relevance',
    limit: rawLimit = '20',
    offset: rawOffset = '0',
  } = req.query;

  const limit  = Math.min(parseInt(rawLimit,  10) || 20, 50);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  let query = supabase
    .from('marketplace_courses')
    .select(`
      id, title, description, price_cents, delivery_mode, location_city, location_address,
      duration_hours, max_participants, includes_exam, certificate_issued_days,
      is_featured, language,
      training_providers (
        id, name, logo_url, rating, total_reviews, location_city, location_province, is_featured
      ),
      course_types ( id, name, risk_level, validity_years )
    `, { count: 'exact' })
    .eq('is_active', true);

  if (course_type_id) query = query.eq('course_type_id', course_type_id);
  if (delivery_mode)  query = query.eq('delivery_mode', delivery_mode);
  if (city)           query = query.ilike('location_city', `%${city}%`);
  if (min_price)      query = query.gte('price_cents', parseInt(min_price, 10) * 100);
  if (max_price)      query = query.lte('price_cents', parseInt(max_price, 10) * 100);
  if (has_reviews === 'true') {
    // Filter via provider rating > 0 — post-filter below
  }

  // Ordering
  if (sort === 'price_asc')  query = query.order('price_cents', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_cents', { ascending: false });
  else {
    // Relevance: featured first, then by provider rating (done client-side after sort)
    query = query.order('is_featured', { ascending: false }).order('price_cents', { ascending: true });
  }

  query = query.range(offset, offset + limit - 1);

  const { data: courses, error, count } = await query;

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Load next session for each course
  const courseIds = (courses || []).map(c => c.id);
  let sessions = [];
  if (courseIds.length > 0) {
    const { data: sess } = await supabase
      .from('course_sessions')
      .select('course_id, id, start_date, available_spots, booked_spots')
      .in('course_id', courseIds)
      .eq('is_cancelled', false)
      .gt('start_date', new Date().toISOString())
      .order('start_date', { ascending: true });
    sessions = sess || [];
  }

  // Attach next session + filter if has_reviews
  const nextByCourseid = {};
  for (const s of sessions) {
    if (!nextByCourseid[s.course_id]) nextByCourseid[s.course_id] = s;
  }

  let result = (courses || []).map(c => ({
    ...c,
    next_session: nextByCourseid[c.id] || null,
    spots_left:   nextByCourseid[c.id]
      ? nextByCourseid[c.id].available_spots - (nextByCourseid[c.id].booked_spots || 0)
      : null,
  }));

  if (has_reviews === 'true') {
    result = result.filter(c => c.training_providers?.rating > 0);
  }

  // Sort by relevance: featured providers first, then by provider rating
  if (sort === 'relevance') {
    result.sort((a, b) => {
      if (b.is_featured !== a.is_featured)
        return (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0);
      if (b.training_providers?.is_featured !== a.training_providers?.is_featured)
        return (b.training_providers?.is_featured ? 1 : 0) - (a.training_providers?.is_featured ? 1 : 0);
      return (b.training_providers?.rating || 0) - (a.training_providers?.rating || 0);
    });
  }

  if (sort === 'rating') {
    result.sort((a, b) => (b.training_providers?.rating || 0) - (a.training_providers?.rating || 0));
  }

  if (sort === 'next_date') {
    result.sort((a, b) => {
      const da = a.next_session?.start_date || '9999';
      const db = b.next_session?.start_date || '9999';
      return da.localeCompare(db);
    });
  }

  res.json({ courses: result, total: count || result.length, limit, offset });
});

// ── GET /api/v1/marketplace/courses/:id ──────────────────────────────────────

router.get('/marketplace/courses/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: course, error } = await supabase
    .from('marketplace_courses')
    .select(`
      *,
      training_providers (*),
      course_types (*)
    `)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!course) return res.status(404).json({ error: 'NOT_FOUND' });

  // Sessions
  const { data: sessions } = await supabase
    .from('course_sessions')
    .select('id, start_date, end_date, available_spots, booked_spots, location_override, notes')
    .eq('course_id', id)
    .eq('is_cancelled', false)
    .gt('start_date', new Date().toISOString())
    .order('start_date', { ascending: true })
    .limit(10);

  // Reviews
  const { data: reviews } = await supabase
    .from('provider_reviews')
    .select('id, rating, comment, created_at')
    .eq('provider_id', course.provider_id)
    .order('created_at', { ascending: false })
    .limit(10);

  res.json({
    course: {
      ...course,
      sessions: (sessions || []).map(s => ({
        ...s,
        spots_left: s.available_spots - (s.booked_spots || 0),
      })),
      reviews: reviews || [],
    },
  });
});

// ── GET /api/v1/marketplace/providers ────────────────────────────────────────

router.get('/marketplace/providers', verifySupabaseJwt, async (req, res) => {
  const { city, province } = req.query;

  let query = supabase
    .from('training_providers')
    .select('id, name, logo_url, location_city, location_province, rating, total_reviews, is_featured, description')
    .eq('is_active', true)
    .order('is_featured', { ascending: false })
    .order('rating', { ascending: false });

  if (city)     query = query.ilike('location_city', `%${city}%`);
  if (province) query = query.ilike('location_province', `%${province}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ providers: data || [] });
});

// ── GET /api/v1/marketplace/providers/:id ────────────────────────────────────

router.get('/marketplace/providers/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: provider, error } = await supabase
    .from('training_providers')
    .select('*')
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!provider) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: courses } = await supabase
    .from('marketplace_courses')
    .select('id, title, price_cents, delivery_mode, duration_hours, course_types (name, risk_level)')
    .eq('provider_id', id)
    .eq('is_active', true);

  const { data: reviews } = await supabase
    .from('provider_reviews')
    .select('id, rating, comment, created_at')
    .eq('provider_id', id)
    .order('created_at', { ascending: false })
    .limit(20);

  res.json({ provider, courses: courses || [], reviews: reviews || [] });
});

module.exports = router;
