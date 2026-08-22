'use strict';
/**
 * routes/v1/sdiMassiveImport.js
 * Importazione massiva dello storico fatture (download AdE) — vedi
 * services/sdiMassiveImport.js per l'architettura completa.
 *
 * POST /api/v1/expenses/massive-import              — carica lo zip, avvia l'elaborazione (JWT, owner/admin)
 * GET  /api/v1/expenses/massive-import/:id            — stato/avanzamento per il polling (JWT)
 */

const multer = require('multer');
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { chatLimiter, userImportLimiter } = require('../../middleware/rateLimit');
const { createMassiveImportBatch, getMassiveImportBatchStatus } = require('../../services/sdiMassiveImport');

// Fatture XML/p7m sono piccole (poche decine di KB l'una) anche a centinaia —
// 200MB dà ampio margine su un backlog pluriennale senza avvicinarsi al limite
// tecnico di memoria del processo (multer bufferizza in RAM).
const MAX_ZIP_SIZE = 200 * 1024 * 1024;

const upload = multer({
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

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

router.post('/expenses/massive-import',
  verifySupabaseJwt, chatLimiter, userImportLimiter,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(400).json({ error: 'ZIP_TOO_LARGE', message: `L'archivio supera il limite di ${MAX_ZIP_SIZE / (1024 * 1024)} MB — scarica un periodo più corto dal portale Fatture e Corrispettivi.` });
      return res.status(400).json({ error: err.code, message: 'Caricamento non riuscito. Riprova.' });
    }
    if (err) return res.status(400).json({ error: err.message, message: err.message });
    next();
  }),
  async (req, res) => {
    if (!isAdminOrOwner(req.userRole)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono importare lo storico fatture.' });
    }
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    try {
      const result = await createMassiveImportBatch({
        companyId: req.companyId, userId: req.user.id, zipBuffer: req.file.buffer,
      });
      if (result.empty) {
        return res.status(400).json({
          error: 'ZIP_SENZA_FATTURE',
          message: 'Non ho trovato nessuna fattura elettronica in questo archivio.',
          not_invoice_count: result.notInvoiceCount,
        });
      }
      res.json({
        batch_id: result.batchId,
        total: result.total,
        not_invoice_count: result.notInvoiceCount,
        overflow_count: result.overflowCount,
      });
    } catch (err) {
      res.status(400).json({ error: 'ZIP_CORROTTO', message: err.message });
    }
  }
);

router.get('/expenses/massive-import/:id', verifySupabaseJwt, async (req, res) => {
  try {
    const batch = await getMassiveImportBatchStatus(req.params.id, req.companyId);
    if (!batch) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
