#!/usr/bin/env node
/**
 * scripts/selftest_semplice_per_tutti.js — F-395 (AUDIT.md, 2026-10-22).
 *
 * La Palladia semplice (home Oggi, menu a 5 voci, Documenti, Lavagna,
 * presenze delle imprese, Da pagare, conti dei sub) era accesa solo per MSC e
 * per l'azienda E2E con righe in company_feature_flags: tutte le altre
 * aziende vedevano la versione vecchia. Ora i 7 flag sono accesi di default.
 *
 * Verifica:
 *   1. senza FEATURE_<NOME>_DEFAULT i 7 flag valgono true;
 *   2. FEATURE_<NOME>_DEFAULT=false li spegne ancora (via d'uscita);
 *   3. un'azienda senza righe di override li risolve true.
 */
'use strict';
require('dotenv').config();

const FLAGS = ['home_semplice', 'menu_semplice', 'documenti_semplici', 'lavagna',
  'presenze_imprese', 'da_pagare', 'conti_sub'];
const envName = f => `FEATURE_${f.toUpperCase()}_DEFAULT`;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }

function loadFresh() {
  delete require.cache[require.resolve('../lib/featureFlags')];
  return require('../lib/featureFlags');
}

(async () => {
  console.log('F-395 — Palladia semplice per tutte le aziende');
  for (const f of FLAGS) delete process.env[envName(f)];
  process.env.MASTER_COMPANY_IDS = '';
  let ff = loadFresh();
  for (const f of FLAGS) ff.FEATURES[f] === true ? ok(`${f} acceso di default`) : fail(`${f} acceso di default`, ff.FEATURES[f]);

  // Un'azienda che non esiste: nessuna riga in company_feature_flags.
  const nessuna = '00000000-0000-4000-8000-000000000395';
  for (const f of FLAGS) {
    const v = await ff.isFeatureEnabled(nessuna, f);
    v === true ? ok(`${f} acceso per un'azienda senza override`) : fail(`${f} acceso per un'azienda senza override`, v);
  }

  for (const f of FLAGS) process.env[envName(f)] = 'false';
  ff = loadFresh();
  for (const f of FLAGS) ff.FEATURES[f] === false ? ok(`${f} spegnibile con ${envName(f)}=false`) : fail(`${f} spegnibile`, ff.FEATURES[f]);

  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
