'use strict';
const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const AdmZip   = require('adm-zip');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const BUCKET       = 'site-documents';
const MAX_SIZE     = 25 * 1024 * 1024;  // 25 MB — file singolo
const MAX_ZIP_SIZE = 150 * 1024 * 1024; // 150 MB — archivio intero
const MAX_ZIP_ENTRIES = 300;            // oltre, l'utente va invitato a dividere l'archivio

const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

// Le voci dentro uno zip non portano un mimetype affidabile (dipende dal
// sistema che ha creato l'archivio) — lo deduciamo dall'estensione.
const EXT_TO_MIME = {
  '.pdf':  'application/pdf',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo file non supportato. Usa PDF, immagini, Word o Excel.'));
  },
});

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_ZIP_SIZE },
  fileFilter: (_req, file, cb) => {
    const isZip = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname.toLowerCase().endsWith('.zip');
    if (isZip) cb(null, true);
    else cb(new Error('Il file deve essere un archivio .zip.'));
  },
});

// Cartelle/file che i tool di sistema aggiungono agli zip e vanno sempre ignorati.
function isJunkEntry(entryName) {
  const base = path.basename(entryName);
  return entryName.startsWith('__MACOSX/')
    || base === '.DS_Store' || base === 'Thumbs.db'
    || base.startsWith('._') || base.startsWith('.');
}

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

// ── POST /api/v1/chat/upload-zip ─────────────────────────────────────────────
// Spacchetta un archivio zip e carica ogni file valido come un normale
// chat_upload — stesso storage/tabella dell'upload singolo qui sopra, così
// il resto della pipeline (analisi AI, archiviazione) non deve sapere se un
// file arrivava da uno zip o da un upload diretto.
router.post('/chat/upload-zip',
  (req, res, next) => uploadZip.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ZIP_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    let zip, entries;
    try {
      zip = new AdmZip(req.file.buffer);
      entries = zip.getEntries().filter(e => !e.isDirectory && !isJunkEntry(e.entryName));
    } catch (err) {
      return res.status(400).json({ error: 'ZIP_CORROTTO', detail: err.message });
    }

    if (entries.length === 0) {
      return res.status(400).json({ error: 'ZIP_VUOTO' });
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
      return res.status(400).json({
        error: 'TROPPI_FILE',
        detail: `L'archivio contiene ${entries.length} file, il massimo è ${MAX_ZIP_ENTRIES}. Dividilo in più zip.`,
      });
    }

    const uploaded = [];
    const skipped  = [];

    for (const entry of entries) {
      const ext  = path.extname(entry.entryName).toLowerCase();
      const mime = EXT_TO_MIME[ext];
      if (!mime) {
        skipped.push({ name: entry.entryName, reason: 'Tipo file non supportato' });
        continue;
      }

      const buffer = entry.getData();
      if (buffer.length === 0) {
        skipped.push({ name: entry.entryName, reason: 'File vuoto' });
        continue;
      }
      if (buffer.length > MAX_SIZE) {
        skipped.push({ name: entry.entryName, reason: 'File troppo grande (max 25MB)' });
        continue;
      }

      const fileId      = crypto.randomUUID();
      const filename     = safeName(path.basename(entry.entryName));
      const storagePath = `${req.companyId}/chat-uploads/${fileId}-${filename}`;

      const { error: storageErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { contentType: mime, upsert: false });
      if (storageErr) {
        skipped.push({ name: entry.entryName, reason: 'Errore di caricamento' });
        continue;
      }

      const { data: record, error: dbErr } = await supabase
        .from('chat_uploads')
        .insert({
          company_id:    req.companyId,
          user_id:       req.user.id,
          original_name: path.basename(entry.entryName),
          mime_type:     mime,
          storage_path:  storagePath,
          size_bytes:    buffer.length,
        })
        .select('id')
        .single();

      if (dbErr) {
        supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        skipped.push({ name: entry.entryName, reason: 'Errore database' });
        continue;
      }

      uploaded.push({
        upload_id:  record.id,
        name:       path.basename(entry.entryName),
        mime_type:  mime,
        size_bytes: buffer.length,
      });
    }

    if (uploaded.length === 0) {
      return res.status(400).json({ error: 'NESSUN_FILE_VALIDO', skipped });
    }

    res.json({ uploaded, skipped });
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
