'use strict';
/**
 * lib/sentry.js
 * Inizializza Sentry solo se SENTRY_DSN è configurata.
 * Import: require('./lib/sentry') — DEVE essere il primo require in server.js.
 */
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:      process.env.NODE_ENV || 'production',
    release:          process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0.1,   // 10% delle transazioni — basso costo, buona visibilità
    // Non catturare dati personali nei breadcrumbs
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
        // Rimuove query string con potenziali token
        try {
          const u = new URL(breadcrumb.data.url);
          u.search = '';
          breadcrumb.data.url = u.toString();
        } catch { /* url non parsabile — lascia invariato */ }
      }
      return breadcrumb;
    },
  });
  console.log('[Sentry] inizializzato — environment:', process.env.NODE_ENV || 'production');
} else {
  console.log('[Sentry] SENTRY_DSN non configurata — error tracking disabilitato');
}

module.exports = Sentry;
