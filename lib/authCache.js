'use strict';
/**
 * lib/authCache.js — F-367 (AUDIT.md): meno viaggi verso Supabase per le letture.
 *
 * Ogni richiesta /api/v1/* faceva, PRIMA di qualsiasi lavoro, due chiamate in
 * fila a Supabase: auth.getUser(jwt) e la membership in company_users. Il
 * server gira in us-west2, Supabase in eu-west-1: ~130 ms l'una, quindi un
 * quarto di secondo buttato per ogni pagina, moltiplicato per le 5–14
 * richieste che partono insieme (misurato col titolare il 17/10).
 *
 * Qui si ricordano per 60 secondi, SOLO per le letture (GET/HEAD):
 *  - l'utente verificato, per quel token esatto (mai oltre la sua scadenza);
 *  - il ruolo dell'utente in quella azienda (solo se è membro: un "no" non
 *    si ricorda mai, e il ramo CDL passa sempre dal giro completo).
 * Le scritture verificano sempre tutto da capo. Chi viene tolto da un'azienda
 * o cambia ruolo viene dimenticato subito (dimenticaMembro); un token
 * revocato al massimo legge ancora per 60 secondi.
 */
const crypto = require('crypto');

const TTL_MS = 60_000;
const MAX = 5000;
const utenti = new Map(); // sha256(jwt) → { user, fino }
const membri = new Map(); // `${userId}:${companyId}` → { role, fino }

const chiaveToken = (jwt) => crypto.createHash('sha256').update(jwt).digest('hex');

function scadenzaToken(jwt) {
  try {
    const exp = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch { return 0; }
}

function pulisci(mappa) {
  if (mappa.size < MAX) return;
  const ora = Date.now();
  for (const [k, v] of mappa) if (v.fino <= ora) mappa.delete(k);
  // ancora piena: si butta la metà più vecchia (le Map tengono l'ordine d'inserimento)
  if (mappa.size >= MAX) { let n = mappa.size / 2; for (const k of mappa.keys()) { if (n-- <= 0) break; mappa.delete(k); } }
}

function utenteRicordato(jwt) {
  const r = utenti.get(chiaveToken(jwt));
  if (!r) return null;
  if (r.fino <= Date.now()) { utenti.delete(chiaveToken(jwt)); return null; }
  return r.user;
}

function ricordaUtente(jwt, user) {
  const fino = Math.min(Date.now() + TTL_MS, scadenzaToken(jwt));
  if (fino <= Date.now()) return;
  pulisci(utenti);
  utenti.set(chiaveToken(jwt), { user: { id: user.id, email: user.email }, fino });
}

function ruoloRicordato(userId, companyId) {
  const k = `${userId}:${companyId}`;
  const r = membri.get(k);
  if (!r) return null;
  if (r.fino <= Date.now()) { membri.delete(k); return null; }
  return r.role;
}

function ricordaRuolo(userId, companyId, role) {
  if (!role) return;
  pulisci(membri);
  membri.set(`${userId}:${companyId}`, { role, fino: Date.now() + TTL_MS });
}

/** Da chiamare quando un utente lascia un'azienda, viene tolto o cambia ruolo. */
function dimenticaMembro(userId, companyId) {
  membri.delete(`${userId}:${companyId}`);
}

function _svuota() { utenti.clear(); membri.clear(); }

module.exports = { utenteRicordato, ricordaUtente, ruoloRicordato, ricordaRuolo, dimenticaMembro, TTL_MS, _svuota };
