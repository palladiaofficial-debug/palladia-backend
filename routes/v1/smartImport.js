'use strict';
/**
 * routes/v1/smartImport.js — Importazione Intelligente
 * Onboarding principale di Palladia: zip o cartella trascinata → coda di
 * classificazione+estrazione AI → revisione umana → scrittura in produzione.
 * Riusa la pipeline zip di Studio CDL (services/smartImportPipeline.js,
 * che a sua volta riusa lib/zipIngest.js e services/chatDocumentAnalysis.js).
 */

const multer = require('multer');
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { chatLimiter } = require('../../middleware/rateLimit');
const pipeline = require('../../services/smartImportPipeline');

const MAX_ZIP_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — singolo file dentro zip/cartella
const MAX_FOLDER_FILES = 500;

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_SIZE },
  fileFilter: (_req, file, cb) => {
    const isZip = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname.toLowerCase().endsWith('.zip');
    if (isZip) cb(null, true);
    else cb(new Error('Il file deve essere un archivio .zip.'));
  },
});

const uploadFolder = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FOLDER_FILES },
});

router.use('/smart-import', verifySupabaseJwt);

// ── POST /api/v1/smart-import/batches/from-zip ──────────────────────────────
router.post('/smart-import/batches/from-zip',
  chatLimiter,
  (req, res, next) => uploadZip.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ZIP_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    try {
      const result = await pipeline.createBatchFromZip({
        companyId: req.companyId, userId: req.user.id, zipBuffer: req.file.buffer,
      });
      if (result.empty) return res.status(400).json({ error: 'ZIP_VUOTO', skipped: result.skipped });
      res.json({ batch_id: result.batchId, total: result.total, skipped: result.skipped });
    } catch (err) {
      res.status(400).json({ error: 'ZIP_CORROTTO', detail: err.message });
    }
  }
);

// ── POST /api/v1/smart-import/batches/from-files ────────────────────────────
// Drag & drop di una cartella intera (webkitdirectory) — multipart con N file.
router.post('/smart-import/batches/from-files',
  chatLimiter,
  (req, res, next) => uploadFolder.array('files', MAX_FOLDER_FILES)(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : (err.code === 'LIMIT_FILE_COUNT' ? 'TROPPI_FILE' : err.message) });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
    if (!req.files?.length) return res.status(400).json({ error: 'FILES_REQUIRED' });

    const result = await pipeline.createBatchFromFiles({
      companyId: req.companyId, userId: req.user.id, files: req.files,
    });
    if (result.empty) return res.status(400).json({ error: 'NESSUN_FILE_VALIDO', skipped: result.skipped });
    res.json({ batch_id: result.batchId, total: result.total, skipped: result.skipped });
  }
);

// ── GET /api/v1/smart-import/batches/:id ─────────────────────────────────────
// Polling di stato: batch + item (per la card di progresso e la revisione) + entità proposte.
router.get('/smart-import/batches/:id', async (req, res) => {
  const { data: batch } = await supabase
    .from('import_batches').select('*').eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
  if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: items } = await supabase
    .from('import_items').select('*')
    .eq('batch_id', batch.id).is('parent_item_id', null).neq('status', 'needs_split')
    .order('created_at', { ascending: true });

  const { data: children } = await supabase
    .from('import_items').select('*')
    .eq('batch_id', batch.id).not('parent_item_id', 'is', null)
    .order('created_at', { ascending: true });

  const { data: stagedEntities } = await supabase
    .from('import_staged_entities').select('*').eq('batch_id', batch.id).eq('status', 'proposed');

  res.json({ batch, items: [...(items || []), ...(children || [])], staged_entities: stagedEntities || [] });
});

// ── POST /api/v1/smart-import/items/:id/confirm ──────────────────────────────
router.post('/smart-import/items/:id/confirm', async (req, res) => {
  try {
    const result = await pipeline.confirmItem(req.params.id, req.companyId, req.user.id, req);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/v1/smart-import/items/:id/reject ───────────────────────────────
router.post('/smart-import/items/:id/reject', async (req, res) => {
  try {
    await pipeline.rejectItem(req.params.id, req.companyId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/v1/smart-import/batches/:id/confirm-green ──────────────────────
// "Conferma tutti i verdi" — tutti gli item pending_review con confidenza > 0.85.
router.post('/smart-import/batches/:id/confirm-green', async (req, res) => {
  const { data: batch } = await supabase
    .from('import_batches').select('id').eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
  if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });

  const result = await pipeline.confirmAllGreen(batch.id, req.companyId, req.user.id, req);
  res.json(result);
});

// ── POST /api/v1/smart-import/staged-entities/:id/confirm ───────────────────
// Crea il lavoratore/cantiere proposto. Body opzionale: override dei campi
// prima della creazione (l'utente può correggere un CF letto male, ecc).
router.post('/smart-import/staged-entities/:id/confirm', async (req, res) => {
  try {
    const overrides = req.body && typeof req.body === 'object' ? req.body : {};
    const entityId = await pipeline.confirmStagedEntity(req.params.id, req.companyId, overrides);
    res.json({ success: true, entity_id: entityId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/v1/smart-import/staged-entities/:id/reject ────────────────────
router.post('/smart-import/staged-entities/:id/reject', async (req, res) => {
  const { data: staged } = await supabase
    .from('import_staged_entities').select('id, import_batches!inner(company_id)')
    .eq('id', req.params.id).maybeSingle();
  if (!staged || staged.import_batches.company_id !== req.companyId) return res.status(404).json({ error: 'NOT_FOUND' });
  await supabase.from('import_staged_entities').update({ status: 'rejected' }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── POST /api/v1/smart-import/batches/:id/finish ─────────────────────────────
// Chiusura del loop — calcola il riepilogo "momento wow" e chiude il batch.
router.post('/smart-import/batches/:id/finish', async (req, res) => {
  try {
    const summary = await pipeline.finishBatch(req.params.id, req.companyId);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
