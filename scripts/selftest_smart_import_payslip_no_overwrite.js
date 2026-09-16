#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_smart_import_payslip_no_overwrite.js
 *
 * Regressione per F-203 (AUDIT.md): un PDF di buste paga multi-pagina può
 * essere spacchettato dall'IA in PIÙ segmenti per lo STESSO lavoratore e
 * periodo — visto dal vivo su un import reale (busta paga di 3 pagine
 * divisa in due segmenti, entrambi abbinati per CODICE FISCALE allo stesso
 * lavoratore). confirmItem() confermava entrambi senza controllo: il
 * secondo sovrascriveva silenziosamente il primo in payslips (upsert su
 * company_id+worker_id+period_year+period_month, condiviso con l'upload
 * manuale di routes/v1/payslips.js) — sia la riga DB sia il file in storage
 * (stesso path deterministico), pagine perse senza errore né traccia.
 *
 * Non richiama classifySegments/extractFields (chiamate Claude reali) —
 * costruisce direttamente lo stato di due import_items come li lascerebbe
 * processOneItem dopo classificazione + matchWorker per CF, stesso pattern
 * di selftest_smart_import_identity_review_gate.js (F-186).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { confirmItem } = require('../services/smartImportPipeline');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'site-documents';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — un secondo segmento della stessa busta paga non sovrascrive più il primo silenziosamente (F-203)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('smart import payslip no-overwrite', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  let companyId = null, workerId = null;
  const storagePaths = [];

  try {
    const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F203-PayslipNoOverwrite' }]).select('id').single();
    companyId = company.id;
    const { data: companyUser } = await admin.from('company_users').select('user_id').limit(1).maybeSingle();
    const userId = companyUser?.user_id;
    if (!userId) { skip('smart import payslip no-overwrite', 'nessun company_users disponibile per fixture user_id'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

    const { data: worker } = await admin.from('workers').insert([{
      company_id: companyId, full_name: 'Elton Test', fiscal_code: `LKITST${Date.now()}`.slice(0, 16).toUpperCase(),
      is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
    }]).select('id').single();
    workerId = worker.id;

    const { data: batch } = await admin.from('import_batches').insert({
      company_id: companyId, user_id: userId, source: 'zip', status: 'review', total_files: 2,
    }).select('id').single();

    async function makeSegmentItem(label) {
      const storagePath = `${companyId}/chat-uploads/test-f203-${crypto.randomUUID()}.pdf`;
      await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
      storagePaths.push(storagePath);
      const { data: upload } = await admin.from('chat_uploads').insert({
        company_id: companyId, user_id: userId, original_name: `cedolino (${label}).pdf`, mime_type: 'application/pdf',
        storage_path: storagePath, size_bytes: 20, import_batch_id: batch.id,
      }).select('id').single();
      const { data: item, error } = await admin.from('import_items').insert({
        batch_id: batch.id, chat_upload_id: upload.id, original_name: `cedolino (${label}).pdf`,
        doc_type: 'busta_paga', destination: 'payslips',
        extracted_fields: {
          issued_to:    { value: 'Elton Test', confidence: 1 },
          period_year:  { value: 2026, confidence: 1 },
          period_month: { value: 8,    confidence: 1 },
        },
        overall_confidence: 1, status: 'pending_review',
        matched_worker_id: workerId, worker_match_score: 100, worker_matched_by: 'cf',
      }).select('id').single();
      if (error) throw error;
      return item.id;
    }

    // Due segmenti dello STESSO PDF multi-pagina, per errore di split dell'IA
    // entrambi abbinati per CF allo stesso lavoratore/periodo — esattamente
    // il caso reale (busta paga di 3 pagine spezzata pag.9-10 + pag.11-11).
    const firstSegmentId  = await makeSegmentItem('pag. 9-10');
    const secondSegmentId = await makeSegmentItem('pag. 11-11');

    const r1 = await confirmItem(firstSegmentId, companyId, userId, null);
    check('primo segmento si conferma normalmente', r1?.success === true, r1);

    const { data: rowAfterFirst } = await admin.from('payslips')
      .select('id, filename').eq('company_id', companyId).eq('worker_id', workerId)
      .eq('period_year', 2026).eq('period_month', 8).maybeSingle();
    check('riga payslips creata dal primo segmento', rowAfterFirst?.filename === 'cedolino (pag. 9-10).pdf', rowAfterFirst);

    const r2 = await confirmItem(secondSegmentId, companyId, userId, null).catch(e => ({ error: e.message }));
    check('secondo segmento (stesso lavoratore+periodo) viene RIFIUTATO, non sovrascrive silenziosamente',
      typeof r2?.error === 'string' && /esiste già|conflitto|split/i.test(r2.error), r2);

    const { data: rowAfterSecond } = await admin.from('payslips')
      .select('id, filename').eq('company_id', companyId).eq('worker_id', workerId)
      .eq('period_year', 2026).eq('period_month', 8).maybeSingle();
    check('la riga in payslips resta quella del PRIMO segmento (nessuna sovrascrittura silenziosa)',
      rowAfterSecond?.filename === 'cedolino (pag. 9-10).pdf', rowAfterSecond);

    const { data: allRows } = await admin.from('payslips')
      .select('id').eq('company_id', companyId).eq('worker_id', workerId).eq('period_year', 2026).eq('period_month', 8);
    check('resta UNA sola riga (nessun duplicato creato dal tentativo fallito)', (allRows || []).length === 1, allRows);

    const { data: secondItemRow } = await admin.from('import_items').select('status').eq('id', secondSegmentId).single();
    check('il secondo segmento resta "pending_review" nel DB, visibile per la revisione umana',
      secondItemRow?.status === 'pending_review', secondItemRow);
  } finally {
    for (const p of storagePaths) await admin.storage.from(BUCKET).remove([p]).catch(() => {});
    if (workerId) await admin.from('payslips').delete().eq('worker_id', workerId);
    if (workerId) await admin.from('import_items').delete().in('chat_upload_id',
      (await admin.from('chat_uploads').select('id').eq('company_id', companyId)).data?.map(r => r.id) || []);
    if (companyId) await admin.from('chat_uploads').delete().eq('company_id', companyId);
    if (companyId) await admin.from('import_batches').delete().eq('company_id', companyId);
    if (workerId) await admin.from('workers').delete().eq('id', workerId);
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
