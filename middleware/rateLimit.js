'use strict';
const rateLimit = require('express-rate-limit');

// Rate limiter per POST /api/v1/scan/punch
// Key: IP (express-rate-limit default)
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED' }
});

// Rate limiter per POST /api/v1/scan/identify
// Key: IP + worksite_id — evita flooding su un singolo cantiere
// req.body è disponibile perché express.json() viene prima
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip  = req.ip || 'unknown';
    const wid = (req.body && req.body.worksite_id) || 'unknown';
    return `identify:${ip}:${wid}`;
  },
  message: { error: 'RATE_LIMIT_EXCEEDED' }
});

// Rate limiter generico per tutte le route /api/v1/
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS' }
});

module.exports = { scanLimiter, identifyLimiter, apiLimiter };
