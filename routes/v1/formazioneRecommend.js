'use strict';
/**
 * routes/v1/formazioneRecommend.js
 * Raccomandazioni corsi intelligenti basate sulle scadenze dell'impresa.
 *
 * GET /api/v1/formazione/recommended-courses
 *   → Restituisce corsi suggeriti per i lavoratori con attestati in scadenza
 *     nei prossimi 90 giorni, filtrati per città dei cantieri dell'impresa.
 *
 * Response include anche il banner motivazionale:
 *   { summary, courses, expiring_workers_count }
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.get('/formazione/recommended-courses', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const in90 = new Date();
  in90.setDate(in90.getDate() + 90);

  // 1. Attestati in scadenza nei prossimi 90 giorni per questa impresa
  const { data: expiring, error: eErr } = await supabase
    .from('worker_certificates')
    .select('worker_id, course_type_id, expiry_date')
    .eq('company_id', companyId)
    .lte('expiry_date', in90.toISOString().slice(0, 10))
    .gte('expiry_date', new Date().toISOString().slice(0, 10));

  if (eErr) return res.status(500).json({ error: 'DB_ERROR', detail: eErr.message });

  if (!expiring || expiring.length === 0) {
    return res.json({ summary: null, courses: [], expiring_workers_count: 0 });
  }

  // 2. Raggruppa per course_type_id → conta lavoratori distinti
  const typeWorkers = {};
  for (const cert of expiring) {
    if (!typeWorkers[cert.course_type_id]) typeWorkers[cert.course_type_id] = new Set();
    typeWorkers[cert.course_type_id].add(cert.worker_id);
  }

  const courseTypeIds = Object.keys(typeWorkers);
  const totalExpiringWorkers = new Set(expiring.map(c => c.worker_id)).size;

  // 3. Città dei cantieri attivi dell'impresa (per filtro geografico)
  const { data: sites } = await supabase
    .from('sites')
    .select('city')
    .eq('company_id', companyId)
    .neq('status', 'chiuso')
    .not('city', 'is', null);

  const sitesCities = [...new Set((sites || []).map(s => s.city?.trim()).filter(Boolean))];

  // 4. Cerca corsi disponibili per i tipi scaduti
  let coursesQuery = supabase
    .from('marketplace_courses')
    .select(`
      id, title, price_cents, delivery_mode, location_city,
      duration_hours, consultant_id, issuing_body_name,
      training_providers (id, name, rating),
      course_types (id, name, validity_years)
    `)
    .in('course_type_id', courseTypeIds)
    .eq('is_active', true)
    .eq('is_draft', false);

  const { data: courses } = await coursesQuery;

  if (!courses || courses.length === 0) {
    return res.json({ summary: null, courses: [], expiring_workers_count: totalExpiringWorkers });
  }

  // 5. Prossima sessione disponibile per ogni corso
  const courseIds = courses.map(c => c.id);
  const { data: sessions } = await supabase
    .from('course_sessions')
    .select('id, course_id, start_date, available_spots, booked_spots')
    .in('course_id', courseIds)
    .eq('is_cancelled', false)
    .gt('start_date', new Date().toISOString())
    .order('start_date', { ascending: true });

  const nextByCourseid = {};
  for (const s of sessions || []) {
    if (!nextByCourseid[s.course_id]) nextByCourseid[s.course_id] = s;
  }

  // 6. Filtra corsi senza sessioni future, aggiungi metadata
  const result = courses
    .map(c => {
      const next = nextByCourseid[c.id];
      if (!next) return null;

      const expiringCount = typeWorkers[c.course_types?.id] || typeWorkers[Object.keys(typeWorkers)[0]];
      const spotsLeft     = next.available_spots - (next.booked_spots || 0);
      if (spotsLeft <= 0) return null;

      // Bonus rilevanza: se la città del corso è vicina ai cantieri
      const inArea = sitesCities.length === 0 ||
        sitesCities.some(city =>
          city.toLowerCase().includes(c.location_city?.toLowerCase() || '__') ||
          (c.location_city || '').toLowerCase().includes(city.toLowerCase())
        );

      return {
        ...c,
        next_session:   next,
        spots_left:     spotsLeft,
        in_area:        inArea,
        expiring_workers: expiringCount ? expiringCount.size : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Priorità: in area > data prossima sessione
      if (b.in_area !== a.in_area) return (b.in_area ? 1 : 0) - (a.in_area ? 1 : 0);
      return a.next_session.start_date.localeCompare(b.next_session.start_date);
    })
    .slice(0, 10);

  // 7. Testo banner
  const uniqueTypes = courseTypeIds.length;
  const summary = totalExpiringWorkers === 1
    ? `1 lavoratore ha un attestato in scadenza nei prossimi 90 giorni`
    : `${totalExpiringWorkers} lavoratori hanno attestati in scadenza nei prossimi 90 giorni`;

  res.json({
    summary,
    courses: result,
    expiring_workers_count: totalExpiringWorkers,
    course_types_count:     uniqueTypes,
  });
});

module.exports = router;
