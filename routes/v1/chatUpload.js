'use strict';
const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const BUCKET   = 'site-documents';
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo file non supportato. Usa PDF, immagini, Word o Excel.'));
  },
});

function safeName(original) {
  const ext  = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base + ext;
}

router.use(verifySupabaseJwt);

// ── POST /api/v1/chat/upload ─────────────────────────────────────────────────
router.post('/chat/upload',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const fileId      = crypto.randomUUID();
    const filename    = safeName(req.file.originalname);
    const storagePath = `${req.companyId}/chat-uploads/${fileId}-${filename}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert:      false,
      });
    if (storageErr) {
      console.error('[chatUpload] storage error:', storageErr.message);
      return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });
    }

    const { data: record, error: dbErr } = await supabase
      .from('chat_uploads')
      .insert({
        company_id:    req.companyId,
        user_id:       req.user.id,
        original_name: req.file.originalname,
        mime_type:     req.file.mimetype,
        storage_path:  storagePath,
        size_bytes:    req.file.size,
      })
      .select('id')
      .single();

    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    // Pulizia asincrona: rimuove upload > 24h non archiviati
    supabase.from('chat_uploads')
      .select('id, storage_path')
      .eq('company_id', req.companyId)
      .eq('archived', false)
      .lt('created_at', new Date(Date.now() - 86400000).toISOString())
      .then(({ data: stale }) => {
        if (!stale?.length) return;
        const paths = stale.map(s => s.storage_path);
        supabase.storage.from(BUCKET).remove(paths).catch(() => {});
        supabase.from('chat_uploads').delete()
          .in('id', stale.map(s => s.id)).catch(() => {});
      });

    res.json({
      upload_id:  record.id,
      name:       req.file.originalname,
      mime_type:  req.file.mimetype,
      size_bytes: req.file.size,
    });
  }
);

// ── DELETE /api/v1/chat/upload/:id ──────────────────────────────────────────
router.delete('/chat/upload/:id', async (req, res) => {
  const { data: record } = await supabase
    .from('chat_uploads')
    .select('storage_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('user_id', req.user.id)
    .eq('archived', false)
    .maybeSingle();

  if (!record) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([record.storage_path]).catch(() => {});
  await supabase.from('chat_uploads').delete().eq('id', req.params.id);

  res.json({ success: true });
});

module.exports = router;
