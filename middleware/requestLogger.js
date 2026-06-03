'use strict';
const pinoHttp = require('pino-http');
const logger   = require('../lib/logger');

const requestLogger = pinoHttp({
  logger,
  // Non loggare health check (troppo rumoroso)
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/ping',
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} → ${res.statusCode}: ${err.message}`,
  serializers: {
    req: (req) => ({
      method:    req.method,
      url:       req.url,
      requestId: req.id,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});

module.exports = requestLogger;
