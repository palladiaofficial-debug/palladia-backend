#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_chat_archive_worker_name_resolution.js
 *
 * Regressione per F-181 (AUDIT.md) — archive_document (Ladia chat) non
 * accettava worker_name come alternativa a worker_id per worker_documents/
 * worker_certificates/payslips, a differenza di praticamente ogni altro
 * tool che tocca un lavoratore in chat.js (propose_action, update_record,
 * get_worker_hours, ecc. — tutti risolvono "nome→id lato server"). Senza
 * worker_id il modello doveva SEMPRE fare un giro get_workers/
 * get_worker_detail PRIMA di poter tentare l'archiviazione: un tentativo
 * "ottimista" con solo il nome estratto dal documento falliva e basta,
 * costringendo a un retry via tool aggiuntivi (osservato dal vivo:
 * "archiviazione documento — worker_id obbligatorio per worker_documents"
 * due volte di fila nella stessa conversazione, prima del lookup).
 *
 * Copre: risoluzione per nome unico (successo, worker_id corretto sulla riga
 * scritta), nome ambiguo (errore esplicito NOME_AMBIGUO, NESSUNA scrittura —
 * mai una scelta silenziosa su un documento di compliance), nessun match
 * (errore chiaro), e che passare worker_id direttamente continua a funzionare
 * invariato (non-regressione sul percorso principale).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function makeUpload(admin, companyId, userId, label) {
  const BUCKET = 'site-documents';
  const storagePath = `${companyId}/chat-uploads/test-f181-${label}-${Date.now()}.pdf`;
  await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  const { data: row, error } = await admin.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: `${label}.pdf`, mime_type: 'application/pdf',
    storage_path: storagePath, size_bytes: 20,
  }).select('id').single();
  if (error) throw error;
  return row.id;
}

async function main() {
  console.log('\nPalladia — F-181: worker_name come alternativa a worker_id in archive_document (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('suite', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }
  const { data: companyAUser } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1).single();

  const suffix = Date.now();
  const { data: workerUno, error: w1Err } = await admin.from('workers').insert({
    company_id: companyA.id, full_name: `TEST-F181-Alfa Uno ${suffix}`, fiscal_code: `TSF181U${suffix}`.slice(0, 16).toUpperCase(),
    badge_code: `TSTF181U-${suffix}`, is_active: true,
  }).select('id').single();
  const { data: workerDue, error: w2Err } = await admin.from('workers').insert({
    company_id: companyA.id, full_name: `TEST-F181-Alfa Due ${suffix}`, fiscal_code: `TSF181D${suffix}`.slice(0, 16).toUpperCase(),
    badge_code: `TSTF181D-${suffix}`, is_active: true,
  }).select('id').single();
  if (w1Err || w2Err) { fail('Fixture: lavoratori creati', (w1Err || w2Err).message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  // ── 1. worker_name unico → risolve e archivia sul lavoratore giusto ────────
  const uploadId1 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'unico');
  const r1 = await archiveChatUpload({
    uploadId: uploadId1, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'worker_documents', name: 'Idoneità medica',
    workerName: `Alfa Uno ${suffix}`, category: 'idoneita_medica', expiryDate: '2027-01-01',
  });
  check_('worker_name unico: archiviazione riuscita (nessun worker_id passato)', r1.success === true, r1);
  if (r1.success) {
    const { data: doc } = await admin.from('worker_documents').select('worker_id').eq('id', r1.doc_id).maybeSingle();
    check_('worker_id sulla riga scritta corrisponde al lavoratore risolto per nome', doc?.worker_id === workerUno.id, doc);
  }

  // ── 2. worker_name ambiguo → errore esplicito, NESSUNA scrittura ──────────
  const uploadId2 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'ambiguo');
  const r2 = await archiveChatUpload({
    uploadId: uploadId2, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'worker_documents', name: 'Idoneità medica',
    workerName: `TEST-F181-Alfa`, category: 'idoneita_medica',
  });
  check_('worker_name ambiguo (2 lavoratori corrispondono): errore NOME_AMBIGUO', r2.error === 'NOME_AMBIGUO', r2);
  const { data: uploadAfterAmbiguous } = await admin.from('chat_uploads').select('archived').eq('id', uploadId2).maybeSingle();
  check_('worker_name ambiguo: il file resta NON archiviato (nessuna scelta silenziosa)', uploadAfterAmbiguous?.archived === false, uploadAfterAmbiguous);

  // ── 3. worker_name senza match → errore chiaro, non un crash ──────────────
  const uploadId3 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'nomatch');
  const r3 = await archiveChatUpload({
    uploadId: uploadId3, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'worker_documents', name: 'Idoneità medica',
    workerName: 'ZZZ-NESSUN-LAVORATORE-COSI-CHIAMATO-999',
    category: 'idoneita_medica',
  });
  check_('Nessun lavoratore corrispondente → errore chiaro (non crash, non archiviato)', !!r3.error && !r3.success, r3);

  // ── 4. worker_id diretto continua a funzionare invariato (non-regressione) ─
  const uploadId4 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'id-diretto');
  const r4 = await archiveChatUpload({
    uploadId: uploadId4, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'worker_documents', name: 'Idoneità medica',
    workerId: workerDue.id, category: 'idoneita_medica', expiryDate: '2027-01-01',
  });
  check_('worker_id passato direttamente: invariato, archiviazione riuscita', r4.success === true, r4);

  // ── 5. Né worker_id né worker_name → stesso errore di sempre ──────────────
  const uploadId5 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'nessuno');
  const r5 = await archiveChatUpload({
    uploadId: uploadId5, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'worker_documents', name: 'Idoneità medica', category: 'idoneita_medica',
  });
  check_('Né worker_id né worker_name: errore "obbligatorio", non crash', !!r5.error && !r5.success, r5);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await admin.from('worker_documents').delete().in('worker_id', [workerUno.id, workerDue.id]);
  await admin.from('chat_uploads').delete().in('id', [uploadId1, uploadId2, uploadId3, uploadId4, uploadId5]);
  await admin.from('workers').delete().in('id', [workerUno.id, workerDue.id]);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
