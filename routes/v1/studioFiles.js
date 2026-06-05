'use strict';
/**
 * routes/v1/studioFiles.js
 * Upload e gestione file per Studio CDL:
 *   - Documenti condivisi con l'impresa cliente (studio_shared_documents)
 *   - Cedolini paga (payslips)
 *
 * CDL routes (verifyStudioJwt):
 *   GET    /studio/clients/:companyId/shared-docs
 *   POST   /studio/clients/:companyId/shared-docs
 *   DELETE /studio/clients/:companyId/shared-docs/:id
 *   GET    /studio/clients/:companyId/payslips
 *   POST   /studio/clients/:companyId/payslips
 *   DELETE /studio/clients/:companyId/payslips/:id
 *
 * Impresa route (verifySupabaseJwt):
 *   GET    /studio/docs-for-me              — documenti condivisi dal CDL per questa impresa
 *   GET    /studio/payslips-for-me          — cedolini del CDL per questa impresa
 */

const crypto  = require('crypto');
const path    = require('path');
const multer  = require('multer');
const router  = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifyStudioJwt }    = require('../../middleware/verifyStudio');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');

const BUCKET   = 'site-documents';
const MAX_SIZE = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo file non supportato. Usa PDF, immagini o documenti Word.'));
  },
});

function safeName(original) {
  const ext  = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base + ext;
}

function multerUpload(req, res, next) {
  upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Helper — verifica accesso studio→impresa
async function checkAccess(studioId, companyId) {
  const { data } = await supabase
    .from('studio_clients')
    .select('id')
    .eq('studio_id', studioId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();
  return !!data;
}

// ── SHARED DOCS — CDL routes ──────────────────────────────────────────────────

router.get('/studio/clients/:companyId/shared-docs', verifyStudioJwt, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data, error } = await supabase
    .from('studio_shared_documents')
    .select('id, name, description, category, file_size, mime_type, created_at')
    .eq('studio_id', req.studioId)
    .eq('company_id', req.params.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.post('/studio/clients/:companyId/shared-docs', verifyStudioJwt, multerUpload, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { name, description, category = 'altro' } = req.body;
  const docName = (name?.trim() || req.file.originalname).slice(0, 200);

  const fileId   = crypto.randomUUID();
  const filename = safeName(req.file.originalname);
  const filePath = `studio-shared/${req.studioId}/${req.params.companyId}/${fileId}-${filename}`;

  const { error: storageErr } = await supabase.storage
    .from(BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

  const { data: doc, error: dbErr } = await supabase
    .from('studio_shared_documents')
    .insert([{
      studio_id:   req.studioId,
      company_id:  req.params.companyId,
      name:        docName,
      description: description?.trim() || null,
      category,
      file_path:   filePath,
      file_size:   req.file.size,
      mime_type:   req.file.mimetype,
      created_by:  req.user?.id || null,
    }])
    .select('id, name, description, category, file_size, mime_type, created_at')
    .single();

  if (dbErr) {
    supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  res.status(201).json({ ok: true, document: doc });
});

router.delete('/studio/clients/:companyId/shared-docs/:id', verifyStudioJwt, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data: doc } = await supabase
    .from('studio_shared_documents')
    .select('id, file_path')
    .eq('id', req.params.id)
    .eq('studio_id', req.studioId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
  await supabase.from('studio_shared_documents').delete().eq('id', doc.id);
  res.json({ ok: true });
});

// ── PAYSLIPS — CDL routes ─────────────────────────────────────────────────────

router.get('/studio/clients/:companyId/payslips', verifyStudioJwt, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data, error } = await supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, file_size, created_at, workers(full_name)')
    .eq('studio_id', req.studioId)
    .eq('company_id', req.params.companyId)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.post('/studio/clients/:companyId/payslips', verifyStudioJwt, multerUpload, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { worker_id, period_year, period_month } = req.body;
  const year  = parseInt(period_year);
  const month = parseInt(period_month);
  if (!year || year < 2000 || year > 2100) return res.status(400).json({ error: 'INVALID_YEAR' });
  if (!month || month < 1 || month > 12)   return res.status(400).json({ error: 'INVALID_MONTH' });

  const fileId   = crypto.randomUUID();
  const filename = safeName(req.file.originalname);
  const filePath = `payslips/${req.studioId}/${req.params.companyId}/${year}/${month.toString().padStart(2,'0')}/${fileId}-${filename}`;

  const { error: storageErr } = await supabase.storage
    .from(BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

  const { data: slip, error: dbErr } = await supabase
    .from('payslips')
    .insert([{
      studio_id:    req.studioId,
      company_id:   req.params.companyId,
      worker_id:    worker_id || null,
      period_year:  year,
      period_month: month,
      filename:     req.file.originalname.slice(0, 200),
      file_path:    filePath,
      file_size:    req.file.size,
    }])
    .select('id, worker_id, period_year, period_month, filename, file_size, created_at')
    .single();

  if (dbErr) {
    supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  res.status(201).json({ ok: true, payslip: slip });
});

router.delete('/studio/clients/:companyId/payslips/:id', verifyStudioJwt, async (req, res) => {
  if (!await checkAccess(req.studioId, req.params.companyId))
    return res.status(403).json({ error: 'ACCESS_DENIED' });

  const { data: slip } = await supabase
    .from('payslips')
    .select('id, file_path')
    .eq('id', req.params.id)
    .eq('studio_id', req.studioId)
    .maybeSingle();
  if (!slip) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([slip.file_path]).catch(() => {});
  await supabase.from('payslips').delete().eq('id', slip.id);
  res.json({ ok: true });
});

// ── DOWNLOAD signed URL ───────────────────────────────────────────────────────

async function signedUrl(table, idField, studioId, companyId, docId) {
  const { data: doc } = await supabase.from(table).select('file_path')
    .eq('id', docId)
    .eq(idField === 'studio' ? 'studio_id' : 'company_id', idField === 'studio' ? studioId : companyId)
    .maybeSingle();
  if (!doc) return null;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
  return data?.signedUrl || null;
}

router.get('/studio/clients/:companyId/shared-docs/:id/download', verifyStudioJwt, async (req, res) => {
  const url = await signedUrl('studio_shared_documents', 'studio', req.studioId, req.params.companyId, req.params.id);
  if (!url) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ url });
});

router.get('/studio/clients/:companyId/payslips/:id/download', verifyStudioJwt, async (req, res) => {
  const url = await signedUrl('payslips', 'studio', req.studioId, req.params.companyId, req.params.id);
  if (!url) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ url });
});

// ── IMPRESA — vedi docs condivisi dal CDL ─────────────────────────────────────

router.get('/studio/docs-for-me', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('studio_shared_documents')
    .select('id, name, description, category, file_size, mime_type, created_at, studio_partners(studio_name)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.get('/studio/docs-for-me/:id/download', verifySupabaseJwt, async (req, res) => {
  const { data: doc } = await supabase
    .from('studio_shared_documents')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
  if (!data?.signedUrl) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: data.signedUrl });
});

router.get('/studio/payslips-for-me', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, file_size, created_at, workers(full_name)')
    .eq('company_id', req.companyId)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.get('/studio/payslips-for-me/:id/download', verifySupabaseJwt, async (req, res) => {
  const { data: slip } = await supabase
    .from('payslips')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!slip) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(slip.file_path, 300);
  if (!data?.signedUrl) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: data.signedUrl });
});

module.exports = router;
