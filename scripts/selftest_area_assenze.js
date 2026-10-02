#!/usr/bin/env node
/**
 * scripts/selftest_area_assenze.js — F-265 (AUDIT.md del frontend).
 *
 * Richiesta ferie/permesso dall'Area lavoratore (token PIN), contro il DB vero:
 *  - senza token 401; token di un altro badge 403;
 *  - ferie e permesso a ore creati come 'richiesta' + da_lavoratore;
 *  - malattia, giorni passati, periodi troppo lunghi rifiutati;
 *  - la richiesta compare tra le richieste del titolare (buildOreMese) ma non
 *    conta nelle celle finché non è approvata;
 *  - ritiro solo delle proprie richieste ancora in attesa;
 *  - nessuna timbratura toccata.
 */
'use strict';
require('dotenv').config();
const express = require('express');
const supabase = require('../lib/supabase');
const { signWorkerToken } = require('../lib/workerAuth');
const { buildOreMese } = require('../lib/oreMese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F265A-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const roma = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const plus = (n) => roma(new Date(Date.now() + n * 86400000));

async function main() {
  console.log('\n\x1b[1mF-265 — ferie e permessi chiesti dall\'Area lavoratore\x1b[0m');
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/workerAreaAssenze'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1/area`;

  const company = await ins('companies', { name: T });
  try {
    const wA = await ins('workers', { company_id: company.id, full_name: `${T} Anna`, is_active: true, fiscal_code: `F265AREA${stamp}`, badge_code: `F265AA${stamp}` });
    const wB = await ins('workers', { company_id: company.id, full_name: `${T} Bruno`, is_active: true, fiscal_code: `F265AREB${stamp}`, badge_code: `F265AB${stamp}` });
    const tok = (w) => signWorkerToken({ workerId: w.id, companyId: company.id, badgeCode: w.badge_code });
    const call = async (w, method, path = '', body, token = tok(w)) => {
      const r = await fetch(`${base}/${w.badge_code}/assenze${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `WorkerArea ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    check('senza PIN/token: 401', (await call(wA, 'GET', '', null, '')).status === 401);
    check('token di un altro lavoratore sul mio badge: 403', (await call(wA, 'GET', '', null, tok(wB))).status === 403);

    const f = await call(wA, 'POST', '', { tipo: 'ferie', dal: plus(10), al: plus(14), note: 'Matrimonio' });
    check('ferie chieste: 201, stato richiesta', f.status === 201 && f.body.stato === 'richiesta' && f.body.date_to === plus(14), f);
    const p = await call(wA, 'POST', '', { tipo: 'permesso', dal: plus(3), dalle: '14:00', alle: '16:00' });
    check('permesso a ore chiesto', p.status === 201 && p.body.ora_dalle?.startsWith('14:00'), p);
    const { data: row } = await supabase.from('worker_absences').select('da_lavoratore, company_id, worker_id').eq('id', f.body.id).single();
    check('nel DB: da_lavoratore, azienda e lavoratore del token', row?.da_lavoratore === true && row.company_id === company.id && row.worker_id === wA.id, row);

    check('malattia non si chiede da qui (la registra l\'ufficio)', (await call(wA, 'POST', '', { tipo: 'malattia', dal: plus(1) })).status === 400);
    check('giorno passato rifiutato', (await call(wA, 'POST', '', { tipo: 'ferie', dal: plus(-2) })).body.error === 'PAST_DATE');
    check('oltre 60 giorni rifiutato', (await call(wA, 'POST', '', { tipo: 'ferie', dal: plus(1), al: plus(70) })).body.error === 'TOO_LONG');
    check('permesso con alle prima di dalle rifiutato', (await call(wA, 'POST', '', { tipo: 'permesso', dal: plus(1), dalle: '16:00', alle: '14:00' })).status === 400);
    check('non posso scegliere il lavoratore dal body', (await call(wA, 'POST', '', { tipo: 'ferie', dal: plus(20), worker_id: wB.id })).body && (await supabase.from('worker_absences').select('id', { count: 'exact', head: true }).eq('worker_id', wB.id)).count === 0);

    const mine = await call(wA, 'GET');
    check('le mie richieste: le vedo', mine.status === 200 && mine.body.some(x => x.id === f.body.id) && mine.body.some(x => x.id === p.body.id), mine.body.length);
    check('Bruno non vede quelle di Anna', (await call(wB, 'GET')).body.length === 0);

    const month = plus(10).slice(0, 7);
    const r = await buildOreMese(company.id, month, { today: roma(new Date()) });
    const A = r.lavoratori.find(l => l.id === wA.id);
    check('il titolare la vede tra le richieste da decidere', r.richieste.some(x => x.id === f.body.id), r.richieste.map(x => x.id));
    check('finché non è approvata non conta come ferie', !A || !A.cells.some(c => c.tipo === 'ferie'), A && A.cells.filter(c => c.tipo === 'ferie').map(c => c.date));

    check('Bruno non può ritirare la richiesta di Anna', (await call(wB, 'DELETE', `/${f.body.id}`)).status === 404);
    await supabase.from('worker_absences').update({ stato: 'approvata', decided_at: new Date().toISOString() }).eq('id', p.body.id);
    check('una richiesta già decisa non si ritira', (await call(wA, 'DELETE', `/${p.body.id}`)).status === 404);
    check('ritiro la mia richiesta in attesa', (await call(wA, 'DELETE', `/${f.body.id}`)).status === 200 && (await call(wA, 'GET')).body.every(x => x.id !== f.body.id));

    const { count: logs } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    check('nessuna timbratura creata o toccata', logs === 0, logs);
  } finally {
    server.close();
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
