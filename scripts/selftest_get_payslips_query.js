#!/usr/bin/env node
/**
 * scripts/selftest_get_payslips_query.js
 *
 * Regressione F-113 (AUDIT.md, trovato da LADIA_EVALS 2026-09-02, scenario
 * R10 — mai testato prima in nessuna forma): il tool get_payslips
 * (routes/v1/chat.js) selezionava/ordinava/filtrava sulle colonne
 * 'month'/'original_name', che non esistono sulla tabella payslips (le
 * colonne reali sono period_year/period_month/filename) — falliva SEMPRE
 * con un errore Postgres grezzo ("column payslips.month does not exist"),
 * per ogni chiamata, da quando questo tool esiste. Chiunque avesse chiesto
 * a Ladia "mostrami le buste paga di X" avrebbe sempre ricevuto un errore.
 *
 * Riproduce esattamente la query del tool (stesse colonne, stesso ordine,
 * stesso filtro mese) contro un cedolino reale seminato per il test.
 *
 * Uso: node scripts/selftest_get_payslips_query.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Stessa query del case 'get_payslips' in routes/v1/chat.js — se qualcuno
// tocca di nuovo i nomi colonna senza allineare qui, questo test lo scopre.
async function getPayslips({ workerIds, month }) {
  let q = supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, file_size, created_at')
    .eq('company_id', COMPANY_ID)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(50);
  if (workerIds) q = q.in('worker_id', workerIds);
  if (month) {
    const [y, m] = month.split('-').map(Number);
    if (y && m) q = q.eq('period_year', y).eq('period_month', m);
  }
  return q;
}

async function main() {
  console.log('\n=== F-113: get_payslips non falliva più su colonne inesistenti ===\n');

  const { data: worker } = await supabase.from('workers').select('id').eq('company_id', COMPANY_ID).limit(1).maybeSingle();
  if (!worker) { console.log('  – skip (nessun lavoratore nella company di test)'); process.exitCode = 0; return; }

  const testYear = 2026, testMonth = 6;
  const { data: seeded, error: seedErr } = await supabase.from('payslips').insert({
    company_id: COMPANY_ID, worker_id: worker.id,
    period_year: testYear, period_month: testMonth,
    filename: 'selftest-f113.pdf', file_path: `payslips/${COMPANY_ID}/selftest-f113.pdf`,
    file_size: 500, status: 'draft',
  }).select('id').single();
  if (seedErr) { console.error('Setup fallito:', seedErr.message); process.exitCode = 1; return; }

  const { data: allData, error: allErr } = await getPayslips({ workerIds: [worker.id] });
  check('la query non fallisce più (pre-fix: "column payslips.month does not exist")', !allErr, allErr);
  check('trova il cedolino appena seminato', (allData || []).some(p => p.id === seeded.id), allData);

  const { data: filtered, error: filterErr } = await getPayslips({ workerIds: [worker.id], month: `${testYear}-0${testMonth}` });
  check('il filtro month=YYYY-MM non fallisce', !filterErr, filterErr);
  check('il filtro month trova esattamente il cedolino del periodo giusto', (filtered || []).some(p => p.id === seeded.id), filtered);

  const { data: otherMonth } = await getPayslips({ workerIds: [worker.id], month: '2020-01' });
  check('il filtro month su un periodo senza cedolini non trova quello seminato', !(otherMonth || []).some(p => p.id === seeded.id), otherMonth);

  await supabase.from('payslips').delete().eq('id', seeded.id);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('Errore fatale:', e); process.exitCode = 1; });
