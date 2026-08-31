'use strict';
/**
 * routes/v1/emailIngest.js
 * Canale fatture fornitore via inoltro email (vedi services/emailIngestConfig.js e
 * services/emailIngestWebhook.js).
 *
 * POST   /api/v1/expenses/email-ingest/connect                — collega/riattiva (JWT, owner/admin)
 * POST   /api/v1/expenses/email-ingest/rotate-token            — rigenera l'indirizzo (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/status                  — stato + indirizzo (JWT)
 * POST   /api/v1/expenses/email-ingest/test                     — invia email di prova (JWT)
 * POST   /api/v1/expenses/email-ingest/disconnect               — disattiva (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/allowed-senders          — lista allowlist (JWT)
 * POST   /api/v1/expenses/email-ingest/allowed-senders          — autorizza/blocca un mittente (JWT, owner/admin)
 * DELETE /api/v1/expenses/email-ingest/allowed-senders/:id      — rimuove una regola (JWT, owner/admin)
 * GET    /api/v1/expenses/email-ingest/log                      — registro messaggi, filtrabile (JWT)
 * GET    /api/v1/expenses/email-ingest/providers                — istruzioni per provider, per il wizard (JWT)
 * POST   /api/v1/expenses/email-ingest/delegate                  — invia le istruzioni a chi gestisce la PEC (JWT, owner/admin)
 * POST   /api/v1/expenses/email-ingest/webhook                  — ricezione email (PUBBLICO, header segreto Cloudflare Worker)
 *
 * Il webhook è pubblico (autenticato via header X-Ingest-Secret condiviso col
 * Cloudflare Worker che riceve la posta, non JWT) — DEVE stare prima di qualsiasi
 * sub-router con router.use(verifySupabaseJwt) globale, stesso motivo già
 * documentato in index.js per scan/badgePunch/webhook SdI.
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { emailIngestWebhookLimiter, emailIngestSenderLimiter } = require('../../middleware/rateLimit');
const { upsertAllowedSenderSchema, delegateInstructionsSchema } = require('../../lib/schemas/emailIngest');
const {
  connectCompany,
  rotateToken,
  getStatus,
  disconnectCompany,
  listAllowedSenders,
  upsertAllowedSender,
  removeAllowedSender,
  listIngestLog,
  startTest,
  sendDelegateInstructions,
} = require('../../services/emailIngestConfig');
const { handleInboundWebhook, recoverQuarantinedForSender } = require('../../services/emailIngestWebhook');
const { getHealthReport } = require('../../services/emailIngestHealthCheck');
const { sendEmailIngestTestProbe, sendEmailIngestDelegateInstructions } = require('../../services/email');
const { EMAIL_PROVIDERS } = require('../../lib/emailIngestProviders');

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

// ── POST /api/v1/expenses/email-ingest/webhook — PUBBLICO ─────────────────────
// multer per il multipart/form-data che il Worker Cloudflare ripubblica (stessi nomi
// campo di Mailgun Routes: sender/recipient/subject/message-headers + allegati) —
// 30MB per singolo file, sotto il limite di 25MB per messaggio di Cloudflare Email
// Routing, ma il limite resta come guardia esplicita invece di affidarsi solo al
// comportamento del provider a monte.
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.post('/expenses/email-ingest/webhook', emailIngestWebhookLimiter, upload.any(), emailIngestSenderLimiter, async (req, res) => {
  try {
    const result = await handleInboundWebhook(req.body, req.files || [], req.headers);
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

router.post('/expenses/email-ingest/test', verifySupabaseJwt, async (req, res) => {
  try {
    const { address, nonce } = await startTest(req.companyId);
    await sendEmailIngestTestProbe({ to: address, nonce });
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-ingest] test error:', err.message);
    res.status(400).json({ error: 'TEST_FAILED', message: err.message });
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

    // F-104 (AUDIT.md): approvare un mittente non recuperava mai il messaggio
    // che l'aveva fatto comparire in quarantena, solo gli invii successivi.
    // Recupera qui, in modo sincrono, i messaggi già conservati da quel
    // mittente — solo per 'allow', mai per 'block'.
    let recovered = { recoveredMessages: 0, importedExpenseIds: [] };
    if (req.body.action === 'allow') {
      recovered = await recoverQuarantinedForSender(req.companyId, req.body.email_address).catch((err) => {
        console.error('[email-ingest] recupero quarantena dopo approvazione fallito:', err.message);
        return { recoveredMessages: 0, importedExpenseIds: [] };
      });
    }

    res.status(201).json({
      ...row,
      recovered_messages: recovered.recoveredMessages,
      recovered_expense_ids: recovered.importedExpenseIds,
    });
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

router.get('/expenses/email-ingest/providers', verifySupabaseJwt, async (req, res) => {
  res.json(EMAIL_PROVIDERS);
});

router.post('/expenses/email-ingest/delegate', verifySupabaseJwt, validate(delegateInstructionsSchema), async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono inviare la delega.' });
  }
  try {
    const { data: company } = await supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle();
    const { address, provider, sentAt } = await sendDelegateInstructions(req.companyId, req.body.delegate_email, req.body.provider_key);
    await sendEmailIngestDelegateInstructions({
      to: req.body.delegate_email,
      companyName: company?.name || 'La tua azienda',
      address,
      provider,
    });
    res.json({ ok: true, delegate_email: req.body.delegate_email, delegate_provider: req.body.provider_key, delegate_instructions_sent_at: sentAt });
  } catch (err) {
    console.error('[email-ingest] delegate error:', err.message);
    res.status(400).json({ error: 'DELEGATE_FAILED', message: err.message });
  }
});

module.exports = router;
