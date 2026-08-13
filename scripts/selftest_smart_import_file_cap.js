#!/usr/bin/env node
/**
 * scripts/selftest_smart_import_file_cap.js
 *
 * Regressione per il cap "massimo 500 file per importazione, con messaggio
 * comprensibile invece di un errore grezzo" (protezione costi AI, 2026-08-13).
 *
 * Prima del fix: il tetto tecnico multer su /smart-import/batches/from-files
 * era fissato esattamente a MAX_BATCH_ITEMS (500) — chi caricava 501+ file
 * riceveva un rifiuto secco dell'INTERA richiesta (400 TROPPI_FILE, nessun
 * dettaglio), mentre lo stesso scenario via zip riceveva già un successo
 * parziale con un motivo chiaro per file ("Limite di 500 file per
 * importazione superato — dividi in più batch."). Fix: il tetto multer è
 * ora un margine tecnico più alto (750, solo anti-saturazione memoria); il
 * tetto di business resta 500, applicato con lo stesso messaggio su
 * entrambi i percorsi (zip e cartella) da services/smartImportPipeline.js.
 *
 * Due parti, entrambe economiche (nessuna chiamata Anthropic reale):
 * 1) HTTP end-to-end contro il server reale (richiede `npm start` attivo,
 *    stessa convenzione degli altri selftest HTTP di questo repo) — 600
 *    file con estensione non riconosciuta: vengono scartati per "tipo non
 *    supportato" prima ancora di arrivare al cap, quindi nessun batch reale
 *    viene creato — serve solo a dimostrare che multer non rifiuta più in
 *    blocco la richiesta a 501+ file.
 * 2) createBatchRow() chiamata direttamente (nessun server, nessun upload
 *    reale) — verifica il vero cap di business (500) con file "validi":
 *    crea una riga import_batches reale (ripulita subito dopo), MAI
 *    ingestAndProcess (che è la parte che toccherebbe Storage/AI) — quella
 *    funzione non viene mai chiamata da questo test.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { createBatchRow, MAX_BATCH_ITEMS } = require('../services/smartImportPipeline');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — cap 500 file per importazione, messaggio chiaro\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('cap 500 file per importazione', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // ── Parte 2 (indipendente dal server): createBatchRow direttamente ────────
  let batchId = null;
  let tempCompanyId = null;
  try {
    const { data: anyUser } = await admin.auth.admin.listUsers();
    const someUserId = anyUser?.users?.[0]?.id;
    const { data: company } = await admin.from('companies').insert({ name: `TEST-FileCap-${Date.now()}` }).select('id').single();
    tempCompanyId = company.id;
    const entries = Array.from({ length: 600 }, (_, i) => ({ name: `finto-${i}.pdf`, buffer: Buffer.alloc(0), mime: 'application/pdf' }));
    const result = await createBatchRow({ companyId: company.id, userId: someUserId, source: 'folder', entries });
    batchId = result.batchId;

    check(`createBatchRow: primi ${MAX_BATCH_ITEMS} file accettati`, result.usable.length === MAX_BATCH_ITEMS, result.usable.length);
    check('createBatchRow: 100 file oltre il limite finiscono in overflow', result.overflow.length === 100, result.overflow.length);
    check('createBatchRow: motivo comprensibile, non un codice', result.overflow[0]?.reason === `Limite di ${MAX_BATCH_ITEMS} file per importazione superato — dividi in più batch.`, result.overflow[0]);
  } catch (e) {
    fail('createBatchRow eseguita senza errori', e.message);
  } finally {
    if (batchId) await admin.from('import_batches').delete().eq('id', batchId);
    if (tempCompanyId) await admin.from('companies').delete().eq('id', tempCompanyId);
  }

  // ── Parte 1: HTTP end-to-end, nessun batch reale creato ────────────────────
  try {
    const { data: users } = await admin.auth.admin.listUsers();
    const user = users?.users?.find((u) => u.email === TEST_EMAIL);
    if (!user) throw new Error('utente ci-test non trovato');

    const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
    const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map((m) => m.company_id));
    const company = (companies || []).find((c) => c.name === 'MSCedilizia');
    if (!company) throw new Error('company MSCedilizia non trovata');

    const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
    await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
    const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tempPassword });
    if (loginErr || !session?.session) throw new Error('login ci-test fallito: ' + loginErr?.message);
    const jwt = session.session.access_token;

    const N = 600; // sopra il vecchio tetto multer (500), sotto il nuovo (750)
    const form = new FormData();
    for (let i = 0; i < N; i++) form.append('files', new Blob(['x']), `finto-${i}.xyz`); // estensione non supportata: zero elaborazione AI

    const res = await fetch(`${BASE}/api/v1/smart-import/batches/from-files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': company.id },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    check('600 file NON vengono rifiutati in blocco da multer (niente TROPPI_FILE)', body.error !== 'TROPPI_FILE', body);
    check('la richiesta arriva alla pipeline (tutti scartati per tipo, non per conteggio)', body.error === 'NESSUN_FILE_VALIDO' && body.skipped?.length === N, { error: body.error, skippedLength: body.skipped?.length });
  } catch (e) {
    skip('cap file — verifica HTTP end-to-end', `server non raggiungibile o fixture ci-test assenti (${e.message})`);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
