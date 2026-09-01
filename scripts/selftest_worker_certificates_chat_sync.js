#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_worker_certificates_chat_sync.js
 *
 * Regressione per F-107 (AUDIT.md) — archiveChatUpload() (services/
 * chatDocumentAnalysis.js), destination="worker_certificates" (una delle due
 * destinazioni valide per un attestato di formazione, l'altra è
 * "worker_documents" già coperta da F-105): faceva un INSERT diretto senza
 * mai cercare un certificato già esistente per lo stesso worker+course_type,
 * e non chiamava mai syncWorkerExpiry — a differenza del ramo
 * "worker_documents". Risultato osservato dal vivo il 01/09/2026 su un
 * lavoratore reale (Festim Dervishaj, azienda dell'utente): un aggiornamento
 * formazione archiviato da Ladia con questa destinazione ha creato una riga
 * worker_certificates ORFANA (course_type_id mai risolto, quindi null),
 * lasciato la riga esistente del corso reale ("Formazione lavoratori -
 * Rischio Alto") ancora scaduta, e workers.safety_training_expiry invariato
 * — Organico ha continuato a mostrare "Non conforme" nonostante Ladia avesse
 * dichiarato più volte "Fatto", in una conversazione di 6 round prima che
 * l'utente rinunciasse e Ladia patchasse a mano il campo compliance senza
 * sistemare i dati sottostanti (fix fragile: il prossimo sync l'avrebbe
 * silenziosamente rimesso a scaduto).
 */
require('dotenv').config();
const supabase = require('../lib/supabase');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const BUCKET = 'site-documents';

async function uploadChatFile(companyId, userId, filename) {
  const storagePath = `${companyId}/chat-uploads/test-f107-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test formazione'), { contentType: 'application/pdf' });
  if (upErr) throw new Error('upload storage: ' + upErr.message);
  const { data: row, error: insErr } = await supabase.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: filename, mime_type: 'application/pdf',
    storage_path: storagePath, size_bytes: 32,
  }).select('id').single();
  if (insErr) throw new Error('insert chat_uploads: ' + insErr.message);
  return row.id;
}

async function main() {
  console.log('\nPalladia — F-107: archiviazione via chat su worker_certificates non aggiornava il certificato esistente né Organico (regressione)\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-F107-WorkerCertSync-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: companyId, full_name: 'TEST F107 Worker', fiscal_code: `TSTF107${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: `TSTF107-${Date.now()}`, is_active: true,
  }).select().single();
  check('Creato lavoratore temporaneo', !workerErr && worker, workerErr);
  if (!worker) { await supabase.from('companies').delete().eq('id', companyId); console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const workerId = worker.id;

  const { data: usersPage } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const ciUser = usersPage?.users?.find((u) => u.email === 'ci-test@palladia.internal');
  if (!ciUser) {
    console.log('  \x1b[33m–\x1b[0m suite (skip: utente ci-test@palladia.internal non trovato in questo ambiente)');
    await supabase.from('companies').delete().eq('id', companyId);
    console.log(`\n${passed} passati, ${failed} falliti\n`);
    process.exitCode = 0;
    return;
  }
  const userId = ciUser.id;

  const { data: courseType } = await supabase.from('course_types').select('id').ilike('name', 'Formazione lavoratori - Rischio Alto').maybeSingle();
  if (!courseType) {
    console.log('  \x1b[33m–\x1b[0m suite (skip: course_type "Formazione lavoratori - Rischio Alto" non trovato in questo ambiente)');
    await supabase.from('companies').delete().eq('id', companyId);
    console.log(`\n${passed} passati, ${failed} falliti\n`);
    process.exitCode = 0;
    return;
  }

  try {
    // ── Caso 1 (scenario esatto dell'incidente): il lavoratore ha già un
    // certificato "Rischio Alto" scaduto in worker_certificates (come chi
    // arriva da un caricamento manuale o da un'archiviazione precedente via
    // worker_documents) — un rinnovo archiviato via destination=
    // "worker_certificates", SENZA course_type_id esplicito (come lo manda
    // Ladia quando non lo conosce), deve aggiornare QUELLA riga, non crearne
    // una nuova, e deve risincronizzare workers.safety_training_expiry. ────
    const { data: existingCert } = await supabase.from('worker_certificates').insert({
      company_id: companyId, worker_id: workerId, course_type_id: courseType.id,
      issue_date: '2021-07-22', expiry_date: '2026-07-22', issuing_body: 'Test Ente',
    }).select('id').single();

    const uploadId1 = await uploadChatFile(companyId, userId, 'AGG FORMAZIONE - TEST F107 Worker.pdf');
    const res1 = await archiveChatUpload({
      uploadId: uploadId1, companyId, userId,
      destination: 'worker_certificates', name: 'Aggiornamento formazione — TEST F107 Worker',
      workerId, category: 'formazione_sicurezza', expiryDate: '2031-07-20', issueDate: '2026-07-20',
    });
    check('archiveChatUpload (worker_certificates, rinnovo) → success', res1.success === true, res1);

    const { data: certsAfter1 } = await supabase.from('worker_certificates').select('id, course_type_id, expiry_date').eq('worker_id', workerId).eq('company_id', companyId);
    check('FIX F-107: nessuna riga orfana creata — resta UNA sola riga worker_certificates per questo lavoratore', (certsAfter1 || []).length === 1, certsAfter1);
    check('la riga esistente è stata aggiornata (stesso id), non sostituita', certsAfter1?.[0]?.id === existingCert.id, certsAfter1);
    check('expiry_date aggiornata a 2031-07-20', certsAfter1?.[0]?.expiry_date === '2031-07-20', certsAfter1);
    check('course_type_id resta quello del corso reale (non null)', certsAfter1?.[0]?.course_type_id === courseType.id, certsAfter1);

    const { data: workerAfter1 } = await supabase.from('workers').select('safety_training_expiry').eq('id', workerId).maybeSingle();
    check('FIX F-107: workers.safety_training_expiry sincronizzato anche via destination=worker_certificates (prima restava scaduto)', workerAfter1?.safety_training_expiry === '2031-07-20', workerAfter1);

    // ── Caso 2: stesso lavoratore, un documento senza corso riconoscibile
    // (categoria non in FORMAZIONE_SYNC_TYPES) → fallback: salva comunque il
    // documento, non deve far fallire l'archiviazione né toccare le scadenze. ──
    const uploadId2 = await uploadChatFile(companyId, userId, 'certificato-generico.pdf');
    const res2 = await archiveChatUpload({
      uploadId: uploadId2, companyId, userId,
      destination: 'worker_certificates', name: 'Certificato generico — TEST F107 Worker',
      workerId, category: 'altro', expiryDate: '2030-01-01', issueDate: '2025-01-01', issuingBody: 'Test Ente',
    });
    check('archiveChatUpload (worker_certificates, categoria non mappata) → success comunque (fallback)', res2.success === true, res2);
    const { data: workerAfter2 } = await supabase.from('workers').select('safety_training_expiry').eq('id', workerId).maybeSingle();
    check('un documento non mappato non tocca safety_training_expiry', workerAfter2?.safety_training_expiry === '2031-07-20', workerAfter2);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su workers/worker_certificates
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
