'use strict';
// ── Buste Paga ─────────────────────────────────────────────────────────────────
// GET  /api/v1/workers/:workerId/payslips            — lista buste (JWT)
// POST /api/v1/workers/:workerId/payslips            — upload PDF (JWT, multipart)
// PATCH /api/v1/payslips/:id/share                  — condividi con lavoratore (JWT)
// PATCH /api/v1/payslips/:id/unshare                — ritira condivisione (JWT)
// DELETE /api/v1/payslips/:id                       — elimina (JWT)
//
// Endpoint pubblici (via badge code — no JWT):
// GET  /api/v1/badge/:code/payslips                 — buste condivise per il lavoratore
// GET  /api/v1/badge/:code/payslips/:id/pdf         — signed URL PDF
// POST /api/v1/badge/:code/payslips/:id/acknowledge — lavoratore firma (presa visione)
// ──────────────────────────────────────────────────────────────────────────────

const path   = require('path');
const multer = require('multer');
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { resolveWorkerByBadge } = require('../../lib/workerByBadge');

const BUCKET   = 'site-documents';  // usa il bucket già esistente con prefisso payslips/
const MAX_SIZE = 20 * 1024 * 1024;  // 20 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo PDF accettato per le buste paga'));
  },
});

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function verifyWorker(workerId, companyId) {
  const { data } = await supabase
    .from('workers').select('id').eq('id', workerId).eq('company_id', companyId).maybeSingle();
  return !!data;
}

async function signedUrl(filePath, expiresIn = 3600) {
  if (!filePath) return null;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, expiresIn);
  return data?.signedUrl ?? null;
}

const MONTH_NAMES = [
  '', 'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];

// ── GET /api/v1/workers/:workerId/payslips ────────────────────────────────────
router.get('/workers/:workerId/payslips', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  if (!isUuid(workerId)) return res.status(400).json({ error: 'INVALID_WORKER_ID' });
  if (!(await verifyWorker(workerId, req.companyId)))
    return res.status(403).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('payslips')
    .select('id, period_year, period_month, filename, file_size, status, note, shared_at, acknowledged_at, created_at')
    .eq('company_id', req.companyId)
    .eq('worker_id',  workerId)
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/workers/:workerId/payslips — upload PDF ──────────────────────
router.post(
  '/workers/:workerId/payslips',
  verifySupabaseJwt,
  upload.single('file'),
  async (req, res) => {
    const { workerId } = req.params;
    if (!isUuid(workerId)) return res.status(400).json({ error: 'INVALID_WORKER_ID' });
    if (!(await verifyWorker(workerId, req.companyId)))
      return res.status(403).json({ error: 'WORKER_NOT_FOUND' });

    const { period_year, period_month, note } = req.body;
    const year  = parseInt(period_year,  10);
    const month = parseInt(period_month, 10);

    if (isNaN(year) || year < 2020 || year > 2099)
      return res.status(400).json({ error: 'INVALID_YEAR' });
    if (isNaN(month) || month < 1 || month > 12)
      return res.status(400).json({ error: 'INVALID_MONTH' });
    if (!req.file)
      return res.status(400).json({ error: 'FILE_REQUIRED' });

    // Percorso storage: payslips/<company_id>/<worker_id>/<year>-<month>.pdf
    const safeMo   = String(month).padStart(2, '0');
    const filePath = `payslips/${req.companyId}/${workerId}/${year}-${safeMo}.pdf`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: 'application/pdf',
        upsert:      true,
      });

    if (upErr) {
      console.error('[payslips/upload] storage error:', upErr.message);
      return res.status(500).json({ error: 'STORAGE_ERROR' });
    }

    const { data: row, error: dbErr } = await supabase
      .from('payslips')
      .upsert({
        company_id:   req.companyId,
        worker_id:    workerId,
        uploaded_by:  req.user?.id ?? null,
        period_year:  year,
        period_month: month,
        filename:     req.file.originalname || `busta-paga-${year}-${safeMo}.pdf`,
        file_path:    filePath,
        file_size:    req.file.size,
        status:       'draft',
        note:         note?.trim() || null,
        updated_at:   new Date().toISOString(),
      }, {
        onConflict: 'company_id,worker_id,period_year,period_month',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (dbErr) {
      console.error('[payslips/upload] db error:', dbErr.message);
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    res.status(201).json(row);
  }
);

// ── PATCH /api/v1/payslips/:id/share — condividi con lavoratore ───────────────
router.patch('/payslips/:id/share', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { error } = await supabase
    .from('payslips')
    .update({ status: 'shared', shared_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', req.companyId)
    .neq('status', 'acknowledged');  // non si ritira una busta già firmata

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── PATCH /api/v1/payslips/:id/unshare — ritira condivisione ─────────────────
router.patch('/payslips/:id/unshare', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { error } = await supabase
    .from('payslips')
    .update({ status: 'draft', shared_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', req.companyId)
    .eq('status', 'shared');  // solo shared → draft, non acknowledged

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── DELETE /api/v1/payslips/:id ───────────────────────────────────────────────
router.delete('/payslips/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

  if (row.file_path) {
    await supabase.storage.from(BUCKET).remove([row.file_path]);
  }

  const { error } = await supabase
    .from('payslips')
    .delete()
    .eq('id', id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

// ═════════════════════════════════════════════════════════════════════════════
// ENDPOINT PUBBLICI (via badge code — no JWT)
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/badge/:code/payslips ─────────────────────────────────────────
router.get('/badge/:code/payslips', async (req, res) => {
  const worker = await resolveWorkerByBadge(req.params.code);
  if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
  if (!worker.is_active) return res.status(403).json({ error: 'WORKER_INACTIVE' });

  const { data, error } = await supabase
    .from('payslips')
    .select('id, period_year, period_month, filename, status, note, shared_at, acknowledged_at')
    .eq('company_id', worker.company_id)
    .eq('worker_id',  worker.id)
    .in('status', ['shared', 'acknowledged'])
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── GET /api/v1/badge/:code/payslips/:id/pdf — signed URL PDF ────────────────
router.get('/badge/:code/payslips/:id/pdf', async (req, res) => {
  const worker = await resolveWorkerByBadge(req.params.code);
  if (!worker || !worker.is_active) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path, status')
    .eq('id', req.params.id)
    .eq('company_id', worker.company_id)
    .eq('worker_id',  worker.id)
    .in('status', ['shared', 'acknowledged'])
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'PAYSLIP_NOT_FOUND' });

  const url = await signedUrl(row.file_path, 3600);
  if (!url) return res.status(500).json({ error: 'SIGN_ERROR' });

  res.json({ url });
});

// ── POST /api/v1/badge/:code/payslips/:id/acknowledge ────────────────────────
router.post('/badge/:code/payslips/:id/acknowledge', async (req, res) => {
  const worker = await resolveWorkerByBadge(req.params.code);
  if (!worker || !worker.is_active) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });

  const { data: row } = await supabase
    .from('payslips')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', worker.company_id)
    .eq('worker_id',  worker.id)
    .eq('status', 'shared')  // solo 'shared' può essere firmata
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
    .eq('company_id', worker.company_id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, acknowledged_at: new Date().toISOString() });
});

module.exports = router;
