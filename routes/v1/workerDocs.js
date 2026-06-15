'use strict';
// ── Worker Documents ───────────────────────────────────────────────────────────
// Archivio documenti personali del lavoratore (idoneità, attestati, corsi…)
//
// GET    /api/v1/workers/:workerId/documents                — lista doc lavoratore
// POST   /api/v1/workers/:workerId/documents                — upload documento
// PATCH  /api/v1/workers/:workerId/documents/:docId         — modifica metadati
// DELETE /api/v1/workers/:workerId/documents/:docId         — elimina
// GET    /api/v1/workers/:workerId/documents/:docId/download — signed URL download
// POST   /api/v1/workers/:workerId/documents/:docId/analyze  — ri-analisi AI
// GET    /api/v1/worker-documents                           — tutti i doc company (vista globale)
// ──────────────────────────────────────────────────────────────────────────────

const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { analyzeWorkerDoc, analyzeDocumentBuffer, syncToFormazione } = require('../../services/documentAI');
const { validate } = require('../../middleware/validate');
const { createWorkerDocSchema, patchWorkerDocSchema } = require('../../lib/schemas/workerDocs');

const BUCKET   = 'site-documents';
const MAX_SIZE = 20 * 1024 * 1024;

const ALLOWED_TYPES = [
  'idoneita_medica',
  'formazione_sicurezza',
  'primo_soccorso',
  'antincendio',
  'lavori_quota',
  'ponteggi',
  'gruista',
  'pes_pav_pei',
  'rspp',
  'patente_guida',
  'altro',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
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

function isValidDate(val) {
  if (!val) return true;
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

async function verifyWorker(workerId, companyId) {
  const { data } = await supabase
    .from('workers')
    .select('id')
    .eq('id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();
  return !!data;
}

async function syncWorkerExpiry(docType, workerId, companyId) {
  const field = docType === 'idoneita_medica'      ? 'health_fitness_expiry'
    : docType === 'formazione_sicurezza' ? 'safety_training_expiry'
    : null;
  if (!field) return;
  // Usa MAX(ai_expiry_date, expiry_date) coerente con BadgeModal.computeDocStatus.
  // ai_expiry_date è più accurato quando l'AI ha analizzato il file.
  const { data } = await supabase
    .from('worker_documents')
    .select('expiry_date, ai_expiry_date')
    .eq('worker_id',  workerId)
    .eq('company_id', companyId)
    .eq('doc_type',   docType);

  const maxExpiry = (data || [])
    .map(d => d.ai_expiry_date || d.expiry_date)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  await supabase.from('workers')
    .update({ [field]: maxExpiry })
    .eq('id', workerId)
    .eq('company_id', companyId);
}

const SELECT_FIELDS = `
  id, company_id, worker_id, doc_type, name,
  issued_date, expiry_date, file_url, file_path, mime_type, notes,
  ai_summary, ai_expiry_date, ai_renewal_years,
  ai_issued_to, ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at,
  created_at, updated_at
`;

// ── GET /api/v1/workers/:workerId/documents ───────────────────────────────────
router.get('/workers/:workerId/documents', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  if (!await verifyWorker(workerId, req.companyId))
    return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('worker_documents')
    .select(SELECT_FIELDS)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/workers/:workerId/documents — upload file ────────────────────
router.post('/workers/:workerId/documents',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  validate(createWorkerDocSchema),
  async (req, res) => {
    const { workerId } = req.params;
    const { doc_type = 'altro', name, issued_date, expiry_date, notes } = req.body;

    if (!name || !String(name).trim())
      return res.status(400).json({ error: 'NAME_REQUIRED' });
    if (!ALLOWED_TYPES.includes(doc_type))
      return res.status(400).json({ error: 'INVALID_DOC_TYPE' });
    if (!isValidDate(issued_date) || !isValidDate(expiry_date))
      return res.status(400).json({ error: 'DATE_FORMAT_YYYY_MM_DD' });

    if (!await verifyWorker(workerId, req.companyId))
      return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

    let filePath = null;
    let fileUrl  = null;

    // Upload file se allegato
    if (req.file) {
      const fileId   = crypto.randomUUID();
      const filename = safeName(req.file.originalname);
      filePath = `${req.companyId}/workers/${workerId}/${fileId}-${filename}`;

      const { error: storageErr } = await supabase.storage
        .from(BUCKET).upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

      // Signed URL pubblica valida 10 anni — usata come file_url legacy
      const { data: signed } = await supabase.storage
        .from(BUCKET).createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);
      fileUrl = signed?.signedUrl || null;
    }

    const { data, error } = await supabase
      .from('worker_documents')
      .insert({
        company_id:  req.companyId,
        worker_id:   workerId,
        doc_type,
        name:        String(name).trim(),
        issued_date: issued_date || null,
        expiry_date: expiry_date || null,
        file_url:    fileUrl,
        file_path:   filePath,
        mime_type:   req.file?.mimetype || null,
        notes:       notes ? String(notes).trim() : null,
      })
      .select(SELECT_FIELDS)
      .single();

    if (error) {
      if (filePath) await supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
      return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
    }

    await syncWorkerExpiry(data.doc_type, workerId, req.companyId);

    // Sync immediato verso Formazione (dati manuali — senza AI)
    syncToFormazione(
      data.id, workerId, req.companyId,
      data.doc_type, data.name,
      data.issued_date, data.expiry_date,
      null, data.file_url,
    ).catch(() => {});

    // Analisi AI in background: aggiorna worker_certificates con dati più precisi
    if (filePath && req.file) {
      analyzeWorkerDoc(data.id, workerId, req.companyId, filePath, req.file.mimetype).catch(() => {});
    }

    res.status(201).json(data);
  }
);

// ── PATCH /api/v1/workers/:workerId/documents/:docId — modifica metadati ──────
router.patch('/workers/:workerId/documents/:docId', verifySupabaseJwt, validate(patchWorkerDocSchema), async (req, res) => {
  const { workerId, docId } = req.params;
  const allowed = ['doc_type', 'name', 'issued_date', 'expiry_date', 'notes'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k] || null;
  }
  if ('name' in updates) updates.name = String(updates.name || '').trim();
  if ('doc_type' in updates && updates.doc_type && !ALLOWED_TYPES.includes(updates.doc_type))
    return res.status(400).json({ error: 'INVALID_DOC_TYPE' });
  if (!isValidDate(updates.issued_date) || !isValidDate(updates.expiry_date))
    return res.status(400).json({ error: 'DATE_FORMAT_YYYY_MM_DD' });
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('worker_documents')
    .update(updates)
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .select(SELECT_FIELDS)
    .single();

  if (error || !data) return res.status(404).json({ error: 'DOC_NOT_FOUND' });

  // Risincronizza ENTRAMBI i tipi critici: se l'utente ha cambiato doc_type
  // (es. da idoneita_medica a formazione_sicurezza), workers deve ricalcolare
  // sia il vecchio che il nuovo campo.
  await syncWorkerExpiry('idoneita_medica',      workerId, req.companyId);
  await syncWorkerExpiry('formazione_sicurezza', workerId, req.companyId);

  syncToFormazione(
    data.id, workerId, req.companyId,
    data.doc_type, data.name,
    data.issued_date, data.expiry_date,
    null, data.file_url,
  ).catch(() => {});

  res.json(data);
});

// ── DELETE /api/v1/workers/:workerId/documents/:docId ─────────────────────────
router.delete('/workers/:workerId/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { workerId, docId } = req.params;

  const { data: doc } = await supabase
    .from('worker_documents')
    .select('id, doc_type, file_path')
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  if (doc.file_path) {
    await supabase.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
  }

  const { error } = await supabase
    .from('worker_documents')
    .delete()
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Ricalcola il campo del worker dopo la cancellazione: se era il documento
  // più recente, workers deve scalare alla versione precedente (o null).
  await syncWorkerExpiry(doc.doc_type, workerId, req.companyId);

  res.status(204).end();
});

// ── GET /api/v1/workers/:workerId/documents/:docId/download — signed URL ──────
router.get('/workers/:workerId/documents/:docId/download', verifySupabaseJwt, async (req, res) => {
  const { workerId, docId } = req.params;

  const { data: doc } = await supabase
    .from('worker_documents')
    .select('id, file_path, name, mime_type')
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!doc)           return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.file_path) return res.status(422).json({ error: 'NO_FILE' });

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(doc.file_path, 3600);
  if (signErr || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: signed.signedUrl, name: doc.name });
});

// ── POST /api/v1/workers/:workerId/documents/:docId/analyze — ri-analisi AI ───
router.post('/workers/:workerId/documents/:docId/analyze', verifySupabaseJwt, async (req, res) => {
  const { workerId, docId } = req.params;

  const { data: doc } = await supabase
    .from('worker_documents')
    .select('id, file_path, mime_type')
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!doc)           return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.file_path) return res.status(422).json({ error: 'NO_FILE' });

  await supabase.from('worker_documents')
    .update({ ai_analyzed_at: null })
    .eq('id', doc.id);

  analyzeWorkerDoc(doc.id, workerId, req.companyId, doc.file_path, doc.mime_type).catch(() => {});
  res.json({ ok: true, message: 'Analisi avviata' });
});

// ── GET /api/v1/worker-documents — vista globale (sezione Documenti) ──────────
router.get('/worker-documents', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('worker_documents')
    .select(`
      ${SELECT_FIELDS},
      worker:workers ( id, full_name, photo_url, is_active )
    `)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false })
    .limit(1000);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── Fuzzy name matching ────────────────────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Restituisce 0-100; gestisce "ROSSI Mario" vs "Mario Rossi" via token overlap
function scoreMatch(extracted, workerName) {
  const a = normName(extracted);
  const b = normName(workerName);
  if (!a || !b) return 0;
  const ta = new Set(a.split(' ').filter(t => t.length > 1));
  const tb = new Set(b.split(' ').filter(t => t.length > 1));
  const common = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = common / Math.max(ta.size, tb.size, 1);
  const lev = levenshtein(a, b);
  const levScore = 1 - lev / Math.max(a.length, b.length, 1);
  return Math.round(tokenScore * 70 + levScore * 30);
}

// ── POST /api/v1/worker-docs/ai-import — analisi AI + matching senza salvare ──
router.post('/worker-docs/ai-import',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    let analysis;
    try {
      analysis = await analyzeDocumentBuffer(req.file.buffer, req.file.mimetype);
    } catch (err) {
      console.error('[ai-import] analysis failed:', err.message);
      return res.status(500).json({ error: 'AI_ERROR', detail: err.message });
    }
    if (!analysis) return res.status(422).json({ error: 'UNSUPPORTED_FORMAT' });

    const { data: workers } = await supabase
      .from('workers')
      .select('id, full_name, photo_url, is_active')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('full_name');

    const worker_matches = (workers || [])
      .map(w => ({ worker: w, score: scoreMatch(analysis.issued_to, w.full_name) }))
      .filter(m => m.score >= 35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const all_workers = (workers || []).map(w => ({ id: w.id, full_name: w.full_name }));

    res.json({ analysis, worker_matches, all_workers });
  }
);

module.exports = router;
