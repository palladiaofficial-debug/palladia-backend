#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_cross_site_same_day.js
 *
 * F-222 (AUDIT.md): buildWorkerHoursReport() (services/workerHoursReport.js)
 * raggruppava i log per (worker, cantiere) PRIMA di accoppiare ENTRY/EXIT,
 * presumendo che un cambio cantiere nello stesso giorno chiuda SEMPRE
 * l'ENTRY precedente con un'uscita automatica (method
 * auto_exit_on_site_change). Falso quando l'uscita è una correzione manuale
 * dell'admin su un cantiere diverso da quello dell'entrata — caso reale:
 * Festim Dervishaj, entrata a Via San Nazaro 34, uscita corretta a Via
 * Riboli 4b dopo essersi spostato senza timbrare. Risultato: l'ENTRY
 * restava orfana per sempre ("in corso") in un gruppo, l'EXIT orfana
 * scollegata nell'altro — invece di un'unica giornata lavorativa.
 *
 * Stesso identico principio di F-221 (routes/v1/sitesOverview.js) ma su un
 * consumer diverso di lib/presencePairing.js — vedi anche il fix gemello in
 * routes/v1/reports.js (export CSV) e src/pages/TimbraturaStorico.tsx
 * (frontend, palladia repo).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — Ore Lavorate: cambio cantiere nello stesso giorno senza uscita auto (F-222)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('cambio cantiere stesso giorno', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F222-CrossSite' }]).select('id').single();
  const { data: siteA } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F222-SanNazaro', address: 'Via Test A', status: 'attivo',
  }]).select('id').single();
  const { data: siteB } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F222-Riboli', address: 'Via Test B', status: 'attivo',
  }]).select('id').single();
  const { data: worker } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F222-Worker', fiscal_code: `F222${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  // Stesso scenario reale: entrata al mattino a un cantiere, spostamento nel
  // pomeriggio, mai timbrata l'uscita — l'admin corregge con un'uscita
  // registrata al cantiere dove il lavoratore si trovava davvero.
  const rows = [
    { company_id: company.id, site_id: siteA.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T07:52:00+02:00', method: 'worker_self_punch' },
    { company_id: company.id, site_id: siteB.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T17:00:00+02:00', method: 'admin_manual_correction' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('entrata a un cantiere + uscita corretta su un cantiere diverso, stesso giorno', !seedErr, seedErr);

  try {
    const report = await buildWorkerHoursReport(null, company.id, '2026-06-15', '2026-06-15', worker.id);
    const w = report.workers.find(x => x.id === worker.id);
    check('lavoratore presente nel report', !!w, report.workers);
    check('UNA sola giornata (non due: entrata orfana + uscita orfana separate)', w?.total_days === 1, w?.days?.map(d => ({ site: d.site_name, entries: d.entries.length })));

    const day = w?.days?.[0];
    check('nessuna anomalia "Uscita non registrata" (l\'ENTRY non resta orfana/"in corso")',
      !(day?.entries || []).some(e => e.anomaly === 'Uscita non registrata'), day?.entries);
    check('nessuna anomalia "Entrata non registrata" (l\'EXIT non resta orfana/scollegata)',
      !(day?.entries || []).some(e => e.anomaly === 'Entrata non registrata'), day?.entries);
    // 07:52→17:00 = 9h08m grezzi (548min); pausa pranzo automatica (60min,
    // unica coppia > soglia 6h) dedotta → 488min netti.
    check('ore totali corrette per l\'intera giornata (548min grezzi - 60min pausa pranzo = 488min netti)', day?.day_total_minutes === 488, day);
    check('il cantiere cambiato è visibile nella riga (San Nazaro → Riboli), non nascosto', day?.entries?.[0]?.site_name === 'TEST-Cantiere-F222-SanNazaro → TEST-Cantiere-F222-Riboli', day?.entries?.[0]);
    check('anomalia segnala il cambio di cantiere (composta con "Corretto manualmente", non sostituita)',
      /Cantiere cambiato/.test(day?.entries?.[0]?.anomaly || '') && /Corretto manualmente/.test(day?.entries?.[0]?.anomaly || ''), day?.entries?.[0]?.anomaly);
  } finally {
    await admin.from('presence_logs').delete().eq('worker_id', worker.id);
    await admin.from('workers').delete().eq('id', worker.id);
    await admin.from('sites').delete().in('id', [siteA.id, siteB.id]);
    await admin.from('companies').delete().eq('id', company.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
