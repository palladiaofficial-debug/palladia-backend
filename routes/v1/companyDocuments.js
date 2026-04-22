'use strict';
/**
 * routes/v1/companyDocuments.js
 * Libreria documenti aziendali — caricati una volta, disponibili in tutti i cantieri.
 *
 * GET    /api/v1/company-documents              — lista
 * POST   /api/v1/company-documents              — upload
 * DELETE /api/v1/company-documents/:id          — elimina
 * GET    /api/v1/company-documents/:id/download — signed URL download
 */

const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const BUCKET   = 'site-documents'; // stesso bucket, path diverso
const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

const CATEGORIES = ['durc', 'visura', 'dvr', 'iso', 'soa', 'assicurazione', 'f24', 'altro'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp',
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

router.use(verifySupabaseJwt);

// ── GET lista ─────────────────────────────────────────────────────────────────

router.get('/company-documents', async (req, res) => {
  const { data, error } = await supabase
    .from('company_documents')
    .select('id, name, category, file_size, mime_type, created_at')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST upload ───────────────────────────────────────────────────────────────

router.post('/company-documents',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { category = 'altro' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'INVALID_CATEGORY' });

    const fileId   = crypto.randomUUID();
    const filename = safeName(req.file.originalname);
    const filePath = `${req.companyId}/_company/${fileId}-${filename}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

    const { data: doc, error: dbErr } = await supabase
      .from('company_documents')
      .insert([{
        company_id:  req.companyId,
        name:        req.file.originalname.slice(0, 500),
        category,
        file_path:   filePath,
        file_size:   req.file.size,
        mime_type:   req.file.mimetype,
        uploaded_by: req.user?.id || null,
      }])
      .select('id, name, category, file_size, mime_type, created_at')
      .single();

    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    res.status(201).json({ ok: true, document: doc });
  }
);

// ── DELETE ────────────────────────────────────────────────────────────────────

router.delete('/company-documents/:id', async (req, res) => {
  const { data: doc } = await supabase
    .from('company_documents')
    .select('id, file_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
  const { error } = await supabase
    .from('company_documents').delete()
    .eq('id', req.params.id).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── GET download (signed URL) ─────────────────────────────────────────────────

router.get('/company-documents/:id/download', async (req, res) => {
  const { data: doc } = await supabase
    .from('company_documents')
    .select('id, file_path, name')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(doc.file_path, 3600);
  if (signErr || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: signed.signedUrl, name: doc.name });
});

module.exports = router;
