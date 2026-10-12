'use strict';
/**
 * lib/schedeV2 — F-350. Contenuto delle schede nel formato nuovo, per id.
 * lib/lavorazioniSchede.js lo sovrappone alla scheda con lo stesso id e ne
 * ricava i campi vecchi (rischi, misure) che sunto, carosello e PSC leggono.
 */
module.exports = {
  ...require('./campione'),
};
