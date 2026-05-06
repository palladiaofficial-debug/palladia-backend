'use strict';
/**
 * routes/v1/bookings.js
 * Modulo Formazione — prenotazioni corsi + integrazione Stripe Checkout.
 *
 * POST /api/v1/bookings/checkout   — crea prenotazione + Stripe Checkout Session
 * GET  /api/v1/bookings            — storico prenotazioni azienda
 * GET  /api/v1/bookings/:id        — dettaglio prenotazione
 * POST /api/v1/bookings/:id/cancel — cancella prenotazione pending
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurata');
  return require('stripe')(key);
}

router.use(verifySupabaseJwt);

// ── POST /api/v1/bookings/checkout ────────────────────────────────────────────

router.post('/bookings/checkout', async (req, res) => {
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
        id, title, price_cents,
        training_providers ( id, name, commission_rate )
      )
    `)
    .eq('id', session_id)
    .maybeSingle();

  if (sErr || !session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  if (session.is_cancelled)  return res.status(400).json({ error: 'SESSION_CANCELLED' });

  const spotsLeft = session.available_spots - (session.booked_spots || 0);
  if (spotsLeft < worker_ids.length) {
    return res.status(400).json({ error: 'NOT_ENOUGH_SPOTS', spots_left: spotsLeft });
  }

  if (new Date(session.start_date) < new Date()) {
    return res.status(400).json({ error: 'SESSION_EXPIRED' });
  }

  const course = session.marketplace_courses;
  const provider = course.training_providers;

  // Verify all workers belong to company
  const { data: workers, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name')
    .in('id', worker_ids)
    .eq('company_id', req.companyId);

  if (wErr || !workers || workers.length !== worker_ids.length) {
    return res.status(400).json({ error: 'INVALID_WORKERS' });
  }

  // Compute pricing
  const unitPrice      = course.price_cents;
  const totalPrice     = unitPrice * worker_ids.length;
  const commissionRate = provider.commission_rate || 15;
  const commissionCents = Math.round(totalPrice * commissionRate / 100);
  const providerPayout  = totalPrice - commissionCents;

  // Create booking records (one per worker)
  const bookingRows = workers.map(w => ({
    session_id,
    course_id:            course.id,
    worker_id:            w.id,
    site_id:              site_id || null,
    company_id:           req.companyId,
    status:               'pending',
    payment_status:       'unpaid',
    total_price_cents:    unitPrice,
    commission_cents:     Math.round(commissionCents / worker_ids.length),
    provider_payout_cents: Math.round(providerPayout / worker_ids.length),
    notes:                notes || null,
  }));

  const { data: bookings, error: bErr } = await supabase
    .from('course_bookings')
    .insert(bookingRows)
    .select('id');

  if (bErr) return res.status(500).json({ error: 'DB_ERROR', detail: bErr.message });

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
    // Rollback bookings
    await supabase.from('course_bookings').delete().in('id', bookings.map(b => b.id));
    return res.status(503).json({ error: 'STRIPE_ERROR', message: e.message });
  }

  res.status(201).json({ checkout_url: checkoutUrl, booking_ids: bookings.map(b => b.id) });
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
  res.json({ bookings: data || [], total: count || 0, limit, offset });
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

// ── POST /api/v1/bookings/:id/cancel ─────────────────────────────────────────

router.post('/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;

  const { data: booking } = await supabase
    .from('course_bookings')
    .select('id, status, payment_status, stripe_checkout_id')
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
  res.json({ ok: true });
});

module.exports = router;
