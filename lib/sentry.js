'use strict';
/**
 * lib/sentry.js
 * Inizializza Sentry con performance monitoring e contesto arricchito.
 * DEVE essere il primo require in server.js.
 */
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release:     process.env.RAILWAY_GIT_COMMIT_SHA || undefined,

    // Performance: campiona 20% delle transazioni in produzione
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

    // Ignora errori attesi che non indicano bug
    ignoreErrors: [
      'CORS: origin not allowed',
      'ResendError',        // errori transient email
      /rate.limit/i,
    ],

    // Arricchisci ogni evento con contesto utile
    beforeSend(event, hint) {
      const err = hint?.originalException;

      // Non inviare errori client (4xx) — solo server error (5xx) e crash
      if (err?.status && err.status < 500) return null;

      // Rimuovi dati sensibili dagli header
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers['x-company-id'];
        delete event.request.headers.cookie;
      }

      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      // Rimuovi query string dai breadcrumb (potrebbero contenere token)
      if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
        try {
          const u = new URL(breadcrumb.data.url);
          u.search = '';
          breadcrumb.data.url = u.toString();
        } catch { /* url non parsabile */ }
      }
      return breadcrumb;
    },
  });

  console.log('[Sentry] inizializzato — env:', process.env.NODE_ENV || 'production',
    '| tracing:', process.env.NODE_ENV === 'production' ? '20%' : '100%');
} else {
  console.log('[Sentry] SENTRY_DSN non configurata — error tracking disabilitato');
  console.log('[Sentry] Aggiungi SENTRY_DSN su Railway per attivare il monitoraggio');
}

module.exports = Sentry;
