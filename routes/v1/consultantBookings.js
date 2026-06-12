'use strict';
/**
 * routes/v1/consultantBookings.js
 * Seller center del consulente: dashboard KPI, prenotazioni ricevute, payouts,
 * upload attestati post-corso.
 *
 * GET  /api/v1/consultant/dashboard                          — KPI + alert scadenze clienti
 * GET  /api/v1/consultant/bookings                           — lista prenotazioni ricevute
 * GET  /api/v1/consultant/bookings/:id                       — dettaglio prenotazione
 * PATCH /api/v1/consultant/bookings/:id/confirm              — conferma prenotazione
 * POST /api/v1/consultant/bookings/:id/certificates          — carica attestati post-corso
 * GET  /api/v1/consultant/payouts                            — storico payouts
 * GET  /api/v1/consultant/balance                            — saldo disponibile
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifyConsultantJwt } = require('../../middleware/verifyConsultant');
const { sendCertificatesUploaded } = require('../../services/email');
const { validate } = require('../../middleware/validate');
const { uploadCertificatesSchema } = require('../../lib/schemas/consultantBookings');

router.use(verifyConsultantJwt);

// ── GET /api/v1/consultant/dashboard ──────────────────────────────────────────

router.get('/consultant/dashboard', async (req, res) => {
  const cid = req.consultantId;

  // Prenotazioni del mese corrente
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

  const [bookingsRes, clientsRes, coursesRes] = await Promise.all([
    // Tutte le prenotazioni del consulente
    supabase
      .from('course_bookings')
      .select('id, status, payment_status, total_price_cents, commission_rate, participants_count, booked_at, consultant_payout_cents')
      .eq('consultant_id', cid)
      .order('booked_at', { ascending: false }),

    // Imprese clienti attive
    supabase
      .from('consultant_clients')
      .select('id, company_id')
      .eq('consultant_id', cid)
      .eq('status', 'active'),

    // Corsi attivi
    supabase
      .from('marketplace_courses')
      .select('id, total_bookings, total_revenue_cents')
      .eq('consultant_id', cid)
      .eq('is_active', true)
      .eq('is_draft', false),
  ]);

  const bookings = bookingsRes.data || [];
  const clients  = clientsRes.data  || [];
  const courses  = coursesRes.data  || [];

  // KPI mese corrente
  const monthlyBookings = bookings.filter(b => new Date(b.booked_at) >= startOfMonth);
  const monthlyRevenue  = monthlyBookings
    .filter(b => b.payment_status === 'paid')
    .reduce((sum, b) => sum + (b.consultant_payout_cents || 0), 0);

  const totalBookings = bookings.filter(b => ['confirmed','completed'].includes(b.status)).length;

  // Ultime 5 prenotazioni
  const recentBookings = bookings.slice(0, 5);

  // Alert: clienti con attestati in scadenza nei prossimi 30 giorni
  const companyIds = clients.map(c => c.company_id).filter(Boolean);
  let expiryAlerts = [];

  if (companyIds.length > 0) {
    const in30 = new Date(); in30.setDate(in30.getDate() + 30);

    const { data: expiring } = await supabase
      .from('worker_certificates')
      .select(`
        id, expiry_date, company_id,
        workers ( id, full_name ),
        course_types ( id, name )
      `)
      .in('company_id', companyIds)
      .lte('expiry_date', in30.toISOString().slice(0, 10))
      .gte('expiry_date', new Date().toISOString().slice(0, 10))
      .order('expiry_date', { ascending: true })
      .limit(20);

    // Raggruppa per company_id
    const byCompany = {};
    for (const e of expiring || []) {
      if (!byCompany[e.company_id]) byCompany[e.company_id] = [];
      byCompany[e.company_id].push(e);
    }

    // Recupera nomi aziende
    if (Object.keys(byCompany).length > 0) {
      const { data: cos } = await supabase
        .from('companies')
        .select('id, name')
        .in('id', Object.keys(byCompany));

      for (const co of cos || []) {
        expiryAlerts.push({
          company_id:   co.id,
          company_name: co.name,
          count:        byCompany[co.id].length,
          certificates: byCompany[co.id].slice(0, 3),
        });
      }
    }
  }

  const consultant = req.consultant;
  const connectStatus = {
    configured:                 !!consultant.stripe_account_id,
    onboarding_complete:        consultant.stripe_onboarding_complete || false,
    charges_enabled:            consultant.stripe_charges_enabled || false,
    needs_setup:                !consultant.stripe_charges_enabled,
  };

  res.json({
    kpi: {
      monthly_revenue_cents:  monthlyRevenue,
      monthly_bookings:       monthlyBookings.length,
      active_courses:         courses.length,
      total_bookings:         totalBookings,
    },
    recent_bookings:  recentBookings,
    expiry_alerts:    expiryAlerts,
    active_clients:   clients.length,
    connect_status:   connectStatus,
  });
});

// ── GET /api/v1/consultant/bookings ───────────────────────────────────────────

router.get('/consultant/bookings', async (req, res) => {
  const { status, limit: rawLimit = '50', offset: rawOffset = '0' } = req.query;
  const limit  = Math.min(parseInt(rawLimit,  10) || 50, 100);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  let query = supabase
    .from('course_bookings')
    .select(`
      id, status, payment_status, total_price_cents, participants_count,
      unit_price_cents, commission_rate, consultant_payout_cents,
      workers_data, booked_at, confirmed_at, completed_at, notes,
      companies ( id, name ),
      marketplace_courses ( id, title, course_types ( name ) ),
      course_sessions ( id, start_date, end_date )
    `, { count: 'exact' })
    .eq('consultant_id', req.consultantId)
    .order('booked_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ bookings: data || [], total: count || 0, limit, offset });
});

// ── GET /api/v1/consultant/bookings/:id ───────────────────────────────────────

router.get('/consultant/bookings/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('course_bookings')
    .select(`
      *,
      companies ( id, name ),
      marketplace_courses ( *, course_types (*) ),
      course_sessions ( * )
    `)
    .eq('id', id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });

  // Carica gli attestati già caricati per questa prenotazione
  const { data: certs } = await supabase
    .from('booking_certificates')
    .select(`
      id, worker_id, uploaded_at,
      workers ( full_name ),
      worker_certificates ( id, issue_date, expiry_date, issuing_body, pdf_url )
    `)
    .eq('booking_id', id);

  res.json({ booking: data, certificates_uploaded: certs || [] });
});

// ── PATCH /api/v1/consultant/bookings/:id/confirm ────────────────────────────

router.patch('/consultant/bookings/:id/confirm', async (req, res) => {
  const { id } = req.params;

  const { data: booking } = await supabase
    .from('course_bookings')
    .select('id, status, payment_status, company_id')
    .eq('id', id)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
  if (booking.status !== 'pending') {
    return res.status(400).json({ error: 'INVALID_STATUS', message: 'Solo prenotazioni pending possono essere confermate' });
  }

  const { error } = await supabase
    .from('course_bookings')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── POST /api/v1/consultant/bookings/:id/certificates ─────────────────────────
// Dopo il corso, il consulente carica gli attestati dei partecipanti.
// Per ogni worker: crea worker_certificate + booking_certificate.

router.post('/consultant/bookings/:id/certificates', validate(uploadCertificatesSchema), async (req, res) => {
  const { id: bookingId } = req.params;
  const { certificates } = req.body || {};

  // [{worker_id, issue_date, issuing_body, certificate_number, pdf_url}]
  if (!Array.isArray(certificates) || certificates.length === 0) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'certificates array obbligatorio' });
  }

  const { data: booking } = await supabase
    .from('course_bookings')
    .select('id, status, company_id, workers_data, consultant_id, course_id')
    .eq('id', bookingId)
    .eq('consultant_id', req.consultantId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!['confirmed','pending'].includes(booking.status)) {
    return res.status(400).json({ error: 'INVALID_STATUS', message: 'Prenotazione non in stato valido per caricare attestati' });
  }

  // Recupera il course_type_id
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

  const created = [];

  for (const c of certificates) {
    if (!c.worker_id || !c.issue_date || !c.issuing_body) continue;

    // Calcola scadenza
    const expiryD = new Date(c.issue_date);
    if (ct?.validity_years) expiryD.setFullYear(expiryD.getFullYear() + ct.validity_years);
    const expiry_date = expiryD.toISOString().slice(0, 10);

    // Crea attestato
    const { data: cert, error: certErr } = await supabase
      .from('worker_certificates')
      .insert({
        company_id:         booking.company_id,
        worker_id:          c.worker_id,
        course_type_id:     course.course_type_id,
        issue_date:         c.issue_date,
        expiry_date,
        issuing_body:       c.issuing_body.trim(),
        certificate_number: c.certificate_number?.trim() || null,
        pdf_url:            c.pdf_url || null,
      })
      .select()
      .single();

    if (certErr) continue;

    // Collega attestato alla prenotazione
    await supabase
      .from('booking_certificates')
      .insert({
        booking_id:     bookingId,
        worker_id:      c.worker_id,
        certificate_id: cert.id,
        uploaded_by:    req.consultantId,
      });

    created.push(cert);
  }

  // Se tutti i certificati sono stati caricati, segna prenotazione come completed
  const expectedCount = booking.workers_data?.length || certificates.length;
  if (created.length >= expectedCount) {
    await supabase
      .from('course_bookings')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', bookingId);

    // Aggiorna totali sul corso
    await supabase.rpc('increment_course_totals', {
      p_course_id: booking.course_id,
      p_bookings:  1,
    }).catch(() => null);  // graceful — RPC opzionale
  }

  // Notifica l'impresa via email (fire & forget)
  try {
    const { data: cu } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', booking.company_id)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle();

    if (cu) {
      const { data: authUser } = await supabase.auth.admin.getUserById(cu.user_id);
      const email = authUser?.user?.email;
      if (email) {
        await sendCertificatesUploaded(email, {
          company_id:      booking.company_id,
          certificates_count: created.length,
          booking_id:      bookingId,
        });
      }
    }
  } catch (e) {
    console.error('[consultant-certs] email error:', e.message);
  }

  res.json({ ok: true, certificates_created: created.length, certificates: created });
});

// ── GET /api/v1/consultant/payouts ────────────────────────────────────────────

router.get('/consultant/payouts', async (req, res) => {
  const { data, error } = await supabase
    .from('consultant_payouts')
    .select('*')
    .eq('consultant_id', req.consultantId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ payouts: data || [] });
});

// ── GET /api/v1/consultant/balance ────────────────────────────────────────────

router.get('/consultant/balance', async (req, res) => {
  // Somma payout_cents delle prenotazioni completate e pagate non ancora in un payout
  const { data: bookings } = await supabase
    .from('course_bookings')
    .select('consultant_payout_cents, completed_at')
    .eq('consultant_id', req.consultantId)
    .eq('status', 'completed')
    .eq('payment_status', 'paid');

  const totalEarned = (bookings || []).reduce((sum, b) => sum + (b.consultant_payout_cents || 0), 0);

  const { data: payouts } = await supabase
    .from('consultant_payouts')
    .select('net_amount_cents')
    .eq('consultant_id', req.consultantId)
    .in('status', ['processing', 'paid']);

  const totalPaidOut = (payouts || []).reduce((sum, p) => sum + (p.net_amount_cents || 0), 0);

  // Prenotazioni in attesa di essere completate (pending/confirmed + paid)
  const { data: pending } = await supabase
    .from('course_bookings')
    .select('consultant_payout_cents')
    .eq('consultant_id', req.consultantId)
    .in('status', ['pending','confirmed'])
    .eq('payment_status', 'paid');

  const pendingAmount = (pending || []).reduce((sum, b) => sum + (b.consultant_payout_cents || 0), 0);

  res.json({
    available_cents: Math.max(0, totalEarned - totalPaidOut),
    pending_cents:   pendingAmount,
    total_earned_cents: totalEarned,
    total_paid_cents:   totalPaidOut,
  });
});

module.exports = router;
