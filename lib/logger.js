'use strict';
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // In produzione: JSON puro (Railway lo indicizza)
  // In sviluppo locale: pretty print se PINO_PRETTY=true
  ...(process.env.PINO_PRETTY === 'true' && {
    transport: { target: 'pino-pretty', options: { colorize: true } }
  }),
  base: { service: 'palladia-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Non loggare mai questi campi (security)
    paths: ['req.headers.authorization', 'req.headers["x-company-id"]', '*.password', '*.token', '*.fiscal_code'],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
