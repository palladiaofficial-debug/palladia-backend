'use strict';
// ── Area Pagamenti (pubblica, magic link via email) ──────────────────────────
// Accesso per chi fa i bonifici (spesso uno studio/professionista esterno,
// non un utente Palladia) alla lista buste paga condivise, per segnare cosa
// è stato pagato — stesso schema già collaudato in produzione per il
// Portale Professionisti (coordinator_pro_sessions, routes/v1/coordinatorPro.js).
//
// Sostituisce il link+PIN della migrazione 214 (AUDIT.md, F-204 e seguenti):
// il PIN era tecnicamente corretto ma nella pratica ha causato ore di
// confusione reale — ogni rigenerazione creava un nuovo link, l'azienda
// doveva ricopiarlo a mano su WhatsApp, il destinatario riapriva un
// messaggio vecchio dalla stessa chat. Qui l'unico modo di ottenere un link
// è riceverlo via email diretta (POST /payslips/payer-invite, lato azienda)
// — nessun copia-incolla manuale in mezzo, e più inviti allo stesso
// indirizzo restano TUTTI validi (non si invalidano a vicenda) finché non
// scadono o vengono revocati esplicitamente.
//
// GET  /api/v1/payer/:token/payslips                   — buste paga condivise
// GET  /api/v1/payer/:token/payslips/:id/pdf            — URL firmato PDF
// POST /api/v1/payer/:token/payslips/:id/mark-paid      — segna pagata
// POST /api/v1/payer/:token/payslips/:id/mark-unpaid    — annulla
//
// F-212 (AUDIT.md, 2026-09-17): il titolare ha segnalato che un singolo link
// valeva 365 giorni e dava accesso a TUTTE le buste paga di TUTTI i
// lavoratori con la sola email come barriera — un refuso o un inoltro
// esponevano un anno intero di dati molto sensibili. Due mitigazioni senza
// nuova infrastruttura (niente SMS/OTP, valutato ma costoso):
//   1. Finestra SCORREVOLE di 30 giorni invece di una fissa a 365: ogni uso
//      valido estende la scadenza di altri 30 giorni (verifyPayerToken sotto)
//      — un link usato regolarmente non scade mai in pratica, uno inviato
//      per errore e mai aperto muore da solo entro 30 giorni. Nessun bottone
//      "rinnova" da premere, nessun nuovo link da rimandare via email —
//      esattamente il problema del vecchio sistema PIN (migrazione 214) che
//      non si vuole ripetere.
//   2. Storico visibile ristretto agli ultimi VISIBLE_MONTHS mesi (lista, PDF
//      e le due azioni di stato) invece dell'intera vita dell'azienda — un
//      link compromesso espone una finestra limitata, non un archivio intero.
// ──────────────────────────────────────────────────────────────────────────────

const crypto    = require('crypto');
const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase  = require('../../lib/supabase');
const { auditLog } = require('../../lib/audit');

const areaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

const SLIDING_WINDOW_DAYS = 30;
const VISIBLE_MONTHS      = 6;

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}

async function resolvePayerSession(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('payslip_payer_sessions')
    .select('id, company_id, email')
    .eq('token_hash', hashToken(token))
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

async function verifyPayerToken(req, res, next) {
  const session = await resolvePayerSession(req.params.token);
  if (!session) {
    return res.status(401).json({ error: 'LINK_INVALID', message: 'Questo link non è più valido. Chiedi all\'azienda di inviartene uno nuovo.' });
  }
  req.payerSession = session;
  const newExpiry = new Date(Date.now() + SLIDING_WINDOW_DAYS * 86400000).toISOString();
  supabase.from('payslip_payer_sessions').update({ last_used_at: new Date().toISOString(), expires_at: newExpiry }).eq('id', session.id)
    .then(() => {}).catch(() => {});
  next();
}

// Solo gli ultimi VISIBLE_MONTHS mesi — cutoff calcolato su anno/mese
// (payslips non ha una colonna data singola), stesso principio per lista,
// PDF e le due azioni di stato sotto: un ID già noto non deve bastare ad
// aggirare la finestra.
function visiblePeriodCutoff() {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - VISIBLE_MONTHS, 1);
  return { year: cutoff.getFullYear(), month: cutoff.getMonth() + 1 };
}
function applyVisibleWindow(query) {
  const { year, month } = visiblePeriodCutoff();
  return query.or(`period_year.gt.${year},and(period_year.eq.${year},period_month.gte.${month})`);
}

// ── GET /api/v1/payer/:token/payslips ─────────────────────────────────────────
// Solo buste paga già condivise/firmate (mai 'draft' — non ancora
// revisionate internamente, stesso confine di visibilità dell'area
// lavoratore su workerArea.js). Anche l'unico controllo di validità del
// link: aprirlo la prima volta E ogni volta dopo passano da qui, stesso
// principio di ProMagicLink.tsx (repo frontend).
router.get('/payer/:token/payslips', areaLimiter, verifyPayerToken, async (req, res) => {
  const { company_id: cid } = req.payerSession;

  const { data: rows, error } = await applyVisibleWindow(supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, status, payment_status, paid_at, paid_by')
    .eq('company_id', cid)
    .in('status', ['shared', 'acknowledged']))
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!rows?.length) return res.json([]);

  const workerIds = [...new Set(rows.map(r => r.worker_id))];
  const { data: workers } = await supabase
    .from('workers').select('id, full_name').in('id', workerIds).eq('company_id', cid);
  const nameById = Object.fromEntries((workers || []).map(w => [w.id, w.full_name]));

  const withNames = rows.map(r => ({ ...r, worker_name: nameById[r.worker_id] || null }));
  // Il nome si risolve dopo la query, l'ordinamento per periodo+lavoratore
  // va rifatto qui per non lasciare i lavoratori in ordine arbitrario dentro
  // lo stesso mese.
  withNames.sort((a, b) =>
    b.period_year - a.period_year ||
    b.period_month - a.period_month ||
    (a.worker_name || '').localeCompare(b.worker_name || '', 'it'));

  res.json(withNames);
});

// ── GET /api/v1/payer/:token/payslips/:id/pdf ─────────────────────────────────
router.get('/payer/:token/payslips/:id/pdf', areaLimiter, verifyPayerToken, async (req, res) => {
  const { company_id: cid } = req.payerSession;

  const { data: row } = await applyVisibleWindow(supabase
    .from('payslips')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('company_id', cid)
    .in('status', ['shared', 'acknowledged']))
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents')
    .createSignedUrl(row.file_path, 3600);

  if (signErr || !signed?.signedUrl) return res.status(500).json({ error: 'SIGN_ERROR' });
  res.json({ url: signed.signedUrl });
});

// ── POST /api/v1/payer/:token/payslips/:id/mark-paid ──────────────────────────
router.post('/payer/:token/payslips/:id/mark-paid', areaLimiter, verifyPayerToken, async (req, res) => {
  const { company_id: cid, email } = req.payerSession;

  const { data, error } = await applyVisibleWindow(supabase
    .from('payslips')
    .update({ payment_status: 'pagata', paid_at: new Date().toISOString(), paid_by: 'payer' })
    .eq('id', req.params.id).eq('company_id', cid)
    .in('status', ['shared', 'acknowledged']))
    .select('id').maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  auditLog({
    companyId: cid, userId: null, userRole: 'payer',
    action: 'payslip.mark_paid', targetType: 'payslips', targetId: req.params.id,
    payload: { email }, req,
  });

  res.json({ ok: true });
});

// ── POST /api/v1/payer/:token/payslips/:id/mark-unpaid ────────────────────────
router.post('/payer/:token/payslips/:id/mark-unpaid', areaLimiter, verifyPayerToken, async (req, res) => {
  const { company_id: cid, email } = req.payerSession;

  const { data, error } = await applyVisibleWindow(supabase
    .from('payslips')
    .update({ payment_status: 'da_pagare', paid_at: null, paid_by: null })
    .eq('id', req.params.id).eq('company_id', cid)
    .in('status', ['shared', 'acknowledged']))
    .select('id').maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  auditLog({
    companyId: cid, userId: null, userRole: 'payer',
    action: 'payslip.mark_unpaid', targetType: 'payslips', targetId: req.params.id,
    payload: { email }, req,
  });

  res.json({ ok: true });
});

module.exports = router;
