#!/usr/bin/env node
/**
 * scripts/selftest_badge_ddt_enable_gate.js
 *
 * F-227 (AUDIT.md, 2026-09-23): caricamento DDT non più aperto a chiunque
 * abbia un badge attivo — richiesto esplicitamente dal titolare ("fa
 * confusione" vederlo su ogni lavoratore). Nuovo flag per-lavoratore
 * workers.ddt_upload_enabled (migrazione 228, default FALSE), attivabile
 * dall'Organico (WorkerDdtToggle.tsx -> PATCH /workers/:id).
 *
 * Verifica dal vivo, HTTP reale contro produzione, nessun mock:
 * 1) Un lavoratore appena creato (default false) NON può caricare un DDT —
 *    sia /scan che /confirm rifiutano con 403 DDT_NOT_ENABLED, non solo il
 *    bottone nascosto in UI (lato server, dove conta davvero).
 * 2) GET /punch-context riporta ddt_upload_enabled:false — quello che decide
 *    se badge-punch.html mostra la barra DDT.
 * 3) Dopo PATCH /workers/:id { ddt_upload_enabled: true } (sessione reale,
 *    stesso endpoint usato da WorkerDdtToggle.tsx), scan+confirm funzionano
 *    e punch-context riporta true.
 * 4) Dopo aver disabilitato di nuovo, torna a 403 — non un flag "sola andata".
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { hashPin } = require('../lib/pinHash');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY       = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const COMPANY_ID    = process.env.E2E_COMPANY_ID;
const EMAIL         = process.env.E2E_EMAIL;
const PASSWORD      = process.env.E2E_PASSWORD;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64');
const BUCKET = 'site-media';

async function main() {
  console.log('\n\x1b[1mAbilitazione per-lavoratore del caricamento DDT (F-227)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !COMPANY_ID || !EMAIL || !PASSWORD) {
    skip('gate abilita/disabilita DDT', 'fixture E2E non configurate (SUPABASE_*/E2E_*)');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth  = createClient(SUPABASE_URL, ANON_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }
  const jwt = sess.session.access_token;

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: wErr } = await admin.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-E2E F227 DdtGate', badge_code: badgeCode, is_active: true,
    area_pin_hash: await hashPin('123456'),
    // Niente ddt_upload_enabled qui — deve restare il default (false, migrazione 228).
  }).select('id').single();
  if (wErr) { fail('crea worker di test', wErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const { data: site, error: sErr } = await admin.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E F227 DdtGate Site', address: 'Via Test F-227', status: 'attivo',
  }).select('id').single();
  if (sErr) { fail('crea cantiere di test', sErr.message); await admin.from('workers').delete().eq('id', worker.id); process.exitCode = 1; return; }

  const costIds = [];
  const uploadedPaths = [];

  async function scanAndConfirm() {
    const fd = new FormData();
    fd.append('file', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'ddt.jpg');
    fd.append('site_id', site.id);
    const scanRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/scan`, { method: 'POST', body: fd });
    const scanBody = await scanRes.json().catch(() => ({}));
    if (scanRes.status === 200 && scanBody.file_url) uploadedPaths.push(scanBody.file_url);
    let confirmRes = null, confirmBody = null;
    if (scanRes.status === 200) {
      confirmRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: site.id, file_url: scanBody.file_url, descrizione: 'Test gate F-227' }),
      });
      confirmBody = await confirmRes.json().catch(() => ({}));
      if (confirmRes.status === 201 && confirmBody.id) costIds.push(confirmBody.id);
    }
    return { scanStatus: scanRes.status, scanBody, confirmStatus: confirmRes?.status, confirmBody };
  }

  async function fetchPunchContext() {
    const r = await fetch(`${BASE}/api/v1/badge/${badgeCode}/punch-context`);
    return r.json().catch(() => ({}));
  }

  try {
    console.log('Blocco 1 — default false: scan e confirm rifiutano lato server, non solo il bottone nascosto\n');
    const r1 = await scanAndConfirm();
    check('scan -> 403 DDT_NOT_ENABLED', r1.scanStatus === 403 && r1.scanBody.error === 'DDT_NOT_ENABLED', r1);
    // confirm non tentato se scan già rifiutato — verificato comunque direttamente sotto, blocco a parte.
    const directConfirm = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: `${COMPANY_ID}/${site.id}/ddt/fake.jpg`, descrizione: 'x' }),
    });
    check('confirm -> 403 DDT_NOT_ENABLED anche chiamato direttamente (non basta bloccare solo scan)', directConfirm.status === 403, directConfirm.status);

    console.log('\nBlocco 2 — punch-context riflette il flag reale (quello che decide la barra DDT in UI)\n');
    const ctx1 = await fetchPunchContext();
    check('punch-context: ddt_upload_enabled = false', ctx1.ddt_upload_enabled === false, ctx1.ddt_upload_enabled);

    console.log('\nBlocco 3 — dopo PATCH /workers/:id (stesso endpoint di WorkerDdtToggle.tsx), il flusso funziona\n');
    const patchOn = await fetch(`${BASE}/api/v1/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
      body: JSON.stringify({ ddt_upload_enabled: true }),
    });
    check('PATCH ddt_upload_enabled:true -> 200', patchOn.status === 200, patchOn.status);

    const ctx2 = await fetchPunchContext();
    check('punch-context: ddt_upload_enabled = true dopo l\'abilitazione', ctx2.ddt_upload_enabled === true, ctx2.ddt_upload_enabled);

    const r2 = await scanAndConfirm();
    check('scan -> 200 dopo abilitazione', r2.scanStatus === 200, r2.scanStatus);
    check('confirm -> 201 dopo abilitazione', r2.confirmStatus === 201, r2.confirmStatus);
    const { data: row } = await admin.from('site_costs').select('id, tipo, importo, created_by').eq('id', r2.confirmBody?.id).maybeSingle();
    check('riga site_costs reale, tipo ddt, importo NULL', row?.tipo === 'ddt' && row?.importo === null, row);

    console.log('\nBlocco 4 — disabilitare di nuovo torna a bloccare (non un flag a sola andata)\n');
    const patchOff = await fetch(`${BASE}/api/v1/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
      body: JSON.stringify({ ddt_upload_enabled: false }),
    });
    check('PATCH ddt_upload_enabled:false -> 200', patchOff.status === 200, patchOff.status);

    const r3 = await scanAndConfirm();
    check('scan -> 403 DDT_NOT_ENABLED dopo la disabilitazione', r3.scanStatus === 403, r3.scanStatus);

  } finally {
    if (costIds.length) await admin.from('site_costs').delete().in('id', costIds);
    for (const p of uploadedPaths) await admin.storage.from(BUCKET).remove([p]).catch(() => {});
    await admin.from('sites').delete().eq('id', site.id);
    await admin.from('workers').delete().eq('id', worker.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
