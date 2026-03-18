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

// Billing / abbonamenti (JWT richiesto)
router.use('/', require('./billing'));

// Route pubbliche scan badge (no JWT — session token o signed QR link)
// Le route /api/v1/scan/* e /api/v1/asl/:token (accesso pubblico) sono qui sotto
router.use('/', require('./scan'));

module.exports = router;
