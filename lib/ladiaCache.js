'use strict';
/**
 * lib/ladiaCache.js — durata della prompt cache di Ladia (F-248, AUDIT.md).
 *
 * Fino al 27/09 la cache era sempre da 1 ora: scrivere costa 2x il prezzo
 * base invece di 1,25x, e conviene solo se il prefisso viene riletto entro
 * l'ora. Nei 60 giorni di uso reale (una sola azienda, domande a distanza di
 * giorni) quasi ogni domanda riscriveva la cache che nessuno avrebbe riletto:
 * simulato sulle 123 chiamate vere, 5 minuti costano il 19% in meno, anche
 * contando le domande ravvicinate che con 1 ora trovavano la cache calda.
 * Con molte aziende attive insieme il conto può rovesciarsi (il prefisso
 * statico è uguale per tutti): basta LADIA_CACHE_TTL=1h su Railway e un riavvio.
 *
 * Tutti i breakpoint della stessa richiesta usano lo stesso TTL: l'API vuole
 * i TTL lunghi prima di quelli corti, e un TTL misto spezzerebbe il riuso.
 */
const LADIA_CACHE_TTL = process.env.LADIA_CACHE_TTL === '1h' ? '1h' : '5m';

function cacheControl() {
  return LADIA_CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

module.exports = { LADIA_CACHE_TTL, cacheControl };
