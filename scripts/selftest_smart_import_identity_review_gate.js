#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_smart_import_identity_review_gate.js
 *
 * Regressione per F-186 (AUDIT.md, 2026-09-14): il titolare, prima di
 * caricare le buste paga reali dei lavoratori, ha chiesto esplicitamente
 * garanzie contro un abbinamento sbagliato ("non possiamo rischiare di
 * caricare file... di altri lavoratori").
 *
 * Causa reale trovata nel codice: `overall_confidence` (usata da "Conferma
 * tutti i verdi", soglia 0.85) misura SOLO quanto è leggibile il testo
 * estratto — non quanto è affidabile l'abbinamento al lavoratore. Un
 * documento può essere letto perfettamente ma abbinato per NOME in modo
 * fuzzy (lib/entityMatch.js, soglia 55/100 — o persino 100/100 se il nome
 * scritto coincide con un altro candidato, indistinguibile da un vero match
 * CF senza tracciare esplicitamente COME si è arrivati al match) a un
 * lavoratore diverso da quello vero.
 *
 * Fix: nuovo campo `worker_matched_by` ('cf'|'name') su import_items.
 * confirmAllGreen() ora esclude SEMPRE un documento worker-scoped
 * (payslips/worker_documents/worker_certificates) il cui abbinamento non è
 * un match esatto sul codice fiscale — resta in pending_review per revisione
 * visiva, MAI confermato in blocco.
 *
 * Non richiama classifySegments/extractFields (chiamate Claude reali) —
 * costruisce direttamente lo stato di un import_item come lo lascerebbe
 * processOneItem dopo classificazione + matchWorker, stesso pattern di
 * selftest_smart_import_equipment_documents.js (F-096).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { confirmAllGreen, confirmItem } = require('../services/smartImportPipeline');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — "Conferma tutti i verdi" non abbina mai un documento delicato solo per nome (F-186)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('smart import identity review gate', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F186-SmartImportIdentity' }]).select('id').single();
  const { data: companyUser } = await admin.from('company_users').select('user_id').limit(1).maybeSingle();
  // Un company_users di un'altra company va bene solo come user_id fittizio
  // per popolare uploaded_by/user_id — nessuna delle verifiche qui dipende
  // dall'identità dell'utente, solo dal comportamento di confirmAllGreen.
  const userId = companyUser?.user_id;
  if (!userId) { skip('smart import identity review gate', 'nessun company_users disponibile per fixture user_id'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

  const { data: workerReal } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'Mario Rossi', fiscal_code: `RSSMRA${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Muratore', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();
  const { data: workerDifferent } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'Mario Rossi', fiscal_code: `RSSMRB${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Elettricista', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const { data: batch } = await admin.from('import_batches').insert({
    company_id: company.id, user_id: userId, source: 'zip', status: 'review', total_files: 4,
  }).select('id').single();

  async function makeItem({ destination, matchedWorkerId, matchedBy, score, confidence }) {
    const storagePath = `${company.id}/chat-uploads/test-f186-${crypto.randomUUID()}.pdf`;
    await admin.storage.from('site-documents').upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
    const { data: upload } = await admin.from('chat_uploads').insert({
      company_id: company.id, user_id: userId, original_name: 'documento_test.pdf', mime_type: 'application/pdf',
      storage_path: storagePath, size_bytes: 20, import_batch_id: batch.id,
    }).select('id').single();
    const { data: item, error } = await admin.from('import_items').insert({
      batch_id: batch.id, chat_upload_id: upload.id, original_name: 'documento_test.pdf',
      doc_type: destination === 'payslips' ? 'busta_paga' : 'idoneita_medica', destination,
      extracted_fields: {
        issued_to: { value: 'Mario Rossi', confidence },
        ...(destination === 'payslips' ? {
          period_year:  { value: 2026, confidence },
          period_month: { value: 6,    confidence },
        } : {}),
      },
      overall_confidence: confidence, status: 'pending_review',
      matched_worker_id: matchedWorkerId, worker_match_score: score, worker_matched_by: matchedBy,
    }).select('id').single();
    if (error) throw error;
    return item.id;
  }

  // ── 4 documenti "verdi" (confidence > 0.85), diversi tipi di abbinamento ──
  const payslipByCf   = await makeItem({ destination: 'payslips', matchedWorkerId: workerReal.id, matchedBy: 'cf', score: 100, confidence: 0.95 });
  const payslipByName = await makeItem({ destination: 'payslips', matchedWorkerId: workerDifferent.id, matchedBy: 'name', score: 100, confidence: 0.95 });
  const certByName    = await makeItem({ destination: 'worker_certificates', matchedWorkerId: workerDifferent.id, matchedBy: 'name', score: 100, confidence: 0.95 });
  const siteDocGreen  = await makeItem({ destination: 'company_documents', matchedWorkerId: null, matchedBy: null, score: null, confidence: 0.95 });

  const result = await confirmAllGreen(batch.id, company.id, userId, null);

  check('busta paga abbinata per CODICE FISCALE → confermata da "Conferma tutti i verdi"',
    result.confirmed.includes(payslipByCf), result);
  check('busta paga abbinata per NOME (non CF) → NON confermata, lasciata in revisione',
    !result.confirmed.includes(payslipByName) && result.skippedIdentityReview.includes(payslipByName), result);
  check('certificato abbinato per NOME (non CF) → stesso blocco, non solo per le buste paga',
    !result.confirmed.includes(certByName) && result.skippedIdentityReview.includes(certByName), result);
  check('documento aziendale (non legato a un lavoratore) → confermato normalmente, nessuna regressione',
    result.confirmed.includes(siteDocGreen), result);

  const { data: skippedRow } = await admin.from('import_items').select('status').eq('id', payslipByName).single();
  check('la busta paga saltata resta davvero "pending_review" nel DB, non un limbo silenzioso',
    skippedRow?.status === 'pending_review', skippedRow);

  // ── La conferma SINGOLA (dopo revisione umana) deve restare possibile —
  //    il gate riguarda solo la conferma IN BLOCCO, non la capacità di un
  //    admin di confermare consapevolmente un match per nome corretto ──
  const manual = await confirmItem(payslipByName, company.id, userId, null).catch(e => ({ error: e.message }));
  check('la conferma SINGOLA manuale del documento abbinato per nome funziona ancora (nessun blocco assoluto, solo fuori dal blocco automatico)',
    !manual?.error, manual);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
