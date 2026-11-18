#!/usr/bin/env node
/**
 * scripts/selftest_f514_manodopera_nascosta.js — F-514 (AUDIT.md del frontend, 18/11/2026).
 *
 * Il costo della manodopera per cantiere era una stima incompleta mostrata come
 * certa. Decisione del titolare: «nascondi» finché il conto non è corretto e
 * confermato dal commercialista. Controlla che resti nascosto:
 *   1. flag quanto_rende spento di default e fra i FROZEN (l'impresa principale non lo accende da sola);
 *   2. HTTP come titolare di MSC: /quanto-rende e /quanto-rende/cantiere → 404 FEATURE_DISABLED;
 *      le fatture senza cantiere (F-510) invece restano: non usano quel conto;
 *   3. Oggi di MSC: nessun avviso Cassa Edile (usa la stima del costo).
 */
'use strict';
require('dotenv').config({ quiet: true });
const FF = require('../lib/featureFlags');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}

async function main() {
  console.log('\nPalladia regression — F-514: il costo della manodopera resta nascosto\n');
  check('flag quanto_rende esiste ed è spento di default', 'quanto_rende' in FF.FEATURES && FF.FEATURES.quanto_rende === false, FF.FEATURES.quanto_rende);
  check('quanto_rende è fra i FROZEN (non si accende da solo per l\'impresa principale)', FF.FROZEN_FEATURES.has('quanto_rende'));

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log('  – skip dal vivo'); }
  else {
    const supabase = require('../lib/supabase');
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    check('MSC: flag spento', (await FF.isFeatureEnabled(CO, 'quanto_rende')) === false);
    const { costruisci } = require('../lib/oggi');
    const { data: own } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'owner').limit(1).maybeSingle();
    const oggi = await costruisci(CO, own?.user_id, 'owner');
    check('Oggi di MSC: nessun avviso Cassa Edile', oggi.righe.every(r => !String(r.id).startsWith('congruita-')), oggi.righe.map(r => r.id));

    const base = process.env.SELFTEST_API_URL || 'https://palladia-backend-production.up.railway.app';
    const { createClient } = require('@supabase/supabase-js');
    const { data: link } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: 'carpio@mscedilizia.it' });
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });
    const { data: ses } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    const h = { Authorization: `Bearer ${ses.session.access_token}`, 'X-Company-Id': CO };
    const r1 = await fetch(`${base}/api/v1/quanto-rende?mese=2026-10`, { headers: h });
    const j1 = await r1.json().catch(() => ({}));
    check('HTTP MSC titolare: il conto del mese non esce (404 FEATURE_DISABLED)', r1.status === 404 && j1.error === 'FEATURE_DISABLED', { status: r1.status, keys: Object.keys(j1) });
    const r2 = await fetch(`${base}/api/v1/quanto-rende/cantiere/6cd2a1be-8ce7-4f99-8324-0de2f235e525`, { headers: h });
    const j2 = await r2.json().catch(() => ({}));
    check('HTTP MSC titolare: il conto del cantiere non esce (404 FEATURE_DISABLED)', r2.status === 404 && j2.error === 'FEATURE_DISABLED', { status: r2.status, keys: Object.keys(j2) });
    const r3 = await fetch(`${base}/api/v1/quanto-rende/fatture-senza-cantiere`, { headers: h });
    check('HTTP MSC titolare: le fatture senza cantiere (F-510) restano', r3.status === 200, r3.status);
  }
  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
