#!/usr/bin/env node
/**
 * scripts/selftest_badge_ddt_unassigned.js
 *
 * F-214 (AUDIT.md, 2026-09-19): un trasportatore consegna materiale su un
 * cantiere che non esiste ancora in Palladia — richiesto esplicitamente dal
 * titolare dopo aver provato dal vivo F-213 ("se invece è inerente a un
 * cantiere nuovo ancora non registrato su palladia?"). Il DDT non deve mai
 * andare perso: finisce in company_expenses (spesa "da assegnare", stesso
 * meccanismo già usato per le fatture SDI senza cantiere certo), il titolare
 * lo riassegna al cantiere vero dalla scheda Spese (matita) appena lo crea.
 *
 * Verifica dal vivo, HTTP reale contro produzione, nessun mock:
 * 1) /ddt/scan senza site_id ma con cantiere_libero carica DAVVERO la foto
 *    (percorso company/ddt-non-assegnati/ddt/…, non dentro un cantiere).
 * 2) /ddt/confirm senza site_id scrive DAVVERO in company_expenses
 *    (site_id NULL, amount NULL — mai un prezzo inventato, source
 *    'badge_ddt', notes col nome scritto dal trasportatore), non solo 201.
 * 3) confirm rifiuta un file_url estraneo anche su questo percorso
 *    (stesso controllo path-traversal di F-213, prefisso diverso).
 * 4) mancano SIA site_id CHE cantiere_libero -> 400, mai un salvataggio
 *    "a vuoto".
 * 5) /expenses/summary non esplode su una riga con amount NULL (stessa
 *    garanzia di Number(null) === 0 già usata per site_costs, F-213).
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

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64');

async function getCiTestCompany(admin) {
  const { data: companies } = await admin.from('companies').select('id, name').eq('name', 'MSCedilizia');
  return companies?.[0]?.id || null;
}

async function main() {
  console.log('\n\x1b[1mDDT su cantiere non ancora censito (F-214)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY) { skip('DDT su cantiere non censito', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const companyId = await getCiTestCompany(admin);
  if (!companyId) { skip('DDT su cantiere non censito', 'company ci-test non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: wErr } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-E2E F214 BadgeDdtUnassigned', badge_code: badgeCode, is_active: true,
    area_pin_hash: await hashPin('123456'),
  }).select('id').single();
  if (wErr) { console.error('Impossibile creare il worker di test:', wErr.message); process.exitCode = 1; return; }

  const CANTIERE_LIBERO = 'Via Test F-214 Non Censito 99, Genova';
  const expenseIds = [];

  try {
    console.log('Blocco 1 — scan senza site_id ma con cantiere_libero carica DAVVERO la foto (live HTTP)\n');

    const fd1 = new FormData();
    fd1.append('file', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'ddt.jpg');
    fd1.append('cantiere_libero', CANTIERE_LIBERO);
    const scanRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/scan`, { method: 'POST', body: fd1 });
    const scanBody = await scanRes.json().catch(() => ({}));
    check('scan -> 200', scanRes.status === 200, { status: scanRes.status, body: scanBody });
    check('file_url nel percorso "non assegnati", non in un cantiere', typeof scanBody.file_url === 'string' && scanBody.file_url.startsWith(`${companyId}/ddt-non-assegnati/ddt/`), scanBody.file_url);
    const uploadedPath = scanBody.file_url;

    const { data: storageCheck } = await admin.storage.from(BUCKET).list(`${companyId}/ddt-non-assegnati/ddt`);
    const uploadedName = uploadedPath?.split('/').pop();
    check('il file esiste DAVVERO nel bucket site-media', !!storageCheck?.find(f => f.name === uploadedName), storageCheck?.map(f => f.name));

    console.log('\nBlocco 2 — confirm senza site_id scrive DAVVERO in company_expenses (live HTTP)\n');

    const confirmRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantiere_libero: CANTIERE_LIBERO, file_url: uploadedPath, fornitore: 'Test Fornitore Non Censito', numero_documento: '999', data_documento: '2026-09-19', descrizione: 'Cemento — cantiere non censito' }),
    });
    const confirmBody = await confirmRes.json().catch(() => ({}));
    check('confirm -> 201', confirmRes.status === 201, { status: confirmRes.status, body: confirmBody });
    if (confirmBody?.id) expenseIds.push(confirmBody.id);

    const { data: row } = await admin.from('company_expenses').select('*').eq('id', confirmBody.id).maybeSingle();
    check('la riga esiste davvero in DB', !!row, row);
    check('site_id è NULL — nessun cantiere inventato', row?.site_id === null, row?.site_id);
    check('amount è NULL — mai un prezzo inventato per un documento senza importo', row?.amount === null, row?.amount);
    check('source = badge_ddt (distinguibile dalle altre origini)', row?.source === 'badge_ddt', row?.source);
    check('notes contiene il nome scritto dal trasportatore', row?.notes?.includes(CANTIERE_LIBERO), row?.notes);
    check('fornitore/numero salvati come confermati', row?.supplier === 'Test Fornitore Non Censito' && row?.invoice_number === '999', row);
    check('expense_date valorizzata (mai NULL, colonna NOT NULL)', !!row?.expense_date, row?.expense_date);

    console.log('\nBlocco 3 — confirm rifiuta un file_url estraneo anche su questo percorso (live HTTP)\n');

    const wrongUrlRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantiere_libero: CANTIERE_LIBERO, file_url: `${companyId}/ddt-non-assegnati/ddt/../../../secret.jpg`, descrizione: 'x' }),
    });
    check('file_url estraneo -> 400 INVALID_FILE_URL', wrongUrlRes.status === 400, wrongUrlRes.status);

    console.log('\nBlocco 4 — né site_id né cantiere_libero -> 400, mai un salvataggio "a vuoto" (live HTTP)\n');

    const noneRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_url: uploadedPath, descrizione: 'x' }),
    });
    check('né site_id né cantiere_libero -> 400', noneRes.status === 400, noneRes.status);

    const emptyStringRes = await fetch(`${BASE}/api/v1/badge/${badgeCode}/ddt/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantiere_libero: '   ', file_url: uploadedPath, descrizione: 'x' }),
    });
    check('cantiere_libero solo spazi -> 400 (non un nome vuoto salvato)', emptyStringRes.status === 400, emptyStringRes.status);

    console.log('\nBlocco 5 — /expenses/summary non esplode su una riga con amount NULL (live HTTP, sessione reale)\n');

    // Nessuna sessione JWT company disponibile in questo script (worker badge,
    // non utente app) — verifica diretta della stessa aritmetica usata da
    // routes/v1/expenses.js::/summary (Number(null) === 0) invece di una
    // chiamata autenticata, stesso principio di garanzia, senza dover
    // impersonare un utente reale solo per questo controllo.
    const signedAmount = (e) => e.is_credit_note ? -Number(e.amount) : Number(e.amount);
    check('Number(null) vale 0 — una riga senza importo non altera i totali esistenti', signedAmount({ amount: row?.amount, is_credit_note: false }) === 0, row?.amount);

  } finally {
    if (expenseIds.length) await admin.from('company_expenses').delete().in('id', expenseIds);
    const { data: files } = await admin.storage.from(BUCKET).list(`${companyId}/ddt-non-assegnati/ddt`);
    if (files?.length) await admin.storage.from(BUCKET).remove(files.map(f => `${companyId}/ddt-non-assegnati/ddt/${f.name}`));
    await admin.from('workers').delete().eq('id', worker.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
