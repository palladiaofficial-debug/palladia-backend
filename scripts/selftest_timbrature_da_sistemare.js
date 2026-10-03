#!/usr/bin/env node
/**
 * scripts/selftest_timbrature_da_sistemare.js — mockup "Timbrature senza
 * errori" (approvato il 2026-10-03, dopo F-266/F-267).
 *
 * Contro il DB vero, azienda di prova:
 *  - orario abituale: mediana, uscite automatiche escluse, almeno 3 giorni;
 *  - domanda del pomeriggio (LATE_FIRST_ENTRY): solo al primo tocco dopo le 12
 *    di chi di solito entra la mattina; mai a un neoassunto o a chi lavora di pomeriggio;
 *  - "No, sto andando via" → caso con l'entrata proposta; conferma in un tocco
 *    → ENTRATA all'orario abituale + USCITA all'ora del tocco; mai due volte;
 *  - uscita mancante: conferma → USCITA proposta; se nel frattempo ha timbrato
 *    non si scrive niente; orario non valido rifiutato;
 *  - uscita sbagliata dopo un turno breve: l'uscita breve viene annotata e le
 *    ore del giorno tornano quelle vere;
 *  - turno breve: "È giusta" lo chiude, la conferma in un tocco non si applica;
 *  - Da fare mostra i casi con la proposta; promemoria: decisione corretta
 *    (notte, straordinario, una volta sola) — il cron vero NON viene lanciato
 *    (manderebbe notifiche a operai reali).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { usualFromLogs, romeAt, romeDay, romeMinutes } = require('../lib/usualTimes');
const { checkPunchGuard } = require('../lib/punchGuard');
const { fixRequestFromWorker, applyFixRequest, dismissFixRequest, createFixRequest } = require('../lib/presenceFix');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { buildDaFare } = require('../lib/daFare');
const { decide } = require('../services/exitReminderCron');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-TDS-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const dayMinus = (today, n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

async function main() {
  console.log('\n\x1b[1mTimbrature da sistemare — domanda del pomeriggio, promemoria, correzione in un tocco\x1b[0m');
  const now = new Date();
  const today = romeDay(now);
  const nowMin = romeMinutes(now);

  // ── Orario abituale (calcolo puro) ──
  const mk = (d, hm, type, method = 'worker_self_punch') => ({ event_type: type, method, timestamp_server: romeAt(d, +hm.slice(0, 2) * 60 + +hm.slice(3)) });
  const logsU = [];
  for (const [i, e, x] of [[1, '07:30', '17:00'], [2, '07:40', '17:10'], [3, '07:20', '16:50'], [4, '07:35', '17:05']]) {
    logsU.push(mk(dayMinus(today, i), e, 'ENTRY'), mk(dayMinus(today, i), x, 'EXIT'));
  }
  logsU.push(mk(dayMinus(today, 5), '07:30', 'ENTRY'), mk(dayMinus(today, 5), '19:00', 'EXIT', 'ladia_action'));
  const u = usualFromLogs(logsU, { beforeDay: today });
  check('orario abituale: entrata mediana 07:30, uscita mediana 17:03 (uscita automatica esclusa, il giorno conta per l\'entrata)', u.entryMin === 450 && u.exitMin === 1023, u);
  check('con meno di 3 giorni nessun orario abituale', usualFromLogs(logsU.slice(0, 4), { beforeDay: today }).entryMin === null);

  const company = await ins('companies', { name: T });
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/badgePunch'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via 1', status: 'attivo' });
    let n = 0;
    const worker = async (label) => { n++; return ins('workers', { company_id: company.id, full_name: `${T} ${label}`, is_active: true, fiscal_code: `TDS${Date.now()}${n}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() }); };
    const log = (w, type, ts, method = 'worker_self_punch') => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method });
    const history = async (w, entry, exit, days = 4) => { for (let i = 1; i <= days; i++) { const d = dayMinus(today, i); await log(w, 'ENTRY', romeAt(d, entry)); await log(w, 'EXIT', romeAt(d, exit)); } };
    const at = (min) => new Date(romeAt(today, min));

    // ── Domanda del pomeriggio ──
    const mattina = await worker('Mattina');
    await history(mattina, 450, 1020);
    const g1 = await checkPunchGuard({ workerId: mattina.id, companyId: company.id, now: at(16 * 60 + 58) });
    check('primo tocco alle 16:58 di chi entra alle 07:30: domanda LATE_FIRST_ENTRY', g1?.reason === 'LATE_FIRST_ENTRY', g1);
    check('…alle 10:00 nessuna domanda', await checkPunchGuard({ workerId: mattina.id, companyId: company.id, now: at(600) }) === null);
    const pome = await worker('Pomeriggio');
    await history(pome, 14 * 60, 22 * 60);
    check('chi lavora di pomeriggio (entra alle 14): nessuna domanda', await checkPunchGuard({ workerId: pome.id, companyId: company.id, now: at(14 * 60 + 5) }) === null);
    const giaEntrato = await worker('GiaEntrato');
    await log(giaEntrato, 'ENTRY', at(Math.max(0, nowMin - 30)).toISOString());
    check('"ho dimenticato l\'entrata" quando oggi ha già timbrato: nessun caso', (await fixRequestFromWorker({ worker: giaEntrato, siteId: site.id, reason: 'FORGOT_ENTRY' })) === false);
    const nuovo = await worker('Nuovo');
    check('neoassunto senza storico: nessuna domanda', await checkPunchGuard({ workerId: nuovo.id, companyId: company.id, now: at(16 * 60) }) === null);

    // ── "No, sto andando via" (entrata dimenticata) → caso + conferma in un tocco ──
    if (nowMin >= 120) {
      const dim = await worker('Dimenticato');
      const entryMin = Math.max(0, nowMin - 120);
      await history(dim, entryMin, Math.min(nowMin + 60, 1439));
      const h = await fetch(`${base}/badge/${dim.badge_code}/help-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: site.id, reason: 'FORGOT_ENTRY' }) });
      const { data: fr } = await supabase.from('presence_fix_requests').select('*').eq('worker_id', dim.id).eq('kind', 'forgot_entry').maybeSingle();
      check('"No, sto andando via": caso "entrata dimenticata" con l\'entrata all\'orario abituale', h.status === 200 && fr && romeMinutes(fr.proposed_at) === entryMin, fr);
      const { count: notif } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
      check('…nessun avviso generico in più (il caso è già in Da fare)', notif === 0, notif);
      const df = await buildDaFare(company.id, null);
      const item = df.items.find(i => i.fixId === fr?.id);
      check('Da fare: "entrata dimenticata" con la proposta pronta', item?.kind === 'timbratura' && /entrata dimenticata/.test(item.title) && /→/.test(item.fixAction?.label || ''), item);
      const a1 = await applyFixRequest({ id: fr.id, companyId: company.id, userId: null, userRole: 'owner' });
      const { data: written } = await supabase.from('presence_logs').select('event_type, timestamp_server, method').eq('worker_id', dim.id).gte('timestamp_server', romeAt(today, 0)).order('timestamp_server');
      check('confermata: ENTRATA all\'orario abituale + USCITA all\'ora del tocco', a1.ok && written.length === 2 && written[0].event_type === 'ENTRY' && romeMinutes(written[0].timestamp_server) === entryMin && written[1].event_type === 'EXIT' && written.every(w => w.method === 'admin_manual_correction'), { a1, written });
      const a2 = await applyFixRequest({ id: fr.id, companyId: company.id, userId: null, userRole: 'owner' });
      check('doppio tocco del titolare: non scrive due volte', a2.code === 'ALREADY_DONE', a2);
    } else console.log('  (salto entrata dimenticata: troppo presto nella notte)');

    // ── Uscita mancante ──
    if (nowMin >= 120) {
      const aperto = await worker('Aperto');
      const e = await log(aperto, 'ENTRY', at(nowMin - 100).toISOString());
      await createFixRequest({ company_id: company.id, worker_id: aperto.id, site_id: site.id, kind: 'missing_exit', day: today, entry_log_id: e.id, entry_at: e.timestamp_server, proposed_at: at(nowMin - 10).toISOString() });
      const { data: fr } = await supabase.from('presence_fix_requests').select('id').eq('worker_id', aperto.id).single();
      const bad = await applyFixRequest({ id: fr.id, companyId: company.id, userId: null, userRole: 'owner', at: '25:00' });
      check('orario non valido rifiutato', bad.code === 'INVALID_TIME', bad);
      const ok = await applyFixRequest({ id: fr.id, companyId: company.id, userId: null, userRole: 'owner' });
      const { data: last } = await supabase.from('presence_logs').select('event_type, timestamp_server').eq('worker_id', aperto.id).order('timestamp_server', { ascending: false }).limit(1).single();
      check('uscita mancante confermata: USCITA all\'orario proposto', ok.ok && last.event_type === 'EXIT' && romeMinutes(last.timestamp_server) === nowMin - 10, { ok, last });

      const timbrato = await worker('Timbrato');
      const e2 = await log(timbrato, 'ENTRY', at(nowMin - 100).toISOString());
      await createFixRequest({ company_id: company.id, worker_id: timbrato.id, site_id: site.id, kind: 'missing_exit', day: today, entry_log_id: e2.id, entry_at: e2.timestamp_server, proposed_at: at(nowMin - 10).toISOString() });
      await log(timbrato, 'EXIT', at(nowMin - 5).toISOString());
      const { data: fr2 } = await supabase.from('presence_fix_requests').select('id').eq('worker_id', timbrato.id).single();
      const sc = await applyFixRequest({ id: fr2.id, companyId: company.id, userId: null, userRole: 'owner' });
      const { count: c2 } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('worker_id', timbrato.id);
      check('se nel frattempo ha timbrato: niente scritto (STATE_CHANGED)', sc.code === 'STATE_CHANGED' && c2 === 2, { sc, c2 });
    }

    // ── Uscita sbagliata dopo un turno breve: annotata, ore vere ──
    if (nowMin >= 120) {
      const breve = await worker('Breve');
      await log(breve, 'ENTRY', at(nowMin - 60).toISOString());
      await log(breve, 'EXIT', at(nowMin - 55).toISOString());
      const created = await fixRequestFromWorker({ worker: breve, siteId: site.id, reason: 'ENTRY_NOT_EXIT' });
      const { data: fr } = await supabase.from('presence_fix_requests').select('id').eq('worker_id', breve.id).single();
      const r = await applyFixRequest({ id: fr.id, companyId: company.id, userId: null, userRole: 'owner' });
      const rep = await buildWorkerHoursReport(null, company.id, today, today, null, true);
      const mins = rep.workers.find(w => w.id === breve.id)?.total_minutes;
      check('uscita sbagliata: annotata, il giorno conta da entrata a tocco (~60 min, non 5)', created && r.ok && mins >= 59 && mins <= 61, { created, r, mins });
    }

    // ── Turno breve: "È giusta" ──
    const corto = await worker('Corto');
    await createFixRequest({ company_id: company.id, worker_id: corto.id, site_id: site.id, kind: 'short_shift', day: today, entry_at: at(Math.max(0, nowMin - 20)).toISOString(), exit_at: at(Math.max(0, nowMin - 13)).toISOString() });
    const { data: frs } = await supabase.from('presence_fix_requests').select('id').eq('worker_id', corto.id).single();
    check('turno breve: la conferma in un tocco non si applica (si corregge da Presenze)', (await applyFixRequest({ id: frs.id, companyId: company.id, userId: null, userRole: 'owner' })).code === 'NOT_APPLICABLE');
    const df2 = await buildDaFare(company.id, null);
    check('Da fare: turno breve con "È giusta"', df2.items.find(i => i.fixId === frs.id)?.fixDismiss?.label === 'È giusta');
    check('"È giusta" chiude il caso', (await dismissFixRequest({ id: frs.id, companyId: company.id, userId: null })).ok && !(await buildDaFare(company.id, null)).items.some(i => i.fixId === frs.id));

    // ── Promemoria: decisione ──
    const open = [
      { workerId: 'A', entryLogId: 'eA', entryAt: romeAt(today, 450) },   // entra 07:30, esce di solito 17:00
      { workerId: 'N', entryLogId: 'eN', entryAt: romeAt(today, 1320) },  // notte: entra 22:00, esce alle 06:00
      { workerId: 'S', entryLogId: 'eS', entryAt: romeAt(today, 1000) },  // entrato 16:40, esce di solito 17:00 (straordinario)
    ];
    const usual = new Map([['A', { exitMin: 1020 }], ['N', { exitMin: 360 }], ['S', { exitMin: 1020 }]]);
    check('17:20: ancora nessun promemoria', decide({ open, usual, nowMin: 1040, sent: new Set() }).length === 0);
    const d1 = decide({ open, usual, nowMin: 1050, sent: new Set() });
    check('17:30: promemoria solo a chi entra la mattina (non notte, non straordinario)', d1.length === 1 && d1[0].workerId === 'A' && d1[0].kind === 'exit_reminder', d1);
    const d2 = decide({ open, usual, nowMin: 1110, sent: new Set(['eA|exit_reminder']) });
    check('18:30: promemoria già mandato → solo il caso per il titolare', d2.length === 1 && d2[0].kind === 'exit_owner_alert', d2);
    check('tutto già mandato: niente', decide({ open, usual, nowMin: 1200, sent: new Set(['eA|exit_reminder', 'eA|exit_owner_alert']) }).length === 0);
  } finally {
    server.close();
    await supabase.from('presence_fix_requests').delete().eq('company_id', company.id);
    await supabase.from('notifications').delete().eq('company_id', company.id);
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
