#!/usr/bin/env node
/**
 * scripts/selftest_auth_cache.js — F-367 (AUDIT.md del frontend): letture più veloci.
 *
 * verifySupabaseJwt faceva due chiamate a Supabase (getUser + membership) a
 * OGNI richiesta, ~130 ms l'una dall'America all'Irlanda. Ora per le letture
 * si ricordano 60 s. Qui, con Supabase finto che conta le chiamate:
 *  1. seconda GET con lo stesso token: zero chiamate (prima del fix: 2);
 *  2. una scrittura (POST) rifà sempre tutto, anche subito dopo una GET;
 *  3. un non-membro non viene mai ricordato (403 anche alla seconda);
 *  4. tolto dall'azienda (dimenticaMembro) → la GET dopo verifica di nuovo e dà 403;
 *  5. un token scaduto non viene ricordato;
 *  6. token diverso → nuova verifica.
 */
'use strict';
const path = require('path');

let chiamate = { getUser: 0, membri: 0 };
let membri = new Map(); // `${user}:${company}` → role
const utentiPerToken = new Map();

const supaPath = path.join(__dirname, '../lib/supabase.js');
const finto = {
  auth: { getUser: async (jwt) => { chiamate.getUser++; const u = utentiPerToken.get(jwt); return u ? { data: { user: u }, error: null } : { data: null, error: { message: 'bad' } }; } },
  from(table) {
    const filtri = {};
    const q = {
      select() { return q; },
      eq(c, v) { filtri[c] = v; return q; },
      async maybeSingle() {
        if (table === 'company_users') { chiamate.membri++; const role = membri.get(`${filtri.user_id}:${filtri.company_id}`); return { data: role ? { role } : null, error: null }; }
        return { data: null, error: null };
      },
    };
    return q;
  },
};
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: finto };
const billPath = path.join(__dirname, '../lib/billing.js');
require.cache[billPath] = { id: billPath, filename: billPath, loaded: true, exports: { isBillingActive: async () => true } };

const { verifySupabaseJwt } = require('../middleware/verifyJwt');
const authCache = require('../lib/authCache');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sub, expSec) => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: expSec })}.firma-${Math.random()}`;

async function chiama(method, jwt, company) {
  const req = { method, path: '/x', headers: { authorization: `Bearer ${jwt}`, 'x-company-id': company } };
  let stato = 200, avanti = false;
  const res = { status(s) { stato = s; return res; }, json() { return res; } };
  await verifySupabaseJwt(req, res, () => { avanti = true; });
  return { stato: avanti ? 200 : stato, ruolo: req.userRole };
}
const azzera = () => { chiamate = { getUser: 0, membri: 0 }; };

(async () => {
  console.log('\nF-367 — verifica del token e dell\'azienda ricordata per le letture');
  const tra1h = Math.floor(Date.now() / 1000) + 3600;
  const A = token('u1', tra1h);
  utentiPerToken.set(A, { id: 'u1', email: 'a@x.it' });
  membri.set('u1:c1', 'owner');

  azzera(); let r = await chiama('GET', A, 'c1');
  check('prima GET: verifica completa (2 chiamate)', r.stato === 200 && chiamate.getUser === 1 && chiamate.membri === 1, chiamate);
  azzera(); r = await chiama('GET', A, 'c1');
  check('seconda GET con lo stesso token: nessuna chiamata a Supabase', r.stato === 200 && r.ruolo === 'owner' && chiamate.getUser === 0 && chiamate.membri === 0, chiamate);

  azzera(); r = await chiama('POST', A, 'c1');
  check('POST subito dopo: verifica sempre completa', r.stato === 200 && chiamate.getUser === 1 && chiamate.membri === 1, chiamate);

  // 3. non membro
  azzera(); r = await chiama('GET', A, 'c2');
  const primo = r.stato;
  azzera(); r = await chiama('GET', A, 'c2');
  check('non membro: 403, e il «no» non viene ricordato (ricontrolla)', primo === 403 && r.stato === 403 && chiamate.membri === 1, { primo, r, chiamate });

  // 4. tolto dall'azienda
  membri.delete('u1:c1');
  authCache.dimenticaMembro('u1', 'c1');
  azzera(); r = await chiama('GET', A, 'c1');
  check('tolto dall\'azienda: la GET dopo dà 403 subito', r.stato === 403 && chiamate.membri === 1, { r, chiamate });

  // 5. token scaduto
  const S = token('u2', Math.floor(Date.now() / 1000) - 10);
  utentiPerToken.set(S, { id: 'u2', email: 'b@x.it' });
  membri.set('u2:c1', 'tech');
  await chiama('GET', S, 'c1');
  azzera(); await chiama('GET', S, 'c1');
  check('token scaduto: non ricordato, Supabase lo verifica ogni volta', chiamate.getUser === 1, chiamate);

  // 6. token diverso dello stesso utente
  membri.set('u1:c1', 'owner');
  const B = token('u1', tra1h);
  utentiPerToken.set(B, { id: 'u1', email: 'a@x.it' });
  azzera(); r = await chiama('GET', B, 'c1');
  check('token diverso: nuova verifica del token', r.stato === 200 && chiamate.getUser === 1, chiamate);
  // token falso con lo stesso utente nel payload: mai accettato senza Supabase
  const F = token('u1', tra1h);
  azzera(); r = await chiama('GET', F, 'c1');
  check('token mai visto (anche con lo stesso utente dentro): 401', r.stato === 401 && chiamate.getUser === 1, { r, chiamate });

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
