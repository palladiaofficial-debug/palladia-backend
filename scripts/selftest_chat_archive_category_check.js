#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_chat_archive_category_check.js
 *
 * Regressione per F-094 (AUDIT.md) — archiveChatUpload() (services/
 * chatDocumentAnalysis.js), usata dai tool Ladia archive_document /
 * import_multi_document_batch, non sanificava mai `category` prima di
 * scriverla su site_documents/company_documents: un valore fuori dal CHECK
 * constraint del DB (es. un documento di un mezzo classificato con una
 * categoria libera dall'IA, mai un valore ammesso da company_docs_category_check)
 * faceva fallire l'intera archiviazione con un errore Postgres grezzo mostrato
 * all'utente in chat, invece di archiviare comunque il documento sotto 'altro'
 * — esattamente come già succedeva (e fixato) in smartImportPipeline.js
 * (import da zip), mai applicato a questo secondo percorso di archiviazione.
 *
 * Riprodotto dal vivo dalla trascrizione reale di una sessione Ladia
 * (27/08/2026): una carta di circolazione caricata insieme a idoneità
 * mediche ha fatto fallire l'archiviazione con
 * `new row for relation "company_documents" violates check constraint
 * "company_docs_category_check"`.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { sanitizeCategory } = require('../lib/documentCategory');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia — F-094: categoria non sanificata in archiveChatUpload (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  // ── 1. sanitizeCategory: unit — la funzione condivisa si comporta come atteso ──
  check_('sanitizeCategory: categoria valida passa invariata (company_documents/durc)', sanitizeCategory('company_documents', 'durc') === 'durc');
  check_('sanitizeCategory: categoria inventata da un mezzo → altro (company_documents)', sanitizeCategory('company_documents', 'veicolo') === 'altro');
  check_('sanitizeCategory: categoria inventata → altro (site_documents)', sanitizeCategory('site_documents', 'veicolo') === 'altro');
  check_('sanitizeCategory: worker_documents non ha CHECK, passa libera', sanitizeCategory('worker_documents', 'qualunque_cosa') === 'qualunque_cosa');
  check_('sanitizeCategory: null/undefined → altro', sanitizeCategory('company_documents', null) === 'altro');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('integrazione dal vivo', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = failed > 0 ? 1 : 0; return; }
  const { data: companyAUser } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1).single();

  // ── 2. Integrazione dal vivo: la stessa identica scena della trascrizione reale ──
  const BUCKET = 'site-documents';
  const storagePath = `${companyA.id}/chat-uploads/test-f094-${Date.now()}.pdf`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test carta circolazione'), { contentType: 'application/pdf' });
  if (upErr) { fail('Fixture: file reale caricato su storage', upErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const { data: uploadRow, error: uploadInsertErr } = await admin.from('chat_uploads').insert({
    company_id: companyA.id, user_id: companyAUser.user_id, original_name: 'MSC EDILIZIA.pdf', mime_type: 'application/pdf',
    storage_path: storagePath, size_bytes: 32,
  }).select('id').single();
  if (uploadInsertErr) { fail('Fixture: riga chat_uploads creata', uploadInsertErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  // Stessa identica categoria "libera" che l'IA avrebbe potuto restituire per
  // un documento di un mezzo (nessuna colonna equipment_documents ancora
  // disponibile come destination — vedi nota separata) — mai un valore reale
  // del CHECK constraint di company_documents.
  const archiveResult = await archiveChatUpload({
    uploadId: uploadRow.id, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'company_documents', name: 'Carta di circolazione CITY-X FX53745',
    category: 'veicolo',
  });

  check_('archiveChatUpload con categoria non ammessa: successo (non più errore DB grezzo)', archiveResult.success === true, archiveResult);

  if (archiveResult.success) {
    const { data: docRow } = await admin.from('company_documents').select('category').eq('id', archiveResult.doc_id).maybeSingle();
    check_('Documento archiviato con categoria sanificata a "altro"', docRow?.category === 'altro', docRow);
    await admin.from('company_documents').delete().eq('id', archiveResult.doc_id);
  }

  await admin.from('chat_uploads').delete().eq('id', uploadRow.id);
  await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
