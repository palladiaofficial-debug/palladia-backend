'use strict';
/**
 * routes/v1/bookings.js
 * Modulo Formazione — prenotazioni corsi + integrazione Stripe Checkout.
 *
 * POST /api/v1/bookings/checkout   — crea prenotazione + Stripe Checkout Session
 * GET  /api/v1/bookings            — storico prenotazioni azienda
 * GET  /api/v1/bookings/:id        — dettaglio prenotazione
 * GET  /api/v1/bookings/:id/ics    — file .ics per calendario
 * POST /api/v1/bookings/:id/cancel — cancella prenotazione pending
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { checkoutBookingSchema, reviewBookingSchema } = require('../../lib/schemas/bookings');

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'https://palladia.net').replace(/\/$/, '');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurata');
  return require('stripe')(key);
}

function buildIcs({ title, start, end, location, description, uid }) {
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Palladia//Formazione//IT',
    'BEGIN:VEVENT',
    `UID:${uid}@palladia.app`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(new Date(start))}`,
    `DTEND:${fmt(new Date(end))}`,
    `SUMMARY:${title}`,
    location ? `LOCATION:${location}` : '',
    description ? `DESCRIPTION:${description.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

router.use(verifySupabaseJwt);

// ── POST /api/v1/bookings/checkout ────────────────────────────────────────────

router.post('/bookings/checkout', validate(checkoutBookingSchema), async (req, res) => {
  const { session_id, worker_ids, site_id, notes } = req.body || {};

  if (!session_id || !Array.isArray(worker_ids) || worker_ids.length === 0) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'session_id e worker_ids obbligatori' });
  }
  if (worker_ids.length > 50) {
    return res.status(400).json({ error: 'TOO_MANY_WORKERS', message: 'Max 50 lavoratori per prenotazione' });
  }

  // Load session + course
  const { data: session, error: sErr } = await supabase
    .from('course_sessions')
    .select(`
      id, start_date, available_spots, booked_spots, is_cancelled,
      marketplace_courses (
        id, title, price_cents, consultant_id,
        training_providers ( id, name, commission_rate )
      )
    `)
    .eq('id', session_id)
    .maybeSingle();

  if (sErr || !session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  if (session.is_cancelled)  return res.status(400).json({ error: 'SESSION_CANCELLED' });

  if (new Date(session.start_date) < new Date()) {
    return res.status(400).json({ error: 'SESSION_EXPIRED' });
  }

  // Prenotazione atomica posti — previene overbooking da richieste concorrenti
  const { error: bookErr } = await supabase.rpc('book_session_atomic', {
    p_session_id:  session_id,
    p_num_workers: worker_ids.length,
  });
  if (bookErr) {
    const spotsLeft = session.available_spots - (session.booked_spots || 0);
    return res.status(400).json({ error: 'NOT_ENOUGH_SPOTS', spots_left: spotsLeft });
  }

  const course = session.marketplace_courses;
  const provider = course.training_providers;
  const isConsultantCourse = !!course.consultant_id;

  // Rilascia i posti riservati da book_session_atomic se un controllo successivo
  // fallisce — altrimenti la capacità del corso resta persa per sempre senza
  // nessuna prenotazione a spiegarlo (bug reale trovato 2026-07-11, vedi migrazione 131).
  const releaseSpots = () => supabase.rpc('release_session_spots', {
    p_session_id: session_id, p_num_workers: worker_ids.length,
  }).then(() => {}, () => {});

  if (!isConsultantCourse && !provider) {
    await releaseSpots();
    return res.status(400).json({ error: 'PROVIDER_NOT_FOUND', message: 'Corso senza provider associato' });
  }

  // Verify all workers belong to company
  const { data: workers, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name')
    .in('id', worker_ids)
    .eq('company_id', req.companyId);

  if (wErr || !workers || workers.length !== worker_ids.length) {
    await releaseSpots();
    return res.status(400).json({ error: 'INVALID_WORKERS' });
  }

  // Compute pricing
  const unitPrice          = course.price_cents;
  const totalPrice         = unitPrice * worker_ids.length;
  const commissionRate     = isConsultantCourse ? 15 : (provider?.commission_rate || 15);
  const commissionCents    = Math.round(totalPrice * commissionRate / 100);
  const payoutCents        = totalPrice - commissionCents;

  // Workers con dati completi per la prenotazione consulente (workers_data jsonb)
  const workersData = workers.map(w => ({
    worker_id:   w.id,
    worker_name: w.full_name,
  }));

  let bookings, bErr;

  if (isConsultantCourse) {
    // Per corsi consulente: UN singolo record di prenotazione con workers_data jsonb
    const { data: bData, error: bE } = await supabase
      .from('course_bookings')
      .insert({
        session_id,
        course_id:               course.id,
        company_id:              req.companyId,
        consultant_id:           course.consultant_id,
        workers_data:            workersData,
        participants_count:      workers.length,
        unit_price_cents:        unitPrice,
        total_price_cents:       totalPrice,
        commission_rate:         commissionRate,
        commission_cents:        commissionCents,
        consultant_payout_cents: payoutCents,
        status:                  'pending',
        payment_status:          'unpaid',
        notes:                   notes || null,
      })
      .select('id');

    bookings = bData;
    bErr     = bE;
  } else {
    // Per corsi provider: un record per lavoratore (comportamento esistente)
    const bookingRows = workers.map(w => ({
      session_id,
      course_id:             course.id,
      worker_id:             w.id,
      site_id:               site_id || null,
      company_id:            req.companyId,
      status:                'pending',
      payment_status:        'unpaid',
      total_price_cents:     unitPrice,
      commission_cents:      Math.round(commissionCents / workers.length),
      provider_payout_cents: Math.round(payoutCents / workers.length),
      notes:                 notes || null,
    }));

    const { data: bData, error: bE } = await supabase
      .from('course_bookings')
      .insert(bookingRows)
      .select('id');

    bookings = bData;
    bErr     = bE;
  }

  if (bErr) {
    await releaseSpots();
    return res.status(500).json({ error: 'DB_ERROR', detail: bErr.message });
  }

  const bookingIds = bookings.map(b => b.id).join(',');

  // Create Stripe Checkout Session
  let checkoutUrl;
  try {
    const stripe = getStripe();
    const startDate = new Date(session.start_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

    const stripeSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: unitPrice,
          product_data: {
            name: course.title,
            description: `${workers.length} lavorator${workers.length > 1 ? 'i' : 'e'} · ${startDate} · ${provider.name}`,
          },
        },
        quantity: workers.length,
      }],
      metadata: {
        booking_ids: bookingIds,
        company_id:  req.companyId,
        session_id,
      },
      success_url: `${FRONTEND_URL()}/formazione/prenotazioni?success=true&ids=${bookingIds}`,
      cancel_url:  `${FRONTEND_URL()}/formazione/marketplace/${course.id}?cancelled=true`,
    });

    // Save checkout session ID to bookings
    await supabase
      .from('course_bookings')
      .update({ stripe_checkout_id: stripeSession.id })
      .in('id', bookings.map(b => b.id));

    checkoutUrl = stripeSession.url;
  } catch (e) {
    console.error('[bookings] Stripe error:', e.message);
    // Rollback bookings + posti riservati
    await supabase.from('course_bookings').delete().in('id', bookings.map(b => b.id));
    await releaseSpots();
    return res.status(503).json({ error: 'STRIPE_ERROR', message: e.message });
  }

  res.status(201).json({ checkout_url: checkoutUrl, booking_ids: bookings.map(b => b.id) });
});

// ── GET /api/v1/bookings/active-workers ──────────────────────────────────────
// Ritorna i worker_id con prenotazioni pending/confirmed (per Scadenzario)

router.get('/bookings/active-workers', async (req, res) => {
  const { data } = await supabase
    .from('course_bookings')
    .select('worker_id, workers_data')
    .eq('company_id', req.companyId)
    .in('status', ['pending', 'confirmed']);

  const ids = new Set();
  for (const b of data || []) {
    if (b.worker_id) ids.add(b.worker_id);
    if (Array.isArray(b.workers_data)) {
      for (const w of b.workers_data) {
        if (w?.worker_id) ids.add(w.worker_id);
      }
    }
  }
  res.json({ worker_ids: [...ids] });
});

// ── GET /api/v1/bookings ──────────────────────────────────────────────────────

router.get('/bookings', async (req, res) => {
  const { status, limit: rawLimit = '50', offset: rawOffset = '0' } = req.query;
  const limit  = Math.min(parseInt(rawLimit,  10) || 50, 100);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  let query = supabase
    .from('course_bookings')
    .select(`
      id, status, payment_status, total_price_cents, booked_at, completed_at, notes,
      workers ( id, full_name ),
      sites   ( id, name ),
      marketplace_courses (
        id, title, duration_hours,
        training_providers ( id, name )
      ),
      course_sessions ( id, start_date, end_date )
    `, { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('booked_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  // Arricchisci con has_review per mostrare prompt recensione
  let reviewedIds = new Set();
  if (data?.length) {
    const { data: reviews } = await supabase
      .from('course_reviews')
      .select('booking_id')
      .eq('company_id', req.companyId);
    reviewedIds = new Set((reviews || []).map(r => r.booking_id));
  }
  const bookings = (data || []).map(b => ({ ...b, has_review: reviewedIds.has(b.id) }));
  res.json({ bookings, total: count || 0, limit, offset });
});

// ── GET /api/v1/bookings/:id/ics ─────────────────────────────────────────────

router.get('/bookings/:id/ics', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('course_bookings')
    .select(`
      id,
      marketplace_courses ( title, location_city, location_address ),
      course_sessions ( start_date, end_date )
    `)
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'NOT_FOUND' });

  const sess    = data.course_sessions;
  const course  = data.marketplace_courses;
  const location = [course?.location_address, course?.location_city].filter(Boolean).join(', ');

  const ics = buildIcs({
    title:       `Corso: ${course?.title || 'Formazione'}`,
    start:       sess?.start_date,
    end:         sess?.end_date,
    location,
    description: `Prenotazione Palladia #${id.slice(0, 8)}`,
    uid:         id,
  });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="corso-${id.slice(0, 8)}.ics"`);
  res.send(ics);
});

// ── GET /api/v1/bookings/:id ──────────────────────────────────────────────────

router.get('/bookings/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('course_bookings')
    .select(`
      *,
      workers ( id, full_name, fiscal_code ),
      sites   ( id, name ),
      marketplace_courses (
        *, training_providers (*)
      ),
      course_sessions ( * )
    `)
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ booking: data });
});

// ── POST /api/v1/bookings/:id/review ─────────────────────────────────────────

router.post('/bookings/:id/review', validate(reviewBookingSchema), async (req, res) => {
  const { id } = req.params;
  const { rating, comment } = req.body || {};

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'INVALID_RATING', message: 'rating deve essere tra 1 e 5' });
  }

  const { data: booking, error: bErr } = await supabase
    .from('course_bookings')
    .select('id, status, course_id, consultant_id, company_id, marketplace_courses(provider_id)')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (bErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'BOOKING_NOT_COMPLETED', message: 'Puoi recensire solo corsi completati' });
  }

  // Se corso consulente: risolvi user_id → consultant_profiles.id (FK)
  let consultantProfileId = null;
  if (booking.consultant_id) {
    const { data: cp } = await supabase
      .from('consultant_profiles')
      .select('id')
      .eq('user_id', booking.consultant_id)
      .maybeSingle();
    consultantProfileId = cp?.id || null;
  }

  const reviewRow = {
    booking_id:    id,
    course_id:     booking.course_id,
    company_id:    req.companyId,
    consultant_id: consultantProfileId,
    provider_id:   booking.marketplace_courses?.provider_id || null,
    rating:        parseInt(rating, 10),
    comment:       comment?.trim() || null,
  };

  const { data: review, error: rErr } = await supabase
    .from('course_reviews')
    .insert(reviewRow)
    .select('id')
    .maybeSingle();

  if (rErr) {
    if (rErr.code === '23505') return res.status(409).json({ error: 'ALREADY_REVIEWED' });
    return res.status(500).json({ error: 'DB_ERROR', detail: rErr.message });
  }

  // Aggiorna avg_rating sul consulente o sull'ente
  if (booking.consultant_id) {
    // Prima recupera consultant_profiles.id dal user_id
    const { data: profile } = await supabase
      .from('consultant_profiles')
      .select('id')
      .eq('user_id', booking.consultant_id)
      .maybeSingle();

    if (profile?.id) {
      const { data: stats } = await supabase
        .from('course_reviews')
        .select('rating')
        .eq('consultant_id', profile.id);

      if (stats?.length) {
        const avg = stats.reduce((s, r) => s + r.rating, 0) / stats.length;
        await supabase
          .from('consultant_profiles')
          .update({ avg_rating: Math.round(avg * 10) / 10, total_reviews: stats.length })
          .eq('id', profile.id);
      }
    }
  } else if (booking.marketplace_courses?.provider_id) {
    const { data: stats } = await supabase
      .from('course_reviews')
      .select('rating')
      .eq('provider_id', booking.marketplace_courses.provider_id);

    if (stats?.length) {
      const avg = stats.reduce((s, r) => s + r.rating, 0) / stats.length;
      await supabase
        .from('training_providers')
        .update({ rating: Math.round(avg * 10) / 10, total_reviews: stats.length })
        .eq('id', booking.marketplace_courses.provider_id);
    }
  }

  res.status(201).json({ review_id: review.id });
});

// ── POST /api/v1/bookings/:id/cancel ─────────────────────────────────────────

router.post('/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;

  const { data: booking } = await supabase
    .from('course_bookings')
    .select('id, status, payment_status, stripe_checkout_id, session_id, participants_count')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!booking)               return res.status(404).json({ error: 'NOT_FOUND' });
  if (booking.status !== 'pending' && booking.status !== 'confirmed') {
    return res.status(400).json({ error: 'CANNOT_CANCEL', message: 'Solo prenotazioni pending o confirmed possono essere cancellate' });
  }

  const { error } = await supabase
    .from('course_bookings')
    .update({ status: 'cancelled' })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Rilascia il posto occupato — mai fatto prima (bug reale trovato 2026-07-11,
  // vedi migrazione 131): senza questo una prenotazione cancellata restava
  // "occupata" per sempre, bloccando un posto che nessuno usava più.
  await supabase.rpc('release_session_spots', {
    p_session_id: booking.session_id, p_num_workers: booking.participants_count || 1,
  }).then(() => {}, () => {});

  res.json({ ok: true });
});

module.exports = router;
