'use strict';
/**
 * routes/v1/marketplace.js
 * Modulo Formazione — marketplace corsi di formazione.
 *
 * GET /api/v1/course-types                     — tipi corso (dropdown)
 * GET /api/v1/marketplace/courses              — lista corsi (provider + consulenti) con filtri
 * GET /api/v1/marketplace/courses/:id          — dettaglio corso + sessioni + recensioni
 * GET /api/v1/marketplace/providers            — lista enti formatori
 * GET /api/v1/marketplace/providers/:id        — dettaglio ente + corsi
 * GET /api/v1/marketplace/consultant/:id       — profilo pubblico consulente
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
    only_my_consultant,
    sort = 'relevance',
    limit: rawLimit = '20',
    offset: rawOffset = '0',
  } = req.query;

  const limit  = Math.min(parseInt(rawLimit,  10) || 20, 50);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  // Trova il consulente collegato all'impresa (se presente)
  let linkedConsultantId = null;
  const { data: clientRel } = await supabase
    .from('consultant_clients')
    .select('consultant_id')
    .eq('company_id', req.companyId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (clientRel) linkedConsultantId = clientRel.consultant_id;

  let query = supabase
    .from('marketplace_courses')
    .select(`
      id, title, description, price_cents, delivery_mode, location_city, location_address,
      duration_hours, max_participants, includes_exam, certificate_issued_days,
      is_featured, language, consultant_id, issuing_body_name, total_bookings,
      training_providers (
        id, name, logo_url, rating, total_reviews, location_city, location_province, is_featured
      ),
      course_types ( id, name, risk_level, validity_years )
    `, { count: 'exact' })
    .eq('is_active', true)
    .eq('is_draft', false);

  if (course_type_id)       query = query.eq('course_type_id', course_type_id);
  if (delivery_mode)        query = query.eq('delivery_mode', delivery_mode);
  if (city)                 query = query.ilike('location_city', `%${city}%`);
  if (min_price)            query = query.gte('price_cents', parseInt(min_price, 10) * 100);
  if (max_price)            query = query.lte('price_cents', parseInt(max_price, 10) * 100);
  if (only_my_consultant === 'true' && linkedConsultantId) {
    query = query.eq('consultant_id', linkedConsultantId);
  }

  if (sort === 'price_asc')  query = query.order('price_cents', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_cents', { ascending: false });
  else query = query.order('is_featured', { ascending: false }).order('price_cents', { ascending: true });

  query = query.range(offset, offset + limit - 1);

  const { data: courses, error, count } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Carica i profili consulenti per i corsi con consultant_id
  const consultantIds = [...new Set((courses || []).filter(c => c.consultant_id).map(c => c.consultant_id))];
  let consultantProfiles = {};
  if (consultantIds.length > 0) {
    const { data: profiles } = await supabase
      .from('consultant_profiles')
      .select('user_id, company_name, photo_url, avg_rating, total_reviews, total_workers_trained')
      .in('user_id', consultantIds);

    for (const p of profiles || []) consultantProfiles[p.user_id] = p;
  }

  // Prossima sessione per ogni corso
  const courseIds = (courses || []).map(c => c.id);
  let nextByCourseid = {};
  if (courseIds.length > 0) {
    const { data: sess } = await supabase
      .from('course_sessions')
      .select('course_id, id, start_date, available_spots, booked_spots')
      .in('course_id', courseIds)
      .eq('is_cancelled', false)
      .gt('start_date', new Date().toISOString())
      .order('start_date', { ascending: true });

    for (const s of sess || []) {
      if (!nextByCourseid[s.course_id]) nextByCourseid[s.course_id] = s;
    }
  }

  let result = (courses || []).map(c => {
    const isMyConsultant = linkedConsultantId && c.consultant_id === linkedConsultantId;
    const consultantProfile = c.consultant_id ? (consultantProfiles[c.consultant_id] || null) : null;

    return {
      ...c,
      consultant:        consultantProfile,
      is_my_consultant:  isMyConsultant,
      next_session:      nextByCourseid[c.id] || null,
      spots_left:        nextByCourseid[c.id]
        ? nextByCourseid[c.id].available_spots - (nextByCourseid[c.id].booked_spots || 0)
        : null,
    };
  });

  if (has_reviews === 'true') {
    result = result.filter(c => (c.training_providers?.rating > 0) || (c.consultant?.avg_rating > 0));
  }

  // Ordinamento: consulente collegato prima → featured → rating
  if (sort === 'relevance') {
    result.sort((a, b) => {
      if (b.is_my_consultant !== a.is_my_consultant)
        return (b.is_my_consultant ? 1 : 0) - (a.is_my_consultant ? 1 : 0);
      if (b.is_featured !== a.is_featured)
        return (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0);
      if (b.training_providers?.is_featured !== a.training_providers?.is_featured)
        return (b.training_providers?.is_featured ? 1 : 0) - (a.training_providers?.is_featured ? 1 : 0);
      const ratingA = a.consultant?.avg_rating || a.training_providers?.rating || 0;
      const ratingB = b.consultant?.avg_rating || b.training_providers?.rating || 0;
      return ratingB - ratingA;
    });
  }

  if (sort === 'rating') {
    result.sort((a, b) => {
      const rA = a.consultant?.avg_rating || a.training_providers?.rating || 0;
      const rB = b.consultant?.avg_rating || b.training_providers?.rating || 0;
      return rB - rA;
    });
  }

  if (sort === 'next_date') {
    result.sort((a, b) => {
      const da = a.next_session?.start_date || '9999';
      const db = b.next_session?.start_date || '9999';
      return da.localeCompare(db);
    });
  }

  res.json({ courses: result, total: count || result.length, limit, offset, linked_consultant_id: linkedConsultantId });
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

// ── GET /api/v1/marketplace/consultant/:consultantId ─────────────────────────

router.get('/marketplace/consultant/:consultantId', verifySupabaseJwt, async (req, res) => {
  const { consultantId } = req.params;

  const { data: profile, error } = await supabase
    .from('consultant_profiles')
    .select('user_id, company_name, bio, photo_url, operative_regions, years_experience, avg_rating, total_reviews, total_workers_trained, total_client_companies, accreditation_bodies')
    .eq('user_id', consultantId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });

  // Corsi attivi del consulente
  const { data: courses } = await supabase
    .from('marketplace_courses')
    .select(`
      id, title, price_cents, delivery_mode, location_city, duration_hours,
      certificate_issued_days, issuing_body_name, total_bookings,
      course_types ( id, name, risk_level )
    `)
    .eq('consultant_id', consultantId)
    .eq('is_active', true)
    .eq('is_draft', false)
    .order('total_bookings', { ascending: false });

  // Controlla se l'impresa richiedente è già cliente del consulente
  const { data: rel } = await supabase
    .from('consultant_clients')
    .select('id, status')
    .eq('consultant_id', consultantId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  res.json({
    consultant: profile,
    courses:    courses || [],
    relationship: rel ? { id: rel.id, status: rel.status } : null,
  });
});

module.exports = router;
