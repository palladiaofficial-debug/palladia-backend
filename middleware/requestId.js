'use strict';
const crypto = require('crypto');
const Sentry  = require('../lib/sentry');

/**
 * X-Request-ID middleware
 * - Ogni request riceve un ID univoco: usa quello del client se presente, altrimenti lo genera
 * - Lo aggiunge a res.locals, a req.id (usato da pino-http), e all'header di risposta
 * - Lo associa allo scope Sentry: ogni errore catturato riporta il request ID
 */
function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  Sentry.withScope(scope => {
    scope.setTag('request_id', id);
    scope.setContext('request', { method: req.method, path: req.path });
  });
  next();
}

module.exports = { requestId };
