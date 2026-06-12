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
const { sendExpiryAlert, sendSessionReminder } = require('../../services/email');
const { validate } = require('../../middleware/validate');
const {
  createCertificateSchema,
  updateCertificateSchema,
  patchNotificationReadSchema,
} = require('../../lib/schemas/certificates');

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

  // Load all their certificates (graceful if migration not yet run)
  const workerIds = workers.map(w => w.id);
  const { data: certs, error: cErr } = await supabase
    .from('worker_certificates')
    .select(`
      id, worker_id, expiry_date, issue_date, issuing_body, pdf_url,
      course_types ( name, validity_years, risk_level )
    `)
    .eq('company_id', companyId)
    .in('worker_id', workerIds.length > 0 ? workerIds : ['00000000-0000-0000-0000-000000000000']);

  // 42P01 = table does not exist (migration not run yet) — return empty gracefully
  if (cErr) {
    if (cErr.code === '42P01') {
      return res.json({ stats: { scaduti: 0, critici: 0, in_scadenza: 0, validi: 0 }, workers_at_risk: [], workers_ok: [] });
    }
    return res.status(500).json({ error: 'DB_ERROR', detail: cErr.message });
  }

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

router.post('/workers/:workerId/certificates', verifySupabaseJwt, validate(createCertificateSchema), async (req, res) => {
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

router.put('/certificates/:id', verifySupabaseJwt, validate(updateCertificateSchema), async (req, res) => {
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

  if (error) {
    if (error.code === '42P01') return res.json({ notifications: [], unread_count: 0 });
    return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  }

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

router.patch('/formazione/notifications/:id/read', verifySupabaseJwt, validate(patchNotificationReadSchema), async (req, res) => {
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

// ── GET /api/v1/formazione/export-csv — XLSX attestati formazione ─────────────
// Alias mantenuto per retrocompatibilità: risponde con XLSX (non più CSV).

router.get('/formazione/export-csv', verifySupabaseJwt, async (req, res) => {
  const ExcelJS = require('exceljs');

  const { data: certs, error } = await supabase
    .from('worker_certificates')
    .select(`
      id, issue_date, expiry_date, issuing_body, certificate_number, created_at,
      course_types ( name, risk_level, validity_years ),
      workers ( full_name, fiscal_code )
    `)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = String(d).slice(0, 10).split('-');
    return `${day}/${m}/${y}`;
  }

  const STATUS_STYLE = {
    valid:    { label: 'Valido',      bg: 'FF16A34A', fg: 'FFFFFFFF' },
    expiring: { label: 'In scadenza', bg: 'FFF59E0B', fg: 'FF000000' },
    expired:  { label: 'Scaduto',     bg: 'FFDC2626', fg: 'FFFFFFFF' },
    none:     { label: '—',           bg: 'FF6B7280', fg: 'FFFFFFFF' },
  };

  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();

  const sh = wb.addWorksheet('Formazione');
  sh.columns = [
    { header: 'Lavoratore',       width: 28 },
    { header: 'Codice Fiscale',   width: 18 },
    { header: 'Tipo Corso',       width: 32 },
    { header: 'Livello Rischio',  width: 14 },
    { header: 'Data Rilascio',    width: 13 },
    { header: 'Data Scadenza',    width: 13 },
    { header: 'Ente Erogatore',   width: 22 },
    { header: 'N. Attestato',     width: 16 },
    { header: 'Stato',            width: 14 },
    { header: 'Giorni Rimanenti', width: 14 },
  ];

  const hRow = sh.getRow(1);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF334E7C' } } };
  });

  sh.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  sh.autoFilter = { from: 'A1', to: 'J1' };

  for (const c of (certs || [])) {
    const st = certStatus(c.expiry_date);
    const style = STATUS_STYLE[st] || STATUS_STYLE.none;
    const days  = daysLeft(c.expiry_date);

    const row = sh.addRow([
      c.workers?.full_name      || '',
      c.workers?.fiscal_code    || '',
      c.course_types?.name      || '',
      c.course_types?.risk_level || '',
      fmtDate(c.issue_date),
      fmtDate(c.expiry_date),
      c.issuing_body            || '',
      c.certificate_number      || '',
      style.label,
      typeof days === 'number' ? days : '',
    ]);

    row.height = 20;
    const statoCell = row.getCell(9);
    statoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.bg } };
    statoCell.font = { bold: true, color: { argb: style.fg }, name: 'Calibri', size: 10 };
    statoCell.alignment = { horizontal: 'center', vertical: 'middle' };

    if (st === 'expired')  row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } };
    if (st === 'expiring') row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };

    if (row.number % 2 === 0) {
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum !== 9 && (!cell.fill?.fgColor || cell.fill.fgColor.argb === 'FFFFFFFF')) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
      });
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="formazione-${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── GET /api/v1/formazione/coverage ──────────────────────────────────────────

router.get('/formazione/coverage', verifySupabaseJwt, async (req, res) => {
  const { data: workers } = await supabase
    .from('workers')
    .select('id')
    .eq('company_id', req.companyId)
    .eq('is_active', true);

  const total = (workers || []).length;
  if (total === 0) return res.json({ coverage_pct: 100, workers_ok: 0, workers_issues: 0, total });

  const workerIds = workers.map(w => w.id);

  const { data: certs } = await supabase
    .from('worker_certificates')
    .select('worker_id, expiry_date')
    .eq('company_id', req.companyId)
    .in('worker_id', workerIds);

  // Un lavoratore è "ok" se ha almeno un attestato valido (non scaduto)
  const workerStatus = {};
  for (const c of certs || []) {
    const ok = certStatus(c.expiry_date) === 'valido';
    if (!workerStatus[c.worker_id]) workerStatus[c.worker_id] = { has_cert: true, all_ok: ok };
    else if (!ok) workerStatus[c.worker_id].all_ok = false;
  }

  let workersOk     = 0;
  let workersIssues = 0;

  for (const w of workers) {
    const ws = workerStatus[w.id];
    if (!ws || !ws.has_cert || !ws.all_ok) workersIssues++;
    else workersOk++;
  }

  res.json({
    coverage_pct:   Math.round((workersOk / total) * 100),
    workers_ok:     workersOk,
    workers_issues: workersIssues,
    total,
  });
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
  const companiesWithNew = new Set(); // company_id con nuove notifiche questa run

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
    companiesWithNew.add(cert.company_id);
  }

  // Group by company and send email SOLO alle company con nuove notifiche questa run.
  // Evita spam giornaliero verso company con scadenze già note ma non cambiate.
  const companiesMap = {};
  for (const cert of certs || []) {
    if (!companiesWithNew.has(cert.company_id)) continue;
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

  // ── Notifica consulenti collegati con clienti in scadenza ────────────────────
  // Per ogni impresa con scadenze, controlla se ha un consulente collegato
  // e invia notifica in-app al consulente (email separata — solo se ha corso disponibile)
  try {
    const companyIdsWithExpiry = [...new Set((certs || []).map(c => c.company_id))];

    if (companyIdsWithExpiry.length > 0) {
      const { data: consultantLinks } = await supabase
        .from('consultant_clients')
        .select('consultant_id, company_id, companies(name)')
        .in('company_id', companyIdsWithExpiry)
        .eq('status', 'active');

      // Raggruppa per consulente
      const byConsultant = {};
      for (const link of consultantLinks || []) {
        if (!byConsultant[link.consultant_id]) byConsultant[link.consultant_id] = [];
        byConsultant[link.consultant_id].push(link);
      }

      for (const [, links] of Object.entries(byConsultant)) {
        // Crea notifica in-app per il consulente
        for (const link of links) {
          // Salta se non ci sono nuove notifiche per questa company in questa run
          if (!companiesWithNew.has(link.company_id)) continue;
          const cert = (certs || []).find(c => c.company_id === link.company_id);
          if (!cert?.id) continue; // null-guard: nessun cert trovato per questa company
          await supabase.from('expiry_notifications').insert({
            certificate_id:    cert.id,
            worker_id:         cert.worker_id,
            company_id:        link.company_id,
            notification_type: '30_days',
          }).catch(() => null);
        }
      }
    }
  } catch (e) {
    console.error('[check-expiries] consultant notify error:', e.message);
  }

  // ── Promemoria sessioni nelle prossime 48h ────────────────────────────────
  try {
    const in48h = new Date(); in48h.setHours(in48h.getHours() + 48);
    const now   = new Date();

    const { data: upcomingSessions } = await supabase
      .from('course_sessions')
      .select(`
        id, start_date, end_date, location_override,
        marketplace_courses ( title, location_city, location_address )
      `)
      .gte('start_date', now.toISOString())
      .lte('start_date', in48h.toISOString())
      .eq('is_cancelled', false);

    for (const sess of upcomingSessions || []) {
      // Trova prenotazioni per questa sessione
      const { data: bookings } = await supabase
        .from('course_bookings')
        .select('company_id, workers_data, workers(full_name)')
        .eq('session_id', sess.id)
        .in('status', ['confirmed','pending'])
        .eq('payment_status', 'paid');

      for (const b of bookings || []) {
        const { data: cu } = await supabase
          .from('company_users')
          .select('user_id')
          .eq('company_id', b.company_id)
          .eq('role', 'owner')
          .limit(1)
          .maybeSingle();

        if (!cu) continue;
        const { data: authUser } = await supabase.auth.admin.getUserById(cu.user_id).catch(() => ({ data: null }));
        const email = authUser?.user?.email;
        if (!email) continue;

        const workers = b.workers_data?.map(w => w.worker_name) || [b.workers?.full_name].filter(Boolean);
        const location = sess.location_override || [sess.marketplace_courses?.location_address, sess.marketplace_courses?.location_city].filter(Boolean).join(', ');

        await sendSessionReminder(email, {
          courseName:  sess.marketplace_courses?.title || 'Corso di formazione',
          sessionDate: sess.start_date,
          location,
          workers,
        });
      }
    }
  } catch (e) {
    console.error('[check-expiries] session reminder error:', e.message);
  }

  console.log(`[check-expiries] notifiche create: ${sent}`);
  res.json({ ok: true, notifications_created: sent });
});

module.exports = router;
