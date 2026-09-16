'use strict';
// ── Area Pagamenti (pubblica, PIN) ────────────────────────────────────────────
// Accesso per chi fa i bonifici (spesso uno studio/professionista esterno,
// non un utente Palladia) alla lista buste paga condivise, per segnare cosa
// è stato pagato — stesso schema di sicurezza dell'area lavoratore
// (routes/v1/workerArea.js, F-102): un codice nell'URL + un PIN a 6 cifre
// generato dall'amministratore (migrazione 214, AUDIT.md).
//
// POST /api/v1/payer/:code/auth                      — login con PIN
// GET  /api/v1/payer/:code/payslips                   — buste paga condivise, tutte le aziende è sempre UNA sola (scope del codice)
// GET  /api/v1/payer/:code/payslips/:id/pdf           — URL firmato PDF
// POST /api/v1/payer/:code/payslips/:id/mark-paid     — segna pagata
// POST /api/v1/payer/:code/payslips/:id/mark-unpaid   — annulla
// ──────────────────────────────────────────────────────────────────────────────

const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase  = require('../../lib/supabase');
const { signPayerToken, verifyPayerArea, TOKEN_TTL } = require('../../lib/payerAuth');
const { verifyPin } = require('../../lib/pinHash');
const { auditLog } = require('../../lib/audit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Troppi tentativi. Riprova tra 15 minuti.' },
});

const areaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

// ── POST /api/v1/payer/:code/auth ─────────────────────────────────────────────
router.post('/payer/:code/auth', authLimiter, async (req, res) => {
  const { code } = req.params;
  const { pin }  = req.body || {};

  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin.trim())) {
    return res.status(400).json({ error: 'INVALID_PIN', message: 'Il PIN deve avere 6 cifre.' });
  }

  const { data: access } = await supabase
    .from('company_payer_access')
    .select('company_id, pin_hash')
    .eq('access_code', code.toUpperCase())
    .maybeSingle();

  if (!access) {
    return res.status(401).json({ error: 'AUTH_FAILED', message: 'PIN non corretto.' });
  }
  if (!access.pin_hash) {
    return res.status(401).json({ error: 'PIN_NOT_SET', message: 'PIN non ancora impostato. Contatta l\'azienda per riceverlo.' });
  }
  if (!(await verifyPin(pin.trim(), access.pin_hash))) {
    return res.status(401).json({ error: 'AUTH_FAILED', message: 'PIN non corretto.' });
  }

  const token = signPayerToken({ companyId: access.company_id, accessCode: code.toUpperCase() });

  auditLog({
    companyId: access.company_id, userId: null, userRole: 'payer',
    action: 'payer_area.login', targetType: 'company', targetId: access.company_id, req,
  });

  res.json({ token, expires_in: TOKEN_TTL });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tutti gli endpoint seguenti richiedono verifyPayerArea
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/payer/:code/payslips ─────────────────────────────────────────
// Solo buste paga già condivise/firmate (mai 'draft' — non ancora
// revisionate internamente, stesso confine di visibilità dell'area
// lavoratore su workerArea.js).
router.get('/payer/:code/payslips', areaLimiter, verifyPayerArea, async (req, res) => {
  const { cid } = req.payerPayload;

  const { data: rows, error } = await supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, status, payment_status, paid_at, paid_by')
    .eq('company_id', cid)
    .in('status', ['shared', 'acknowledged'])
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!rows?.length) return res.json([]);

  const workerIds = [...new Set(rows.map(r => r.worker_id))];
  const { data: workers } = await supabase
    .from('workers').select('id, full_name').in('id', workerIds).eq('company_id', cid);
  const nameById = Object.fromEntries((workers || []).map(w => [w.id, w.full_name]));

  const withNames = rows.map(r => ({ ...r, worker_name: nameById[r.worker_id] || null }));
  // Stesso motivo del lato azienda (routes/v1/payslips.js /payslips/shared):
  // il nome si risolve dopo la query, l'ordinamento per periodo+lavoratore
  // va rifatto qui per non lasciare i lavoratori in ordine arbitrario dentro
  // lo stesso mese.
  withNames.sort((a, b) =>
    b.period_year - a.period_year ||
    b.period_month - a.period_month ||
    (a.worker_name || '').localeCompare(b.worker_name || '', 'it'));

  res.json(withNames);
});

// ── GET /api/v1/payer/:code/payslips/:id/pdf ─────────────────────────────────
router.get('/payer/:code/payslips/:id/pdf', areaLimiter, verifyPayerArea, async (req, res) => {
  const { cid } = req.payerPayload;

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('company_id', cid)
    .in('status', ['shared', 'acknowledged'])
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents')
    .createSignedUrl(row.file_path, 3600);

  if (signErr || !signed?.signedUrl) return res.status(500).json({ error: 'SIGN_ERROR' });
  res.json({ url: signed.signedUrl });
});

// ── POST /api/v1/payer/:code/payslips/:id/mark-paid ──────────────────────────
router.post('/payer/:code/payslips/:id/mark-paid', areaLimiter, verifyPayerArea, async (req, res) => {
  const { cid } = req.payerPayload;

  const { data, error } = await supabase
    .from('payslips')
    .update({ payment_status: 'pagata', paid_at: new Date().toISOString(), paid_by: 'payer' })
    .eq('id', req.params.id).eq('company_id', cid)
    .in('status', ['shared', 'acknowledged'])
    .select('id').maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  auditLog({
    companyId: cid, userId: null, userRole: 'payer',
    action: 'payslip.mark_paid', targetType: 'payslips', targetId: req.params.id, req,
  });

  res.json({ ok: true });
});

// ── POST /api/v1/payer/:code/payslips/:id/mark-unpaid ────────────────────────
router.post('/payer/:code/payslips/:id/mark-unpaid', areaLimiter, verifyPayerArea, async (req, res) => {
  const { cid } = req.payerPayload;

  const { data, error } = await supabase
    .from('payslips')
    .update({ payment_status: 'da_pagare', paid_at: null, paid_by: null })
    .eq('id', req.params.id).eq('company_id', cid)
    .in('status', ['shared', 'acknowledged'])
    .select('id').maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  auditLog({
    companyId: cid, userId: null, userRole: 'payer',
    action: 'payslip.mark_unpaid', targetType: 'payslips', targetId: req.params.id, req,
  });

  res.json({ ok: true });
});

module.exports = router;
