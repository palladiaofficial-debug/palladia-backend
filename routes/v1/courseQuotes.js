'use strict';
/**
 * routes/v1/courseQuotes.js
 * Preventivi per corsi in cantiere (pricing_mode = 'quote').
 *
 * Lato impresa (JWT company):
 *   POST   /api/v1/marketplace/courses/:id/request-quote   — richiede preventivo
 *   GET    /api/v1/formazione/quotes                        — lista preventivi azienda
 *   GET    /api/v1/formazione/quotes/:id                    — dettaglio
 *   POST   /api/v1/formazione/quotes/:id/accept             — accetta + crea Stripe Checkout
 *   POST   /api/v1/formazione/quotes/:id/reject             — rifiuta
 *
 * Lato consulente (JWT consulente):
 *   GET    /api/v1/consultant/quotes                        — lista preventivi ricevuti
 *   PATCH  /api/v1/consultant/quotes/:id/respond            — risponde con prezzo
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { verifyConsultantJwt } = require('../../middleware/verifyConsultant');
const {
  sendQuoteRequestConsultant,
  sendQuoteReceivedCompany,
} = require('../../services/email');

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurata');
  return require('stripe')(key);
}

// ── POST /api/v1/marketplace/courses/:id/request-quote (impresa) ──────────────

router.post('/marketplace/courses/:id/request-quote', verifySupabaseJwt, async (req, res) => {
  const { id: courseId } = req.params;
  const { participants_count, site_address, preferred_dates, notes } = req.body || {};

  if (!participants_count || participants_count < 1 || !site_address?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'participants_count e site_address obbligatori' });
  }
  if (participants_count > 200) {
    return res.status(400).json({ error: 'TOO_MANY_PARTICIPANTS' });
  }

  const { data: course, error: cErr } = await supabase
    .from('marketplace_courses')
    .select(`
      id, title, pricing_mode, consultant_id, is_active, is_draft,
      training_providers ( email, name )
    `)
    .eq('id', courseId)
    .maybeSingle();

  if (cErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!course) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
  if (!course.is_active || course.is_draft) return res.status(400).json({ error: 'COURSE_NOT_AVAILABLE' });
  if (course.pricing_mode !== 'quote') {
    return res.status(400).json({ error: 'FIXED_PRICE_COURSE', message: 'Questo corso ha prezzo fisso — usa il checkout normale' });
  }
  if (!course.consultant_id) {
    return res.status(400).json({ error: 'NO_CONSULTANT', message: 'I preventivi in cantiere sono disponibili solo per corsi consulente' });
  }

  // Carica profilo consulente + dati impresa in parallelo
  const [profileRes, companyRes] = await Promise.all([
    supabase.from('consultant_profiles')
      .select('company_name')
      .eq('user_id', course.consultant_id)
      .maybeSingle(),
    supabase.from('companies')
      .select('name')
      .eq('id', req.companyId)
      .maybeSingle(),
  ]);

  // Crea la richiesta di preventivo
  const { data: quote, error: qErr } = await supabase
    .from('course_quote_requests')
    .insert({
      course_id:          courseId,
      consultant_id:      course.consultant_id, // auth uid
      company_id:         req.companyId,
      participants_count: parseInt(participants_count, 10),
      site_address:       site_address.trim(),
      preferred_dates:    preferred_dates?.trim() || null,
      notes:              notes?.trim() || null,
    })
    .select('id')
    .single();

  if (qErr) return res.status(500).json({ error: 'DB_ERROR', detail: qErr.message });

  // Email al consulente tramite auth.admin (service role)
  const quoteUrl = `${FRONTEND_URL()}/formazione/consulente/preventivi/${quote.id}`;
  try {
    const { data: consultantAuth } = await supabase.auth.admin.getUserById(course.consultant_id);
    if (consultantAuth?.user?.email) {
      await sendQuoteRequestConsultant({
        to:             consultantAuth.user.email,
        consultantName: profileRes.data?.company_name || 'Consulente',
        companyName:    companyRes.data?.name || 'Impresa',
        courseName:     course.title,
        participants:   parseInt(participants_count, 10),
        address:        site_address.trim(),
        preferredDates: preferred_dates?.trim() || null,
        notes:          notes?.trim() || null,
        quoteUrl,
      });
    }
  } catch (_) { /* email non bloccante */ }

  console.log(`[quotes] nuova richiesta ${quote.id} — consulente ${course.consultant_id}, impresa ${req.companyId}`);

  res.status(201).json({
    quote_id:    quote.id,
    message:     'Richiesta inviata — il consulente risponderà entro 48 ore',
    course_name: course.title,
  });
});

// ── GET /api/v1/formazione/quotes (impresa) ────────────────────────────────────

router.get('/formazione/quotes', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('course_quote_requests')
    .select(`
      id, status, participants_count, site_address, preferred_dates,
      quoted_price_cents, quoted_message, quoted_at, accepted_at, created_at, expires_at,
      marketplace_courses ( id, title, duration_hours ),
      consultant_profiles ( id, company_name, photo_url )
    `)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ quotes: data || [] });
});

// ── GET /api/v1/formazione/quotes/:id (impresa) ────────────────────────────────

router.get('/formazione/quotes/:id', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('course_quote_requests')
    .select(`
      *,
      marketplace_courses ( id, title, duration_hours, course_types (name) ),
      consultant_profiles ( id, company_name, photo_url, bio )
    `)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ quote: data });
});

// ── POST /api/v1/formazione/quotes/:id/accept (impresa) ───────────────────────

router.post('/formazione/quotes/:id/accept', verifySupabaseJwt, async (req, res) => {
  const { data: quote, error: qErr } = await supabase
    .from('course_quote_requests')
    .select(`
      id, status, quoted_price_cents, participants_count, course_id, consultant_id,
      marketplace_courses ( title, commission_rate )
    `)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (qErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!quote) return res.status(404).json({ error: 'NOT_FOUND' });
  if (quote.status !== 'quoted') return res.status(400).json({ error: 'NOT_QUOTED', message: 'Il preventivo non è ancora disponibile' });
  if (!quote.quoted_price_cents) return res.status(400).json({ error: 'NO_PRICE' });

  const totalCents      = quote.quoted_price_cents;
  const commissionRate  = 15;
  const commissionCents = Math.round(totalCents * commissionRate / 100);
  const payoutCents     = totalCents - commissionCents;

  // Crea booking senza session_id (corso in cantiere — no sessione schedulata)
  const { data: booking, error: bErr } = await supabase
    .from('course_bookings')
    .insert({
      course_id:               quote.course_id,
      company_id:              req.companyId,
      consultant_id:           quote.consultant_id,
      participants_count:      quote.participants_count,
      total_price_cents:       totalCents,
      commission_rate:         commissionRate,
      commission_cents:        commissionCents,
      consultant_payout_cents: payoutCents,
      status:                  'pending',
      payment_status:          'unpaid',
    })
    .select('id')
    .single();

  if (bErr) return res.status(500).json({ error: 'DB_ERROR', detail: bErr.message });

  // Stripe Checkout
  let checkoutUrl;
  try {
    const stripe     = getStripe();
    const session    = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency:     'eur',
          unit_amount:  totalCents,
          product_data: { name: quote.marketplace_courses?.title || 'Corso in cantiere', description: `${quote.participants_count} partecipanti` },
        },
        quantity: 1,
      }],
      metadata: {
        booking_ids: booking.id,
        company_id:  req.companyId,
        quote_id:    quote.id,
      },
      success_url: `${FRONTEND_URL()}/formazione/prenotazioni?success=true&ids=${booking.id}`,
      cancel_url:  `${FRONTEND_URL()}/formazione/preventivi/${quote.id}?cancelled=true`,
    });

    await supabase.from('course_bookings')
      .update({ stripe_checkout_id: session.id })
      .eq('id', booking.id);

    await supabase.from('course_quote_requests')
      .update({ status: 'accepted', accepted_at: new Date().toISOString(), booking_id: booking.id })
      .eq('id', quote.id);

    checkoutUrl = session.url;
  } catch (e) {
    console.error('[quotes/accept] Stripe error:', e.message);
    await supabase.from('course_bookings').delete().eq('id', booking.id);
    return res.status(503).json({ error: 'STRIPE_ERROR', message: e.message });
  }

  res.json({ checkout_url: checkoutUrl, booking_id: booking.id });
});

// ── POST /api/v1/formazione/quotes/:id/reject (impresa) ───────────────────────

router.post('/formazione/quotes/:id/reject', verifySupabaseJwt, async (req, res) => {
  const { data: quote } = await supabase
    .from('course_quote_requests')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!quote) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!['pending', 'quoted'].includes(quote.status)) {
    return res.status(400).json({ error: 'CANNOT_REJECT' });
  }

  await supabase.from('course_quote_requests')
    .update({ status: 'rejected', rejected_at: new Date().toISOString() })
    .eq('id', quote.id);

  res.json({ ok: true });
});

// ── GET /api/v1/consultant/quotes (consulente) ────────────────────────────────

router.get('/consultant/quotes', verifyConsultantJwt, async (req, res) => {
  const { status } = req.query;

  let query = supabase
    .from('course_quote_requests')
    .select(`
      id, status, participants_count, site_address, preferred_dates, notes,
      quoted_price_cents, quoted_at, accepted_at, created_at, expires_at,
      marketplace_courses ( id, title ),
      companies ( id, name )
    `)
    .eq('consultant_id', req.consultantId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ quotes: data || [] });
});

// ── PATCH /api/v1/consultant/quotes/:id/respond (consulente) ─────────────────

router.patch('/consultant/quotes/:id/respond', verifyConsultantJwt, async (req, res) => {
  const { quoted_price_cents, quoted_message } = req.body || {};

  if (!quoted_price_cents || quoted_price_cents < 100) {
    return res.status(400).json({ error: 'INVALID_PRICE', message: 'quoted_price_cents deve essere almeno 100 (€1)' });
  }

  const { data: quote, error: qErr } = await supabase
    .from('course_quote_requests')
    .select(`
      id, status, company_id, course_id,
      marketplace_courses ( title ),
      companies ( name )
    `)
    .eq('id', req.params.id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (qErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!quote) return res.status(404).json({ error: 'NOT_FOUND' });
  if (quote.status !== 'pending') {
    return res.status(400).json({ error: 'ALREADY_RESPONDED', message: 'Hai già risposto a questo preventivo' });
  }

  const { error: updateErr } = await supabase
    .from('course_quote_requests')
    .update({
      status:             'quoted',
      quoted_price_cents: parseInt(quoted_price_cents, 10),
      quoted_message:     quoted_message?.trim() || null,
      quoted_at:          new Date().toISOString(),
    })
    .eq('id', quote.id);

  if (updateErr) return res.status(500).json({ error: 'DB_ERROR' });

  const acceptUrl = `${FRONTEND_URL()}/formazione/preventivi/${quote.id}`;

  // Recupera email owner dell'impresa per la notifica
  let ownerEmail = null;
  try {
    const { data: ownerRows } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', quote.company_id)
      .eq('role', 'owner')
      .limit(1);

    if (ownerRows?.[0]?.user_id) {
      const { data: userResp } = await supabase.auth.admin.getUserById(ownerRows[0].user_id);
      ownerEmail = userResp?.user?.email || null;
    }
  } catch (_) { /* email non bloccante */ }

  if (ownerEmail) {
    await sendQuoteReceivedCompany({
      to:               ownerEmail,
      companyName:      quote.companies?.name  || 'Impresa',
      consultantName:   req.consultant.company_name || 'Il consulente',
      courseName:       quote.marketplace_courses?.title || 'Corso',
      quotedPriceCents: parseInt(quoted_price_cents, 10),
      quotedMessage:    quoted_message,
      acceptUrl,
    });
  }

  res.json({ ok: true });
});

module.exports = router;
