#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_badge_public_fiscal_code_exposure.js
 *
 * Regressione F-102 (AUDIT.md) — GET /api/v1/badge/:code (endpoint pubblico,
 * pensato per la verifica ispettore in cantiere) restituiva anche il campo
 * `fiscal_code` del lavoratore. Quello stesso codice fiscale è l'unico
 * fattore richiesto da POST /api/v1/area/:code/auth per entrare nell'area
 * personale (storico presenze + buste paga). Risultato: chiunque conoscesse
 * solo il badge_code (18 caratteri esadecimali, pubblico via QR/URL) poteva,
 * in 3 chiamate HTTP automatizzabili e senza mai vedere il badge fisico,
 * leggere il codice fiscale dalla risposta pubblica, autenticarsi nell'area
 * lavoratore e scaricare le buste paga — verificato dal vivo in produzione
 * su un lavoratore di test reale prima del fix (catena completa riuscita).
 *
 * Fix: fiscal_code rimosso dalla risposta pubblica di /badge/:code (e dal
 * PDF badge stampabile). Il gate su /area/:code/auth resta invariato — il
 * problema non era lì, era l'endpoint pubblico che regalava il "segreto"
 * richiesto un passo prima.
 *
 * Uso: node scripts/selftest_badge_public_fiscal_code_exposure.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';
const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== F-102: /api/v1/badge/:code non deve esporre fiscal_code (né la catena verso le buste paga) ===\n');

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase(); // 18 hex char, come il formato reale
  const fiscalCode = 'RSSMRA85M01H501' + String.fromCharCode(65 + (Date.now() % 26)); // 16 char plausibili, unici per run

  const { data: worker, error: insErr } = await supabase
    .from('workers')
    .insert({
      company_id:   COMPANY_ID,
      full_name:    'TEST-E2E F102 Regressione',
      fiscal_code:  fiscalCode,
      badge_code:   badgeCode,
      is_active:    true,
      birth_date:   '1985-08-01',
      birth_place:  'Genova',
    })
    .select('id')
    .single();

  if (insErr || !worker) {
    console.error('Impossibile creare il worker di test:', insErr?.message);
    process.exit(1);
  }

  try {
    const badgeRes = await fetch(`${API_BASE}/badge/${badgeCode}`);
    const badgeBody = await badgeRes.json();

    check('GET /badge/:code risponde 200', badgeRes.status === 200, badgeRes.status);
    check('la risposta pubblica NON contiene fiscal_code', !('fiscal_code' in badgeBody), badgeBody);
    check('la risposta pubblica continua a contenere i campi legittimi per l\'ispettore (nome, stato conformità)',
      badgeBody.full_name === 'TEST-E2E F102 Regressione' && 'overall_status' in badgeBody, badgeBody);

    // Verifica che il gate su /area/:code/auth resti comunque solido: un
    // attaccante che NON conosce il vero CF (perché non più nella risposta
    // pubblica) non può autenticarsi tentando un CF a caso.
    const wrongAuthRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf: 'ZZZZZZ00Z00Z000Z' }),
    });
    check('login area lavoratore con CF indovinato a caso viene rifiutato', wrongAuthRes.status === 401, wrongAuthRes.status);

    // Il vero lavoratore, che il CF lo conosce davvero, deve continuare a poter accedere.
    const rightAuthRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cf: fiscalCode }),
    });
    check('login area lavoratore con il vero CF continua a funzionare (nessuna regressione per l\'uso legittimo)', rightAuthRes.status === 200, rightAuthRes.status);
  } finally {
    await supabase.from('workers').delete().eq('id', worker.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
