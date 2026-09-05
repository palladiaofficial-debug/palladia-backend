#!/usr/bin/env node
/**
 * scripts/selftest_search_document_folderpath.js
 *
 * Regressione per F-130 (AUDIT.md, repo palladia): GET /api/v1/search
 * restituiva i documenti trovati senza indicare la cartella in cui vivono —
 * il frontend apriva sempre l'hub generico /documenti, mai il documento
 * trovato, perché quella pagina non aveva ancora una URL per la cartella
 * giusta. Ora /documenti/* è una route vera (F-130) e questa route calcola
 * folderPathFor() per restituire il percorso pronto all'uso.
 *
 * Verifica dal vivo, JWT reale, contro un documento aziendale creato ed
 * eliminato in E2E_COMPANY_ID — stesso pattern di selftest_document_folders.js.
 * Se le fixture E2E non sono configurate, il test si salta (non è una
 * regressione).
 *
 * Env: TEST_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== selftest_search_document_folderpath ===\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('intera suite', 'fixture E2E non configurate (SUPABASE_URL/ANON_KEY/E2E_EMAIL/E2E_PASSWORD/E2E_COMPANY_ID)');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} saltati\n`);
    return;
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  check('Login bot E2E riuscito', !loginErr && session?.session, loginErr);
  if (!session) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const jwt = session.session.access_token;

  const name = `TEST-E2E-F130-SearchFolderPath-${Date.now()}.pdf`;
  const { data: doc, error: insErr } = await supabase.from('company_documents').insert({
    company_id: E2E_COMPANY_ID, name, category: 'altro',
    file_path: `${E2E_COMPANY_ID}/_company/selftest-search-${Date.now()}.pdf`, file_size: 10, mime_type: 'application/pdf',
  }).select('id').single();
  check('Documento aziendale di test creato', !insErr && doc, insErr);
  if (!doc) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }

  try {
    const q = name.slice(0, 20); // porzione sicura per ilike, evita match parziali su altri residui
    const res = await fetch(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID },
    });
    const body = await res.json().catch(() => null);
    check('GET /search risponde 200', res.status === 200, res.status);
    // `documents` è la vista unificata sincronizzata da company_documents con un
    // proprio id (non lo stesso company_documents.id) — match per nome, non per id.
    const found = body?.documents?.find(d => d.name === name);
    check('Il documento aziendale di test compare nei risultati', !!found, body?.documents);
    check("folderPath del documento aziendale è 'azienda'", found?.folderPath === 'azienda', found);
  } finally {
    await supabase.from('company_documents').delete().eq('id', doc.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} saltati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
