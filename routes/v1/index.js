'use strict';
const router = require('express').Router();
const { apiLimiter } = require('../../middleware/rateLimit');

// Rate limit globale su tutto /api/v1/
router.use(apiLimiter);

// Route private (JWT + company membership)
router.use('/', require('./siteAdmin'));
router.use('/', require('./workers'));
router.use('/', require('./qr'));
router.use('/', require('./presence'));
router.use('/', require('./reports'));

// Route pubbliche scan badge (no JWT — session token o signed QR link)
router.use('/', require('./scan'));

module.exports = router;
