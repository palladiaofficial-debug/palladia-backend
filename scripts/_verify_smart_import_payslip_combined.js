#!/usr/bin/env node
// Verifica dal vivo, end-to-end, contro produzione reale (Railway + Supabase +
// Anthropic reale — un'unica chiamata AI, nessun mock): un PDF UNICO con le
// buste paga di 2 lavoratori diversi (come quello che l'utente riceve ogni
// mese dal consulente) viene spezzato automaticamente da Importazione
// Intelligente e ogni pagina abbinata al lavoratore giusto via CF.
//
// Company: MSCedilizia (fixture CI reale, vedi memoria ci_test_fixtures).
// Lavoratori e batch creati per la verifica vengono ripuliti alla fine.
'use strict';
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.argv[2];
const BASE         = process.argv[3] || 'https://palladia-backend-production.up.railway.app';

if (!ANON_KEY) {
  console.error('Uso: node _verify_smart_import_payslip_combined.js <ANON_KEY> [BASE_URL]');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function buildCombinedPayslipPdf(workers) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const w of workers) {
    const page = doc.addPage([595, 842]);
    let y = 780;
    const line = (text, f = font, size = 12) => { page.drawText(text, { x: 60, y, size, font: f, color: rgb(0, 0, 0) }); y -= size + 10; };
    line('BUSTA PAGA', bold, 20);
    line(`Periodo di competenza: Luglio 2026`);
    line(`Dipendente: ${w.name}`);
    line(`Codice Fiscale: ${w.cf}`);
    line(`Qualifica: Operaio edile`);
    line(`Retribuzione lorda: € 1.850,00`);
    line(`Retribuzione netta: € 1.320,45`);
    line(`Datore di lavoro: MSCedilizia S.r.l.`);
  }
  return Buffer.from(await doc.save());
}

async function main() {
  console.log('\n\x1b[1mVerifica dal vivo — Importazione Intelligente: 1 file combinato, buste paga di 2 lavoratori\x1b[0m\n');

  // ── Sessione reale ci-test su MSCedilizia ───────────────────────────────────
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
  const mscedilizia = (companies || []).find(c => c.name === 'MSCedilizia');
  if (!mscedilizia) { console.error('MSCedilizia non trovata tra le membership di ci-test'); process.exit(1); }
  const companyId = mscedilizia.id;
  ok(`sessione reale ottenuta per ci-test su MSCedilizia (${companyId})`);

  // ── 2 lavoratori di test con CF noti ─────────────────────────────────────────
  const cfA = 'VRDLGU85M01H501Z';
  const cfB = 'BNCMRA90A41H501K';
  const { data: workerA } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-Verifica Verdi Luigi', fiscal_code: cfA,
    is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }).select('id').single();
  const { data: workerB } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-Verifica Bianchi Maria', fiscal_code: cfB,
    is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }).select('id').single();
  ok('2 lavoratori di test creati con CF noti (per verificare il matching)');

  let batchId = null;
  const storagePaths = [];

  try {
    // ── PDF unico con 2 buste paga ──────────────────────────────────────────
    const pdfBuffer = await buildCombinedPayslipPdf([
      { name: 'Verdi Luigi', cf: cfA },
      { name: 'Bianchi Maria', cf: cfB },
    ]);
    ok('PDF combinato generato (2 pagine, 2 lavoratori diversi)');

    // ── Upload reale via l'endpoint di produzione ───────────────────────────
    const form = new FormData();
    form.append('files', new Blob([pdfBuffer], { type: 'application/pdf' }), 'cedolini-luglio-2026.pdf');

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

    // ── Poll dello stato del batch finché la classificazione AI reale finisce ──
    let items = [];
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const pollRes = await fetch(`${BASE}/api/v1/smart-import/batches/${batchId}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      });
      const pollBody = await pollRes.json().catch(() => null);
      items = pollBody?.items || [];
      const stillProcessing = items.some(it => ['pending', 'processing', 'needs_split'].includes(it.status))
        || (items.length < 2 && i < 15);
      if (!stillProcessing && items.length > 0) break;
    }

    console.log(`  ... ${items.length} item nel batch dopo il polling`);

    check('il file è stato spezzato in 2 documenti distinti (uno per lavoratore)', items.length === 2, items.map(i => ({ status: i.status, destination: i.destination, doc_type: i.doc_type })));

    const payslipItems = items.filter(i => i.destination === 'payslips');
    check('entrambi i documenti classificati come destination=payslips', payslipItems.length === 2, items.map(i => i.destination));

    const matchedA = items.find(i => i.matched_worker_id === workerA.id);
    const matchedB = items.find(i => i.matched_worker_id === workerB.id);
    check('la busta paga di Verdi Luigi è abbinata al worker giusto via CF', !!matchedA, items.map(i => i.matched_worker_id));
    check('la busta paga di Bianchi Maria è abbinata al worker giusto via CF', !!matchedB, items.map(i => i.matched_worker_id));

    const allGreen = items.every(i => (i.overall_confidence || 0) >= 0.85);
    console.log(`  ... confidence: ${items.map(i => i.overall_confidence?.toFixed?.(2)).join(', ')}`);

    // ── Conferma (Conferma tutti i verdi) — scrittura reale in payslips ──────
    if (allGreen && items.every(i => i.status === 'pending_review')) {
      const confirmRes = await fetch(`${BASE}/api/v1/smart-import/batches/${batchId}/confirm-green`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      });
      const confirmBody = await confirmRes.json().catch(() => null);
      check('"Conferma tutti i verdi" riesce sui 2 item', confirmRes.status === 200, { status: confirmRes.status, body: confirmBody });
    } else {
      console.log('  \x1b[33m–\x1b[0m non tutti gli item sono "verdi pronti" — provo comunque a confermarli singolarmente');
      for (const it of items) {
        if (it.status !== 'pending_review') continue;
        const r = await fetch(`${BASE}/api/v1/smart-import/items/${it.id}/confirm`, {
          method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        console.log(`    conferma item ${it.id}: ${r.status}`);
      }
    }

    // ── Verifica finale diretta sulla tabella payslips reale ────────────────
    const { data: payslipRows } = await admin.from('payslips')
      .select('id, worker_id, status, period_year, period_month, file_path')
      .in('worker_id', [workerA.id, workerB.id]);

    check('2 righe reali create nella tabella payslips (una per lavoratore)', (payslipRows || []).length === 2, payslipRows);
    check('entrambe status=draft (mai auto-condivise col lavoratore)', (payslipRows || []).every(r => r.status === 'draft'), payslipRows);
    check('periodo estratto correttamente dall\'AI (luglio 2026)', (payslipRows || []).every(r => r.period_year === 2026 && r.period_month === 7), payslipRows);

    for (const r of (payslipRows || [])) if (r.file_path) storagePaths.push(r.file_path);

  } finally {
    // ── Pulizia ────────────────────────────────────────────────────────────
    if (workerA?.id) { await admin.from('payslips').delete().eq('worker_id', workerA.id); await admin.from('workers').delete().eq('id', workerA.id); }
    if (workerB?.id) { await admin.from('payslips').delete().eq('worker_id', workerB.id); await admin.from('workers').delete().eq('id', workerB.id); }
    for (const p of storagePaths) await admin.storage.from('site-documents').remove([p]).catch(() => {});
    if (batchId) {
      await admin.from('import_items').delete().eq('batch_id', batchId);
      await admin.from('import_staged_entities').delete().eq('batch_id', batchId);
      await admin.from('import_batches').delete().eq('id', batchId);
    }
    console.log('  (pulizia dati di test completata)');
  }

  report();
}

function check(name, cond, got) { cond ? ok(name) : fail(name, got); }
function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exit(1); });
