#!/usr/bin/env node
/**
 * scripts/selftest_scan_exit_reason.js — F-265 (AUDIT.md del frontend).
 *
 * "Perché esci?" dopo l'uscita: POST /api/v1/scan/exit-reason, montata qui su
 * un server locale, contro il DB vero (azienda di prova).
 *  - la pausa si registra sull'uscita appena fatta; doppio tocco senza doppioni;
 *  - INVARIANTE: le ore del giorno sono identiche prima e dopo il motivo;
 *  - niente motivo se l'ultima timbratura è un'entrata, se l'uscita è vecchia
 *    o di un altro cantiere; sessione non valida rifiutata; motivi ammessi.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F265R-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-265 — perché esci? dopo l\'uscita\x1b[0m');
  const app = express(); app.use(express.json()); app.set('trust proxy', true);
  app.use('/api/v1', require('../routes/v1/scanExitReason'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (body) => { const r = await fetch(`${base}/scan/exit-reason`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-A`, address: 'Via 1', status: 'attivo' });
    const site2 = await ins('sites', { company_id: company.id, name: `${T}-B`, address: 'Via 2', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Op`, is_active: true, fiscal_code: `F265RRRR${stamp}`, badge_code: `F265R${stamp}` });
    const token = crypto.randomBytes(32).toString('hex');
    await ins('worker_device_sessions', { company_id: company.id, worker_id: w.id, token_hash: crypto.createHash('sha256').update(token).digest('hex') });
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const log = (type, ts, s = site) => ins('presence_logs', { company_id: company.id, site_id: s.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });

    check('sessione non valida: 401', (await post({ worksite_id: site.id, session_token: 'x'.repeat(64), reason: 'pausa' })).status === 401);
    check('motivo non ammesso (fine giornata non si registra): 400', (await post({ worksite_id: site.id, session_token: token, reason: 'fine' })).status === 400);

    await log('ENTRY', ago(240));
    check('ultima timbratura = entrata: 409, niente motivo', (await post({ worksite_id: site.id, session_token: token, reason: 'pausa' })).body.error === 'NO_RECENT_EXIT');

    const exit = await log('EXIT', ago(5));
    const today = new Date().toISOString().slice(0, 10);
    const before = await buildWorkerHoursReport(null, company.id, today, today, null, true);
    const r1 = await post({ worksite_id: site.id, session_token: token, reason: 'pausa' });
    check('pausa registrata sull\'uscita appena fatta', r1.status === 200 && r1.body.presence_log_id === exit.id, r1);
    const { data: tags } = await supabase.from('presence_log_reasons').select('reason').eq('presence_log_id', exit.id);
    check('nel DB: un motivo "pausa"', tags?.length === 1 && tags[0].reason === 'pausa', tags);
    const r2 = await post({ worksite_id: site.id, session_token: token, reason: 'pausa' });
    const { count } = await supabase.from('presence_log_reasons').select('id', { count: 'exact', head: true }).eq('presence_log_id', exit.id);
    check('doppio tocco: nessun doppione', r2.status === 200 && r2.body.unchanged === true && count === 1, { r2, count });
    const after = await buildWorkerHoursReport(null, company.id, today, today, null, true);
    const mins = (rep) => rep.workers.find(x => x.id === w.id)?.total_minutes;
    check('INVARIANTE: ore del giorno identiche prima e dopo il motivo', mins(before) === mins(after) && mins(before) > 0, { prima: mins(before), dopo: mins(after) });
    check('uscita di un altro cantiere: 409', (await post({ worksite_id: site2.id, session_token: token, reason: 'maltempo' })).body.error === 'NO_RECENT_EXIT');

    await log('ENTRY', ago(4));
    await log('EXIT', ago(45));
    // L'ultima per orario resta l'entrata di 4 minuti fa: rientrato, niente motivo
    check('rientrato dalla pausa: 409', (await post({ worksite_id: site.id, session_token: token, reason: 'maltempo' })).status === 409);
  } finally {
    server.close();
    await supabase.from('worker_device_sessions').delete().eq('company_id', company.id);
    const { data: logs } = await supabase.from('presence_logs').select('id').eq('company_id', company.id);
    if (logs?.length) await supabase.from('presence_log_reasons').delete().in('presence_log_id', logs.map(l => l.id));
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
