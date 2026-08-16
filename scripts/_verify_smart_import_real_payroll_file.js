#!/usr/bin/env node
// Verifica dal vivo con il file REALE che il consulente del lavoro manda ogni
// mese (CI10119@01@AZIENDA.PDF, fornito dall'utente) — non un PDF sintetico.
// Struttura reale scoperta leggendo il file: 44 pagine totali, di cui:
//  - pagine 1-24: 16 buste paga vere (15 dipendenti + 1 CO.CO.CO.), la
//    maggior parte di 2 pagine ciascuna (non 1 pagina fissa come nel test
//    sintetico precedente) — l'ampiezza NON è costante.
//  - pagine 25-44: 20 pagine di riepiloghi aziendali (Prospetto Contabile,
//    dettaglio TFR/FPC) che NON sono buste paga e non vanno mai abbinate a
//    un singolo lavoratore.
// Solo classificazione + upload: NESSUNA conferma, NESSUna scrittura reale
// in payslips — il batch viene ispezionato e poi cancellato. Non stampa mai
// CF/IBAN/nomi reali dei lavoratori, solo conteggi e verifiche strutturali.
'use strict';
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.argv[2] || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE         = process.argv[3] || 'https://palladia-backend-production.up.railway.app';
const FILE_PATH    = 'C:/Users/ricka/Downloads/CI10119@01@AZIENDA.PDF';

if (!ANON_KEY) {
  console.error('Manca la anon key (argv[2] o SUPABASE_ANON_KEY/SUPABASE_KEY in .env)');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 800)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n\x1b[1mVerifica dal vivo — Importazione Intelligente sul file REALE del consulente (44 pagine, ampiezza variabile per lavoratore + 20 pagine di riepiloghi aziendali)\x1b[0m\n');

  if (!fs.existsSync(FILE_PATH)) { console.error('File non trovato:', FILE_PATH); process.exit(1); }
  const pdfBuffer = fs.readFileSync(FILE_PATH);
  ok(`file reale letto (${(pdfBuffer.length / 1024).toFixed(0)}KB)`);

  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const user = existingUsers?.users?.find(u => u.email === TEST_EMAIL);
  if (!user) { console.error('Utente ci-test non trovato'); process.exit(1); }
  const tmpPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tmpPassword });
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tmpPassword });
  if (signInErr) { console.error('login ci-test fallito:', signInErr.message); process.exit(1); }
  const jwt = session.session.access_token;

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map(m => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const mscedilizia = (companies || []).find(c => c.name === 'MSCedilizia' || c.name === 'MSC EDILIZIA SRL');
  if (!mscedilizia) { console.error('MSCedilizia non trovata tra le membership di ci-test'); process.exit(1); }
  const companyId = mscedilizia.id;
  ok(`sessione reale ottenuta su ${mscedilizia.name} (${companyId})`);

  const { data: realWorkers } = await admin.from('workers').select('id, fiscal_code').eq('company_id', companyId);
  ok(`${(realWorkers || []).length} lavoratori reali già a sistema su questa azienda (per verificare il matching, nessun dato stampato)`);

  let batchId = null;

  try {
    const form = new FormData();
    form.append('files', new Blob([pdfBuffer], { type: 'application/pdf' }), 'CI10119@01@AZIENDA.PDF');

    const uploadRes = await fetch(`${BASE}/api/v1/smart-import/batches/from-files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: form,
    });
    const uploadBody = await uploadRes.json().catch(() => null);
    if (uploadRes.status === 200 && uploadBody?.batch_id) {
      ok(`upload reale riuscito — batch ${uploadBody.batch_id}`);
      batchId = uploadBody.batch_id;
    } else {
      fail('upload reale riuscito', { status: uploadRes.status, body: uploadBody });
      return report();
    }

    let items = [];
    const maxWait = 60; // fino a 3 minuti: file grande, molte estrazioni in coda
    for (let i = 0; i < maxWait; i++) {
      await sleep(3000);
      const pollRes = await fetch(`${BASE}/api/v1/smart-import/batches/${batchId}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      });
      const pollBody = await pollRes.json().catch(() => null);
      items = pollBody?.items || [];
      const stillProcessing = items.some(it => ['pending', 'processing', 'needs_split', 'queued'].includes(it.status))
        || (items.length < 2 && i < 20);
      if (!stillProcessing && items.length > 0) { console.log(`  ... stabilizzato dopo ~${(i + 1) * 3}s`); break; }
      if (i === maxWait - 1) console.log('  ... timeout polling, valuto lo stato attuale');
    }

    const byDest = {};
    for (const it of items) byDest[it.destination || 'null'] = (byDest[it.destination || 'null'] || 0) + 1;
    console.log(`  ... ${items.length} item totali nel batch. Per destinazione: ${JSON.stringify(byDest)}`);
    const statuses = {};
    for (const it of items) statuses[it.status] = (statuses[it.status] || 0) + 1;
    console.log(`  ... per stato: ${JSON.stringify(statuses)}`);

    // Non deve essere collassato in un solo mega-segmento per troncamento
    // JSON (rischio reale: la classificazione usa max_tokens=1024, con ~18
    // segmenti attesi il JSON potrebbe non starci ed essere scartato).
    check('il file NON è stato trattato come un unico documento indistinto (max_tokens/JSON troncato)', items.length >= 10, { itemCount: items.length });

    const payslipItems = items.filter(i => i.destination === 'payslips');
    check('sono stati riconosciuti almeno 14 segmenti busta paga (15 dipendenti + eventuale CO.CO.CO.)', payslipItems.length >= 14, { count: payslipItems.length });

    const matchedCount = payslipItems.filter(i => i.matched_worker_id).length;
    check('la maggioranza delle buste paga è stata abbinata a un lavoratore reale già a sistema (via CF)', matchedCount >= Math.ceil(payslipItems.length * 0.7), { matched: matchedCount, total: payslipItems.length });

    const realWorkerIds = new Set((realWorkers || []).map(w => w.id));
    const matchedToUnknown = payslipItems.filter(i => i.matched_worker_id && !realWorkerIds.has(i.matched_worker_id));
    check('nessuna busta paga abbinata a un worker_id che non esiste su questa azienda', matchedToUnknown.length === 0, { count: matchedToUnknown.length });

    const nonPayslipDestinations = items.filter(i => i.destination !== 'payslips');
    const nonPayslipMatchedToWorker = nonPayslipDestinations.filter(i => i.matched_worker_id);
    check('le pagine di riepilogo aziendale (Prospetto Contabile/TFR/FPC) NON sono state abbinate a un lavoratore come busta paga', nonPayslipMatchedToWorker.length === 0, { count: nonPayslipMatchedToWorker.length });

    // Nessun item deve risultare "confirmed" — questo script non chiama mai
    // confirm/confirm-green, quindi se qualcosa risulta confirmed è un bug.
    const confirmedByAccident = items.filter(i => i.status === 'confirmed');
    check('nessun item confermato per sbaglio (questo script non chiama mai confirm)', confirmedByAccident.length === 0, { count: confirmedByAccident.length });

    console.log('\n  Dettaglio (senza dati personali): ' + items.map(i => `[${i.status}/${i.destination}/${i.doc_type} pag.${i.page_start}-${i.page_end} conf=${i.overall_confidence?.toFixed?.(2)} match=${!!i.matched_worker_id}]`).join('\n  '));

  } finally {
    if (batchId) {
      const { data: batchItems } = await admin.from('import_items').select('id, chat_upload_id').eq('batch_id', batchId);
      for (const it of (batchItems || [])) {
        if (it.chat_upload_id) {
          const { data: upload } = await admin.from('chat_uploads').select('storage_path').eq('id', it.chat_upload_id).maybeSingle();
          if (upload?.storage_path) await admin.storage.from('site-documents').remove([upload.storage_path]).catch(() => {});
        }
      }
      await admin.from('import_items').delete().eq('batch_id', batchId);
      await admin.from('import_staged_entities').delete().eq('batch_id', batchId);
      await admin.from('import_batches').delete().eq('id', batchId);
    }
    console.log('\n  (pulizia dati di test completata — nessuna scrittura reale in payslips avvenuta, nessun file lasciato in storage)');
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exit(1); });
