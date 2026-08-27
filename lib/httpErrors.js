'use strict';
/**
 * lib/httpErrors.js
 * BLOCCO 5 (F-089): 81 route handler in 14 file rispondevano con
 * `res.status(500).json({ error: error.message })`, esponendo il messaggio
 * Postgres/PostgREST grezzo (sintassi SQL, nomi di colonne/vincoli — es.
 * `invalid input syntax for type uuid: "..."`) come se fosse un messaggio per
 * l'utente finale. Non è comprensibile per chi usa il prodotto e rivela
 * dettagli interni dello schema. Il dettaglio reale resta comunque visibile
 * per il team via Sentry (capturato qui in modo esplicito, con piena fedeltà,
 * a differenza dell'intercettore globale 5xx in server.js che ora vedrebbe
 * solo il messaggio già sanificato).
 */
const Sentry = require('./sentry');

function sendDbError(res, error, status = 500) {
  const err = error instanceof Error ? error : new Error(String(error?.message || error));
  Sentry.captureException(err);
  return res.status(status).json({
    error: 'Si è verificato un errore imprevisto. Riprova o contatta il supporto se il problema persiste.',
  });
}

module.exports = { sendDbError };
