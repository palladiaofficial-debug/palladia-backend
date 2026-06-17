'use strict';
// ── Area Lavoratore (privata, autenticazione CF) ─────────────────────────────
// POST /api/v1/area/:code/auth           — login con codice fiscale
// GET  /api/v1/area/:code/profile        — profilo completo + documenti
// GET  /api/v1/area/:code/presence       — storico timbrature
// GET  /api/v1/area/:code/payslips       — buste paga condivise
// GET  /api/v1/area/:code/payslips/:id/pdf      — URL firmato PDF
// POST /api/v1/area/:code/payslips/:id/acknowledge — presa visione
// GET  /api/v1/area/:code/documents/:docId       — URL firmato documento
// ──────────────────────────────────────────────────────────────────────────────

const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase  = require('../../lib/supabase');
const { resolveWorkerByBadge } = require('../../lib/workerByBadge');
const { signWorkerToken, compareCf, verifyWorkerArea, TOKEN_TTL } = require('../../lib/workerAuth');
const { complianceStatus, overallStatus } = require('../../lib/compliance');

// ── Rate limit: 5 tentativi ogni 15 min per IP ──────────────────────────────
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

// ── POST /api/v1/area/:code/auth ─────────────────────────────────────────────
router.post('/area/:code/auth', authLimiter, async (req, res) => {
  const { code } = req.params;
  const { cf }   = req.body || {};

  if (!cf || typeof cf !== 'string' || cf.trim().length !== 16) {
    return res.status(400).json({ error: 'INVALID_CF', message: 'Il codice fiscale deve avere 16 caratteri.' });
  }

  const worker = await resolveWorkerByBadge(code);
  if (!worker) {
    return res.status(401).json({ error: 'AUTH_FAILED', message: 'Codice fiscale non corretto.' });
  }
  if (!worker.is_active) {
    return res.status(403).json({ error: 'WORKER_INACTIVE', message: 'Lavoratore non attivo.' });
  }

  const { data: full } = await supabase
    .from('workers')
    .select('fiscal_code')
    .eq('id', worker.id)
    .maybeSingle();

  if (!full?.fiscal_code || !compareCf(cf, full.fiscal_code)) {
    return res.status(401).json({ error: 'AUTH_FAILED', message: 'Codice fiscale non corretto.' });
  }

  const token = signWorkerToken({
    workerId:  worker.id,
    companyId: worker.company_id,
    badgeCode: code.toUpperCase(),
  });

  res.json({ token, expires_in: TOKEN_TTL });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tutti gli endpoint seguenti richiedono verifyWorkerArea
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/area/:code/profile ───────────────────────────────────────────
router.get('/area/:code/profile', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const { data: worker, error } = await supabase
    .from('workers')
    .select(`
      id, full_name, photo_url, fiscal_code, hire_date, birth_date, birth_place,
      qualification, role, employer_name, badge_code, is_active,
      safety_training_expiry, health_fitness_expiry,
      company:companies ( name )
    `)
    .eq('id', wid)
    .eq('company_id', cid)
    .maybeSingle();

  if (error || !worker) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: docs } = await supabase
    .from('worker_documents')
    .select('id, doc_type, name, expiry_date, file_path')
    .eq('worker_id', wid)
    .eq('company_id', cid)
    .order('doc_type');

  res.json({
    full_name:    worker.full_name,
    photo_url:    worker.photo_url || null,
    fiscal_code:  worker.fiscal_code,
    hire_date:    worker.hire_date || null,
    birth_date:   worker.birth_date || null,
    birth_place:  worker.birth_place || null,
    qualification: worker.qualification || null,
    role:          worker.role || null,
    employer_name: worker.employer_name || null,
    company_name:  worker.company?.name || null,
    badge_code:    worker.badge_code,
    is_active:     worker.is_active,
    safety_training_expiry: worker.safety_training_expiry || null,
    health_fitness_expiry:  worker.health_fitness_expiry || null,
    safety_training_status: complianceStatus(worker.safety_training_expiry),
    health_fitness_status:  complianceStatus(worker.health_fitness_expiry),
    overall_status: overallStatus(worker),
    documents: (docs || []).map(d => ({
      id:          d.id,
      doc_type:    d.doc_type,
      name:        d.name,
      expiry_date: d.expiry_date || null,
      has_file:    !!d.file_path,
    })),
  });
});

// ── GET /api/v1/area/:code/presence ──────────────────────────────────────────
router.get('/area/:code/presence', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const fromDate = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return res.status(400).json({ error: 'INVALID_DATE_RANGE' });
  }

  const { data: logs, error } = await supabase
    .from('presence_logs')
    .select('id, event_type, timestamp_server, site_id')
    .eq('company_id', cid)
    .eq('worker_id', wid)
    .gte('timestamp_server', `${fromDate}T00:00:00.000Z`)
    .lte('timestamp_server', `${toDate}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: false })
    .limit(1000);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!logs || logs.length === 0) return res.json([]);

  const siteIds = [...new Set(logs.map(l => l.site_id).filter(Boolean))];
  let siteMap = {};
  if (siteIds.length > 0) {
    const { data: sites } = await supabase.from('sites').select('id, name').in('id', siteIds);
    for (const s of sites || []) siteMap[s.id] = s.name || '—';
  }

  res.json(logs.map(l => ({
    id:               l.id,
    event_type:       l.event_type,
    timestamp_server: l.timestamp_server,
    site_name:        siteMap[l.site_id] || '—',
  })));
});

// ── GET /api/v1/area/:code/payslips ──────────────────────────────────────────
router.get('/area/:code/payslips', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const { data, error } = await supabase
    .from('payslips')
    .select('id, period_year, period_month, filename, status, note, shared_at, acknowledged_at')
    .eq('company_id', cid)
    .eq('worker_id', wid)
    .in('status', ['shared', 'acknowledged'])
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── GET /api/v1/area/:code/payslips/:id/pdf ──────────────────────────────────
router.get('/area/:code/payslips/:id/pdf', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path, status')
    .eq('id', req.params.id)
    .eq('company_id', cid)
    .eq('worker_id', wid)
    .in('status', ['shared', 'acknowledged'])
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents')
    .createSignedUrl(row.file_path, 3600);

  if (signErr || !signed?.signedUrl) return res.status(500).json({ error: 'SIGN_ERROR' });
  res.json({ url: signed.signedUrl });
});

// ── POST /api/v1/area/:code/payslips/:id/acknowledge ─────────────────────────
router.post('/area/:code/payslips/:id/acknowledge', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const { data: row } = await supabase
    .from('payslips')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', cid)
    .eq('worker_id', wid)
    .eq('status', 'shared')
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND_OR_ALREADY_ACKNOWLEDGED' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  const ua = req.headers['user-agent'] || '';

  const { error } = await supabase
    .from('payslips')
    .update({
      status:          'acknowledged',
      acknowledged_at: new Date().toISOString(),
      acknowledged_ip: ip.slice(0, 100),
      acknowledged_ua: ua.slice(0, 300),
      updated_at:      new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('company_id', cid);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, acknowledged_at: new Date().toISOString() });
});

// ── GET /api/v1/area/:code/documents/:docId ──────────────────────────────────
router.get('/area/:code/documents/:docId', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;

  const { data: doc } = await supabase
    .from('worker_documents')
    .select('id, file_path, name, mime_type')
    .eq('id', req.params.docId)
    .eq('worker_id', wid)
    .eq('company_id', cid)
    .maybeSingle();

  if (!doc || !doc.file_path) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents')
    .createSignedUrl(doc.file_path, 3600);

  if (signErr || !signed?.signedUrl) return res.status(500).json({ error: 'SIGN_ERROR' });
  res.json({ url: signed.signedUrl, name: doc.name, mime_type: doc.mime_type });
});

module.exports = router;
