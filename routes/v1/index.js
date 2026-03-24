'use strict';
const router = require('express').Router();
const { apiLimiter } = require('../../middleware/rateLimit');

// Rate limit globale su tutto /api/v1/
router.use(apiLimiter);

// Route private (JWT + company membership)
router.use('/', require('./dashboard'));
router.use('/', require('./siteAdmin'));
router.use('/', require('./workers'));
router.use('/', require('./sessions'));
router.use('/', require('./qr'));
router.use('/', require('./presence'));
router.use('/', require('./reports'));
router.use('/', require('./alerts'));
router.use('/', require('./asl'));
router.use('/', require('./auditLog'));
router.use('/', require('./qrPdf'));
router.use('/', require('./onboarding'));

// Company profile
router.use('/', require('./company'));

// Team invites
router.use('/', require('./invites'));

// Billing / abbonamenti (JWT richiesto)
router.use('/', require('./billing'));

// Badge digitale: verifica pubblica (no JWT) + PDF privato (JWT)
router.use('/', require('./badge'));

// Documenti di sicurezza: upload/list/download (JWT) + accesso pubblico coordinatore (token)
router.use('/', require('./documents'));

// Coordinatore della Sicurezza CSE: inviti (JWT) + accesso pubblico (token)
router.use('/', require('./coordinator'));

// Route pubbliche scan badge (no JWT — session token o signed QR link)
// Le route /api/v1/scan/* e /api/v1/asl/:token (accesso pubblico) sono qui sotto
router.use('/', require('./scan'));

// ── Error handler v1 ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[v1-error]', req.method, req.path, err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'INTERNAL', detail: err.message });
  }
});

module.exports = router;
