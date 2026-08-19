'use strict';
/**
 * routes/v1/emailIngest.js
 * Canale fatture fornitore via inoltro email (vedi services/emailIngestConfig.js e
 * services/emailIngestWebhook.js).
 *
 * POST   /api/v1/expenses/email-ingest/connect                — collega/riattiva (JWT, owner/admin)
 * POST   /api/v1/expenses/email-ingest/rotate-token            — rigenera l'indirizzo (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/status                  — stato + indirizzo (JWT)
 * POST   /api/v1/expenses/email-ingest/disconnect               — disattiva (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/allowed-senders          — lista allowlist (JWT)
 * POST   /api/v1/expenses/email-ingest/allowed-senders          — autorizza/blocca un mittente (JWT, owner/admin)
 * DELETE /api/v1/expenses/email-ingest/allowed-senders/:id      — rimuove una regola (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/log                      — registro messaggi, filtrabile (JWT)
 * POST   /api/v1/expenses/email-ingest/webhook                  — ricezione email (PUBBLICO, firma Mailgun)
 *
 * Il webhook è pubblico (autenticato via firma Mailgun, non JWT) — DEVE stare prima
 * di qualsiasi sub-router con router.use(verifySupabaseJwt) globale, stesso motivo
 * già documentato in index.js per scan/badgePunch/webhook SdI.
 */

const router   = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { emailIngestWebhookLimiter, emailIngestSenderLimiter } = require('../../middleware/rateLimit');
const { upsertAllowedSenderSchema } = require('../../lib/schemas/emailIngest');
const {
  connectCompany,
  rotateToken,
  getStatus,
  disconnectCompany,
  listAllowedSenders,
  upsertAllowedSender,
  removeAllowedSender,
  listIngestLog,
} = require('../../services/emailIngestConfig');
const { handleInboundWebhook } = require('../../services/emailIngestWebhook');
const { getHealthReport } = require('../../services/emailIngestHealthCheck');

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

// ── POST /api/v1/expenses/email-ingest/webhook — PUBBLICO ─────────────────────
// multer per il multipart/form-data di Mailgun (campi + allegati) — 30MB per
// singolo file, sotto il limite Mailgun (25MB per l'intero messaggio, quindi già
// impossibile superarlo per un solo allegato, ma il limite resta come guardia
// esplicita invece di affidarsi solo al comportamento del provider a monte).
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.post('/expenses/email-ingest/webhook', emailIngestWebhookLimiter, upload.any(), emailIngestSenderLimiter, async (req, res) => {
  try {
    const result = await handleInboundWebhook(req.body, req.files || []);
    res.status(result.httpStatus || 200).json(result.body || { ok: true });
  } catch (err) {
    console.error('[email-ingest-webhook] errore imprevisto:', err.message);
    // 200 comunque, come sdi-webhook: un payload che genera un'eccezione di
    // parsing non cambierà risultato a un retry — l'errore resta comunque
    // loggato per intervento manuale, mai un ritentativo infinito del provider.
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── Rotte azienda (JWT) ──────────────────────────────────────────────────────────

router.post('/expenses/email-ingest/connect', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono collegare il canale email.' });
  }
  try {
    const result = await connectCompany(req.companyId, req.user.id);
    res.status(201).json(result);
  } catch (err) {
    console.error('[email-ingest] connect error:', err.message);
    res.status(500).json({ error: 'DB_ERROR', message: err.message });
  }
});

router.post('/expenses/email-ingest/rotate-token', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    const result = await rotateToken(req.companyId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: 'NOT_CONNECTED', message: err.message });
  }
});

router.get('/expenses/email-ingest/status', verifySupabaseJwt, async (req, res) => {
  try {
    const status = await getStatus(req.companyId);
    res.json(status || { status: 'not_connected' });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.post('/expenses/email-ingest/disconnect', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    await disconnectCompany(req.companyId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.get('/expenses/email-ingest/allowed-senders', verifySupabaseJwt, async (req, res) => {
  try {
    res.json(await listAllowedSenders(req.companyId));
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.post('/expenses/email-ingest/allowed-senders', verifySupabaseJwt, validate(upsertAllowedSenderSchema), async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    const row = await upsertAllowedSender(req.companyId, req.user.id, req.body.email_address, req.body.action);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR', message: err.message });
  }
});

router.delete('/expenses/email-ingest/allowed-senders/:id', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    await removeAllowedSender(req.companyId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.get('/expenses/email-ingest/log', verifySupabaseJwt, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await listIngestLog(req.companyId, { outcome: req.query.outcome, limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.get('/expenses/email-ingest/health', verifySupabaseJwt, async (req, res) => {
  try {
    res.json(await getHealthReport(req.companyId));
  } catch (err) {
    console.error('[email-ingest] health error:', err.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
