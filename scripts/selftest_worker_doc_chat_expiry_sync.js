#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_worker_doc_chat_expiry_sync.js
 *
 * Regressione per F-105 (AUDIT.md) — archiveChatUpload() (services/
 * chatDocumentAnalysis.js), usata dal tool Ladia archive_document per
 * destination="worker_documents", scriveva il documento ma non chiamava mai
 * syncWorkerExpiry() (lib/workerDocSync.js) — a differenza del caricamento
 * manuale (routes/v1/workerDocs.js), che la chiama dopo ogni insert/update/
 * delete. Risultato osservato dal vivo il 31/08/2026, azienda reale
 * dell'utente: Ladia ha archiviato 9 idoneità mediche dichiarando "Fatto —
 * In regola" per ciascuna, ma workers.health_fitness_expiry non si è mai
 * mosso dal valore vecchio per NESSUNO dei 9 — Organico ha continuato a
 * mostrare "Non conforme" per tutti, un falso successo in chat.
 *
 * Copre anche una seconda causa concorrente osservata nella stessa sessione:
 * il tool archive_document non indicava a Ladia quali valori di `category`
 * sono validi per worker_documents, e senza quell'informazione l'IA ha
 * scritto tutti i 9 documenti con doc_type="altro" invece di
 * "idoneita_medica" — questo test verifica solo la sincronizzazione
 * (deterministica, non dipende dal modello); la correzione della
 * descrizione del tool in routes/v1/chat.js non è testabile qui.
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
  const storagePath = `${companyId}/chat-uploads/test-f105-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test idoneita'), { contentType: 'application/pdf' });
  if (upErr) throw new Error('upload storage: ' + upErr.message);
  const { data: row, error: insErr } = await supabase.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: filename, mime_type: 'application/pdf',
    storage_path: storagePath, size_bytes: 32,
  }).select('id').single();
  if (insErr) throw new Error('insert chat_uploads: ' + insErr.message);
  return row.id;
}

async function main() {
  console.log('\nPalladia — F-105: idoneità/formazione archiviate via chat non sincronizzavano lo stato lavoratore (regressione)\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-F105-WorkerDocSync-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: companyId, full_name: 'TEST F105 Worker', fiscal_code: `TSTF105${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: `TSTF105-${Date.now()}`, is_active: true,
  }).select().single();
  check('Creato lavoratore temporaneo', !workerErr && worker, workerErr);
  if (!worker) { await supabase.from('companies').delete().eq('id', companyId); console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const workerId = worker.id;

  // chat_uploads.user_id è NOT NULL — serve un utente reale. Riusa l'utente CI
  // condiviso (vedi feedback_listusers_pagination_default_50: perPage esplicito,
  // altrimenti l'utente può cadere oltre la prima pagina in un ambiente con molti utenti).
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

  try {
    // ── Caso 1: idoneità medica → health_fitness_expiry deve aggiornarsi ────
    const uploadId1 = await uploadChatFile(companyId, userId, 'idoneita.pdf');
    const res1 = await archiveChatUpload({
      uploadId: uploadId1, companyId, userId,
      destination: 'worker_documents', name: 'Idoneità medica — TEST F105 Worker',
      workerId, category: 'idoneita_medica', expiryDate: '2027-07-30',
    });
    check('archiveChatUpload (idoneita_medica) → success', res1.success === true, res1);

    const { data: docRow1 } = await supabase.from('worker_documents').select('doc_type, expiry_date').eq('id', res1.doc_id).maybeSingle();
    check('Documento archiviato con doc_type=idoneita_medica (non "altro")', docRow1?.doc_type === 'idoneita_medica', docRow1);

    const { data: workerAfter1 } = await supabase.from('workers').select('health_fitness_expiry, safety_training_expiry').eq('id', workerId).maybeSingle();
    check('FIX F-105: health_fitness_expiry sincronizzato dopo archiviazione via chat (prima restava sempre null/vecchio)', workerAfter1?.health_fitness_expiry === '2027-07-30', workerAfter1);
    check('safety_training_expiry non toccato da un documento idoneità', workerAfter1?.safety_training_expiry == null, workerAfter1);

    // ── Caso 2: una seconda idoneità con scadenza PIÙ VECCHIA → resta il MAX ──
    const uploadId2 = await uploadChatFile(companyId, userId, 'idoneita-vecchia.pdf');
    const res2 = await archiveChatUpload({
      uploadId: uploadId2, companyId, userId,
      destination: 'worker_documents', name: 'Idoneità medica vecchia — TEST F105 Worker',
      workerId, category: 'idoneita_medica', expiryDate: '2025-01-01',
    });
    check('secondo documento (scadenza più vecchia) → success', res2.success === true, res2);
    const { data: workerAfter2 } = await supabase.from('workers').select('health_fitness_expiry').eq('id', workerId).maybeSingle();
    check('health_fitness_expiry resta il MAX tra i documenti (2027-07-30), non l\'ultimo caricato', workerAfter2?.health_fitness_expiry === '2027-07-30', workerAfter2);

    // ── Caso 3: formazione_sicurezza → safety_training_expiry deve aggiornarsi ──
    const uploadId3 = await uploadChatFile(companyId, userId, 'formazione.pdf');
    const res3 = await archiveChatUpload({
      uploadId: uploadId3, companyId, userId,
      destination: 'worker_documents', name: 'Formazione sicurezza — TEST F105 Worker',
      workerId, category: 'formazione_sicurezza', expiryDate: '2028-03-15',
    });
    check('archiveChatUpload (formazione_sicurezza) → success', res3.success === true, res3);
    const { data: workerAfter3 } = await supabase.from('workers').select('health_fitness_expiry, safety_training_expiry').eq('id', workerId).maybeSingle();
    check('safety_training_expiry sincronizzato per il tipo formazione', workerAfter3?.safety_training_expiry === '2028-03-15', workerAfter3);
    check('health_fitness_expiry invariato (2027-07-30) da un documento formazione', workerAfter3?.health_fitness_expiry === '2027-07-30', workerAfter3);

    // ── Caso 4: categoria non rilevante (patente_guida) → nessuna sincronizzazione spuria ──
    const uploadId4 = await uploadChatFile(companyId, userId, 'patente.pdf');
    const res4 = await archiveChatUpload({
      uploadId: uploadId4, companyId, userId,
      destination: 'worker_documents', name: 'Patente — TEST F105 Worker',
      workerId, category: 'patente_guida', expiryDate: '2030-01-01',
    });
    check('archiveChatUpload (patente_guida) → success', res4.success === true, res4);
    const { data: workerAfter4 } = await supabase.from('workers').select('health_fitness_expiry, safety_training_expiry').eq('id', workerId).maybeSingle();
    check('un documento non-idoneità/non-formazione non tocca nessuno dei due campi', workerAfter4?.health_fitness_expiry === '2027-07-30' && workerAfter4?.safety_training_expiry === '2028-03-15', workerAfter4);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su workers/worker_documents
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
