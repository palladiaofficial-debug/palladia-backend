#!/usr/bin/env node
/**
 * scripts/selftest_badge_ddt_upload.js
 *
 * F-213 (AUDIT.md, 2026-09-18): caricamento DDT per i trasportatori interni
 * — richiesto dal titolare per avere "sotto controllo tutti i DDT" da
 * confrontare poi con le fatture. Stessa identità badge già usata per la
 * timbratura, nessuna nuova autenticazione; stessa lettura AI già in uso
 * per fatture/ricevute (lib/siteCostOcr.js).
 *
 * Verifica dal vivo, HTTP reale contro produzione, nessun mock:
 * 1) /ddt/scan carica DAVVERO la foto nel bucket site-media e ritorna un
 *    file_url dentro quel cantiere/company (non un percorso arbitrario).
 * 2) /ddt/confirm scrive DAVVERO in site_costs (tipo='ddt', importo=NULL —
 *    mai un valore inventato, created_by='badge:<workerId>'), non solo una
 *    risposta 200.
 * 3) confirm rifiuta un file_url che non appartiene a questo worker/site
 *    (400 INVALID_FILE_URL) — non basta conoscere un site_id per accreditare
 *    la foto di qualcun altro.
 * 4) un badge disattivato o inesistente non può caricare nulla.
 * 5) today_count riflette il conteggio reale in DB, non solo "1" fisso.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { hashPin } = require('../lib/pinHash');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'site-media';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// JPEG 1x1 minimo valido — basta a passare i controlli di tipo file, l'AI
// può anche non estrarre nulla di utile da un'immagine così (non bloccante
// per design, vedi badgeDdt.js).
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64');

async function getCiTestCompany(admin) {
  const { data: companies } = await admin.from('companies').select('id, name').eq('name', 'MSCedilizia');
  return companies?.[0]?.id || null;
}

async function main() {
  console.log('\n\x1b[1mCaricamento DDT trasportatori interni via badge (F-213)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY) { skip('caricamento DDT via badge', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const companyId = await getCiTestCompany(admin);
  if (!companyId) { skip('caricamento DDT via badge', 'company ci-test non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: wErr } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-E2E F213 BadgeDdt', badge_code: badgeCode, is_active: true,
    area_pin_hash: await hashPin('123456'),
    ddt_upload_enabled: true, // F-227: default false da migrazione 228, questo test verifica il flusso a valle del gate
  }).select('id').single();
  if (wErr) { console.error('Impossibile creare il worker di test:', wErr.message); process.exitCode = 1; return; }

  const { data: site, error: sErr } = await admin.from('sites').insert({
    company_id: companyId, name: 'TEST-E2E F213 BadgeDdt Site', address: 'Via Test F-213', status: 'attivo',
  }).select('id, name').single();
  if (sErr) { console.error('Impossibile creare il cantiere di test:', sErr.message); await admin.from('workers').delete().eq('id', worker.id); process.exitCode = 1; return; }

  const costIds = [];
  let uploadedPath = null;

  try {
    console.log('Blocco 1 — scan carica DAVVERO la foto e ritorna un file_url nel cantiere giusto (live HTTP)\n');

    const fd1 = new FormData();
    fd1.append('file', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'ddt.jpg');
    fd1.append('site_id', site.id);
    const scanRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/scan`, { method: 'POST', body: fd1 });
    const scanBody = await scanRes.json().catch(() => ({}));
    check('scan -> 200', scanRes.status === 200, { status: scanRes.status, body: scanBody });
    check('file_url dentro company/site attesi', typeof scanBody.file_url === 'string' && scanBody.file_url.startsWith(`${companyId}/${site.id}/ddt/`), scanBody.file_url);
    uploadedPath = scanBody.file_url;

    const { data: storageCheck } = await admin.storage.from(BUCKET).list(`${companyId}/${site.id}/ddt`);
    const uploadedName = uploadedPath?.split('/').pop();
    check('il file esiste DAVVERO nel bucket site-media (non solo la risposta HTTP)', !!storageCheck?.find(f => f.name === uploadedName), storageCheck?.map(f => f.name));

    console.log('\nBlocco 2 — confirm scrive DAVVERO in site_costs, importo NULL, mai inventato (live HTTP)\n');

    const confirmRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: uploadedPath, fornitore: 'Test Fornitore SRL', numero_documento: '1234', data_documento: '2026-09-18', descrizione: 'Cemento tipo II' }),
    });
    const confirmBody = await confirmRes.json().catch(() => ({}));
    check('confirm -> 201', confirmRes.status === 201, { status: confirmRes.status, body: confirmBody });
    if (confirmBody?.id) costIds.push(confirmBody.id);

    const { data: row } = await admin.from('site_costs').select('*').eq('id', confirmBody.id).maybeSingle();
    check('la riga esiste davvero in DB', !!row, row);
    check('tipo = ddt', row?.tipo === 'ddt', row?.tipo);
    check('importo è NULL — mai un valore inventato per un documento senza prezzo', row?.importo === null, row?.importo);
    check('created_by = badge:<workerId> (tracciabile, non anonimo)', row?.created_by === `badge:${worker.id}`, row?.created_by);
    check('fornitore/numero/descrizione salvati come confermati', row?.fornitore === 'Test Fornitore SRL' && row?.numero_documento === '1234', row);
    check('today_count riflette il conteggio reale (1, il primo di oggi)', confirmBody.today_count === 1, confirmBody.today_count);

    console.log('\nBlocco 3 — confirm rifiuta un file_url che non appartiene a questo worker/site (live HTTP)\n');

    const wrongUrlRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: `${companyId}/${site.id}/ddt/../../../secret.jpg`, descrizione: 'x' }),
    });
    check('file_url estraneo -> 400 INVALID_FILE_URL', wrongUrlRes.status === 400, wrongUrlRes.status);

    console.log('\nBlocco 4 — un secondo DDT nello stesso giorno alza il contatore (live HTTP)\n');

    const fd2 = new FormData();
    fd2.append('file', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'ddt2.jpg');
    fd2.append('site_id', site.id);
    const scan2 = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/scan`, { method: 'POST', body: fd2 });
    const scan2Body = await scan2.json();
    const confirm2 = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: scan2Body.file_url, descrizione: 'Secondo DDT' }),
    });
    const confirm2Body = await confirm2.json();
    if (confirm2Body?.id) costIds.push(confirm2Body.id);
    check('today_count sale a 2 (conta davvero, non resta fisso)', confirm2Body.today_count === 2, confirm2Body.today_count);

    console.log('\nBlocco 5 — un badge disattivato/inesistente non può caricare nulla (live HTTP)\n');

    await admin.from('workers').update({ is_active: false }).eq('id', worker.id);
    const revokedRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: uploadedPath, descrizione: 'x' }),
    });
    check('badge disattivato -> 403 BADGE_REVOKED', revokedRes.status === 403, revokedRes.status);

    const fakeRes = await fetch(`${BASE}/api/v1/badge/${'0'.repeat(18)}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, file_url: uploadedPath, descrizione: 'x' }),
    });
    check('badge inesistente -> 401 BADGE_NOT_FOUND', fakeRes.status === 401, fakeRes.status);

  } finally {
    if (costIds.length) await admin.from('site_costs').delete().in('id', costIds);
    const { data: files } = await admin.storage.from(BUCKET).list(`${companyId}/${site.id}/ddt`);
    if (files?.length) await admin.storage.from(BUCKET).remove(files.map(f => `${companyId}/${site.id}/ddt/${f.name}`));
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
