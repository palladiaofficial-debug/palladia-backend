'use strict';
/**
 * routes/v1/certificates.js
 * Modulo Formazione — gestione attestati lavoratori + dashboard scadenze + cron notifiche.
 *
 * GET    /api/v1/formazione/dashboard              — stats + lavoratori a rischio
 * GET    /api/v1/workers/:workerId/certificates    — attestati singolo lavoratore
 * POST   /api/v1/workers/:workerId/certificates    — aggiungi attestato
 * PUT    /api/v1/certificates/:id                  — modifica attestato
 * DELETE /api/v1/certificates/:id                  — elimina attestato
 * GET    /api/v1/formazione/notifications          — notifiche in-app non lette
 * PATCH  /api/v1/formazione/notifications/:id/read — segna come letta
 * POST   /api/v1/notifications/check-expiries      — cron job giornaliero
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendExpiryAlert }   = require('../../services/email');

// ── Helpers ───────────────────────────────────────────────────────────────────

function certStatus(expiryDate) {
  const daysLeft = Math.floor((new Date(expiryDate) - Date.now()) / 86_400_000);
  if (daysLeft < 0)   return 'scaduto';
  if (daysLeft < 30)  return 'critico';
  if (daysLeft < 90)  return 'in_scadenza';
  return 'valido';
}

function daysLeft(expiryDate) {
  return Math.floor((new Date(expiryDate) - Date.now()) / 86_400_000);
}

function urgencySort(a, b) {
  // scaduto < critico < in_scadenza < valido
  const order = { scaduto: 0, critico: 1, in_scadenza: 2, valido: 3 };
  const aWorst = a.certificates.reduce((acc, c) => Math.min(acc, order[c.status] ?? 3), 3);
  const bWorst = b.certificates.reduce((acc, c) => Math.min(acc, order[c.status] ?? 3), 3);
  return aWorst - bWorst;
}

// ── Auth middleware ────────────────────────────────────────────────────────────

router.use([
  '/formazione',
  '/workers/:workerId/certificates',
  '/certificates',
], verifySupabaseJwt);

// ── GET /api/v1/formazione/dashboard ─────────────────────────────────────────

router.get('/formazione/dashboard', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  // Load all workers of the company
  const { data: workers, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name, photo_url, is_active')
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (wErr) return res.status(500).json({ error: 'DB_ERROR', detail: wErr.message });

  // Load all their certificates
  const workerIds = workers.map(w => w.id);
  const { data: certs, error: cErr } = await supabase
    .from('worker_certificates')
    .select(`
      id, worker_id, expiry_date, issue_date, issuing_body, pdf_url,
      course_types ( name, validity_years, risk_level )
    `)
    .eq('company_id', companyId)
    .in('worker_id', workerIds.length > 0 ? workerIds : ['00000000-0000-0000-0000-000000000000']);

  if (cErr) return res.status(500).json({ error: 'DB_ERROR', detail: cErr.message });

  // Build worker → certs map
  const certsByWorker = {};
  for (const cert of certs || []) {
    const st = certStatus(cert.expiry_date);
    const c = {
      id:              cert.id,
      course_type_name: cert.course_types?.name ?? 'Corso sconosciuto',
      risk_level:      cert.course_types?.risk_level ?? 'medio',
      expiry_date:     cert.expiry_date,
      status:          st,
      days_left:       daysLeft(cert.expiry_date),
      issuing_body:    cert.issuing_body,
      pdf_url:         cert.pdf_url,
    };
    if (!certsByWorker[cert.worker_id]) certsByWorker[cert.worker_id] = [];
    certsByWorker[cert.worker_id].push(c);
  }

  const stats = { scaduti: 0, critici: 0, in_scadenza: 0, validi: 0 };
  const workersAtRisk = [];
  const workersOk     = [];

  for (const w of workers) {
    const wCerts = certsByWorker[w.id] || [];
    const hasProblems = wCerts.some(c => c.status !== 'valido');

    for (const c of wCerts) {
      if (c.status === 'scaduto')     stats.scaduti++;
      else if (c.status === 'critico') stats.critici++;
      else if (c.status === 'in_scadenza') stats.in_scadenza++;
      else stats.validi++;
    }

    const workerObj = {
      worker_id:   w.id,
      worker_name: w.full_name,
      photo_url:   w.photo_url,
      certificates: wCerts.sort((a, b) => a.days_left - b.days_left),
    };

    if (hasProblems) workersAtRisk.push(workerObj);
    else             workersOk.push(workerObj);
  }

  workersAtRisk.sort(urgencySort);

  res.json({ stats, workers_at_risk: workersAtRisk, workers_ok: workersOk });
});

// ── GET /api/v1/workers/:workerId/certificates ────────────────────────────────

router.get('/workers/:workerId/certificates', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  // Verify worker belongs to company
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (wErr)    return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: certs, error: cErr } = await supabase
    .from('worker_certificates')
    .select(`
      id, issue_date, expiry_date, issuing_body, certificate_number, pdf_url, created_at,
      course_types ( id, name, legal_reference, validity_years, risk_level ),
      sites ( id, name )
    `)
    .eq('worker_id', workerId)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true });

  if (cErr) return res.status(500).json({ error: 'DB_ERROR', detail: cErr.message });

  const result = (certs || []).map(c => ({
    ...c,
    status:   certStatus(c.expiry_date),
    days_left: daysLeft(c.expiry_date),
  }));

  res.json({ worker, certificates: result });
});

// ── POST /api/v1/workers/:workerId/certificates ───────────────────────────────

router.post('/workers/:workerId/certificates', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  const { course_type_id, site_id, issue_date, issuing_body, certificate_number, pdf_url } = req.body || {};

  if (!course_type_id || !issue_date || !issuing_body) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'course_type_id, issue_date, issuing_body obbligatori' });
  }

  // Verify worker belongs to company
  const { data: worker } = await supabase
    .from('workers')
    .select('id')
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  // Get course type to compute expiry_date
  const { data: ct } = await supabase
    .from('course_types')
    .select('validity_years')
    .eq('id', course_type_id)
    .maybeSingle();

  if (!ct) return res.status(400).json({ error: 'INVALID_COURSE_TYPE' });

  // Compute expiry: issue_date + validity_years
  const issueD  = new Date(issue_date);
  const expiryD = new Date(issueD);
  expiryD.setFullYear(expiryD.getFullYear() + ct.validity_years);
  const expiry_date = expiryD.toISOString().slice(0, 10);

  const { data: cert, error } = await supabase
    .from('worker_certificates')
    .insert({
      company_id: req.companyId,
      worker_id:  workerId,
      course_type_id,
      site_id:    site_id || null,
      issue_date,
      expiry_date,
      issuing_body:       issuing_body.trim(),
      certificate_number: certificate_number?.trim() || null,
      pdf_url:            pdf_url || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  res.status(201).json({ ...cert, status: certStatus(cert.expiry_date), days_left: daysLeft(cert.expiry_date) });
});

// ── PUT /api/v1/certificates/:id ──────────────────────────────────────────────

router.put('/certificates/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  const { course_type_id, issue_date, issuing_body, certificate_number, pdf_url, site_id } = req.body || {};

  const { data: existing } = await supabase
    .from('worker_certificates')
    .select('id')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const updates = {};
  if (issuing_body)       updates.issuing_body = issuing_body.trim();
  if (certificate_number !== undefined) updates.certificate_number = certificate_number?.trim() || null;
  if (pdf_url !== undefined) updates.pdf_url = pdf_url;
  if (site_id !== undefined) updates.site_id = site_id;

  if (course_type_id && issue_date) {
    const { data: ct } = await supabase.from('course_types').select('validity_years').eq('id', course_type_id).maybeSingle();
    if (!ct) return res.status(400).json({ error: 'INVALID_COURSE_TYPE' });
    const expiryD = new Date(issue_date);
    expiryD.setFullYear(expiryD.getFullYear() + ct.validity_years);
    updates.course_type_id = course_type_id;
    updates.issue_date     = issue_date;
    updates.expiry_date    = expiryD.toISOString().slice(0, 10);
  } else if (issue_date) {
    updates.issue_date = issue_date;
  }

  const { data: cert, error } = await supabase
    .from('worker_certificates')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ ...cert, status: certStatus(cert.expiry_date), days_left: daysLeft(cert.expiry_date) });
});

// ── DELETE /api/v1/certificates/:id ──────────────────────────────────────────

router.delete('/certificates/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('worker_certificates')
    .select('id')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase.from('worker_certificates').delete().eq('id', id);
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(204).end();
});

// ── GET /api/v1/formazione/notifications ─────────────────────────────────────

router.get('/formazione/notifications', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('expiry_notifications')
    .select(`
      id, notification_type, sent_at, read_at, action_taken,
      worker_certificates ( expiry_date, course_types ( name ) ),
      workers ( full_name )
    `)
    .eq('company_id', req.companyId)
    .is('read_at', null)
    .order('sent_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  const notifications = (data || []).map(n => ({
    id:               n.id,
    notification_type: n.notification_type,
    sent_at:          n.sent_at,
    worker_name:      n.workers?.full_name ?? '',
    course_name:      n.worker_certificates?.course_types?.name ?? '',
    expiry_date:      n.worker_certificates?.expiry_date ?? '',
    action_taken:     n.action_taken,
  }));

  res.json({ notifications, unread_count: notifications.length });
});

// ── PATCH /api/v1/formazione/notifications/:id/read ──────────────────────────

router.patch('/formazione/notifications/:id/read', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  const { action_taken } = req.body || {};

  const { error } = await supabase
    .from('expiry_notifications')
    .update({ read_at: new Date().toISOString(), action_taken: action_taken || null })
    .eq('id', id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── POST /api/v1/notifications/check-expiries (cron) ─────────────────────────
// Chiamato ogni giorno alle 08:00 da un cron job Railway.
// Autenticazione via header X-Cron-Secret.

router.post('/notifications/check-expiries', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const today = new Date();
  const in7   = new Date(today); in7.setDate(in7.getDate() + 7);
  const in30  = new Date(today); in30.setDate(in30.getDate() + 30);
  const in90  = new Date(today); in90.setDate(in90.getDate() + 90);

  // Load all active certificates in scadenza o scaduti
  const { data: certs, error } = await supabase
    .from('worker_certificates')
    .select(`
      id, company_id, worker_id, expiry_date,
      course_types ( name ),
      workers ( full_name )
    `)
    .lte('expiry_date', in90.toISOString().slice(0, 10));

  if (error) {
    console.error('[check-expiries]', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  let sent = 0;
  const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (const cert of certs || []) {
    const days = daysLeft(cert.expiry_date);
    let notifType;
    if (days < 0)   notifType = 'expired';
    else if (days < 7)  notifType = '7_days';
    else if (days < 30) notifType = '30_days';
    else notifType = '90_days';

    // Check if already sent in last 7 days
    const { data: existing } = await supabase
      .from('expiry_notifications')
      .select('id')
      .eq('certificate_id', cert.id)
      .eq('notification_type', notifType)
      .gte('sent_at', sevenDaysAgo.toISOString())
      .maybeSingle();

    if (existing) continue;

    // Create in-app notification record
    await supabase.from('expiry_notifications').insert({
      certificate_id:    cert.id,
      worker_id:         cert.worker_id,
      company_id:        cert.company_id,
      notification_type: notifType,
    });

    sent++;
  }

  // Group by company and send email to company owner
  const companiesMap = {};
  for (const cert of certs || []) {
    if (!companiesMap[cert.company_id]) companiesMap[cert.company_id] = [];
    companiesMap[cert.company_id].push(cert);
  }

  for (const [companyId, companyCerts] of Object.entries(companiesMap)) {
    try {
      // Get owner email
      const { data: cu } = await supabase
        .from('company_users')
        .select('user_id')
        .eq('company_id', companyId)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle();

      if (!cu) continue;
      const { data: authUser } = await supabase.auth.admin.getUserById(cu.user_id);
      const email = authUser?.user?.email;
      if (!email) continue;

      await sendExpiryAlert(email, companyCerts);
    } catch (e) {
      console.error('[check-expiries] email error:', e.message);
    }
  }

  console.log(`[check-expiries] notifiche create: ${sent}`);
  res.json({ ok: true, notifications_created: sent });
});

module.exports = router;
