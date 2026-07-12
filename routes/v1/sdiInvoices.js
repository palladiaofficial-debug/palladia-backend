'use strict';
/**
 * routes/v1/sdiInvoices.js
 * Ricezione automatica fatture fornitore via SdI (vedi services/sdiInvoices.js).
 *
 * POST   /api/v1/expenses/sdi/connect                — collega la company (JWT, owner/admin)
 * GET    /api/v1/expenses/sdi/status                  — stato del collegamento (JWT)
 * POST   /api/v1/expenses/sdi/disconnect              — disattiva (JWT, owner/admin)
 * POST   /api/v1/expenses/sdi/webhook                 — fattura passiva ricevuta (PUBBLICO)
 * POST   /api/v1/expenses/sdi/webhook/legal-storage   — conferma conservazione a norma (PUBBLICO)
 *
 * Entrambi i webhook sono autenticati via secret per-company (non JWT — DEVE
 * stare prima di router con verifySupabaseJwt globale, stesso motivo
 * documentato in index.js per scan/badgePunch/workerArea).
 */

const router   = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { sdiWebhookLimiter } = require('../../middleware/rateLimit');
const { connectSdiSchema } = require('../../lib/schemas/sdiInvoices');
const {
  connectCompany,
  getConnectionStatus,
  disconnectCompany,
  resolveCompanyFromHeaders,
  ingestSupplierInvoice,
  confirmLegalStorage,
} = require('../../services/sdiInvoices');

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

// ── POST /api/v1/expenses/sdi/webhook — PUBBLICO ──────────────────────────────
router.post('/expenses/sdi/webhook', sdiWebhookLimiter, async (req, res) => {
  const companyId = await resolveCompanyFromHeaders(req.headers).catch(() => null);
  if (!companyId) return res.status(401).json({ error: 'INVALID_WEBHOOK_SECRET' });

  const invoice = req.body?.data || req.body;
  try {
    const result = await ingestSupplierInvoice(companyId, invoice);
    res.status(200).json(result);
  } catch (err) {
    console.error('[sdi-webhook] ingest error:', err.message);
    // 200 comunque: un 4xx/5xx farebbe ritentare il provider all'infinito su un
    // payload che non cambierà mai risultato (es. fattura senza importo valido).
    // L'errore resta comunque loggato per intervento manuale.
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── POST /api/v1/expenses/sdi/webhook/legal-storage — PUBBLICO ───────────────
router.post('/expenses/sdi/webhook/legal-storage', sdiWebhookLimiter, async (req, res) => {
  const companyId = await resolveCompanyFromHeaders(req.headers).catch(() => null);
  if (!companyId) return res.status(401).json({ error: 'INVALID_WEBHOOK_SECRET' });

  try {
    const result = await confirmLegalStorage(companyId, req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error('[sdi-webhook/legal-storage] error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ── Rotte azienda (JWT) ────────────────────────────────────────────────────────

router.post('/expenses/sdi/connect', verifySupabaseJwt, validate(connectSdiSchema), async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono collegare la fatturazione elettronica.' });
  }
  try {
    const result = await connectCompany({
      companyId: req.companyId,
      userId:    req.user.id,
      userEmail: req.user.email,
      fiscalId:  req.body.fiscal_id,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[sdi] connect error:', err.message);
    res.status(502).json({ error: 'SDI_CONNECT_ERROR', message: err.message });
  }
});

router.get('/expenses/sdi/status', verifySupabaseJwt, async (req, res) => {
  try {
    const status = await getConnectionStatus(req.companyId);
    res.json(status || { status: 'not_connected' });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.post('/expenses/sdi/disconnect', verifySupabaseJwt, async (req, res) => {
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

module.exports = router;
