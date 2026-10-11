#!/usr/bin/env node
/**
 * scripts/selftest_ore_domande.js — F-335 (AUDIT.md del frontend).
 *
 * Le risposte alle domande che chiudono il mese, chiamando le rotte vere:
 *   - "Il vostro orario è 8–17?" → PATCH /ore/orario (e il foglio lo usa);
 *   - "Ha un orario suo?" → PATCH /ore/lavoratori/:id/orario (sì / no);
 *   - "E prima di quel giorno?" → POST /ore/prima (non assunto / su carta);
 *   - "Cos'erano quei giorni?" → POST /assenze/giorni (più giorni in un tocco);
 *   - solo titolare e amministratori; valori sbagliati rifiutati;
 *   - nessuna di queste scrive presence_logs.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const supabase = require('../lib/supabase');

// Login finto: azienda e ruolo dalle intestazioni (il vero middleware verifica il JWT)
const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = req.get('x-test-role') || 'owner'; req.user = { id: null }; next(); },
} };
const { router } = require('../routes/v1/oreAssenze');
const { buildOreMese } = require('../lib/oreMese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F335-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-335 — Domande per chiudere il mese\x1b[0m');
  const app = express(); app.use(express.json()); app.use('/api/v1', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const company = await ins('companies', { name: T });
  const call = async (method, p, body, role = 'owner') => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-company': company.id, 'x-test-role': role }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const stamp = String(Date.now()).slice(-8);
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: '', status: 'attivo' });
    const pietro = await ins('workers', { company_id: company.id, full_name: `${T} Pietro`, is_active: true, fiscal_code: `F335PIET${stamp}`, badge_code: `F335P${stamp}` });
    const nuovo = await ins('workers', { company_id: company.id, full_name: `${T} Nuovo`, is_active: true, fiscal_code: `F335NUOV${stamp}`, badge_code: `F335N${stamp}` });
    const log = (w, type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    // Pietro: tutto marzo 2026 7:30–16:30 (lun–ven); Nuovo: dal 16 marzo, poi assente il 19 e il 20
    for (let d = 2; d <= 31; d++) {
      const dow = new Date(Date.UTC(2026, 2, d)).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const dd = String(d).padStart(2, '0');
      const tz = d >= 29 ? '+02:00' : '+01:00'; // ora legale dal 29 marzo 2026
      await log(pietro, 'ENTRY', `2026-03-${dd}T07:30:00${tz}`); await log(pietro, 'EXIT', `2026-03-${dd}T16:30:00${tz}`);
      if (d >= 16 && d !== 19 && d !== 20) { await log(nuovo, 'ENTRY', `2026-03-${dd}T07:55:00${tz}`); await log(nuovo, 'EXIT', `2026-03-${dd}T17:01:00${tz}`); }
    }
    const { count: logsPrima } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);

    let r = await buildOreMese(company.id, '2026-03', { today: '2026-04-01' });
    const tipi = r.domande.map(d => d.tipo);
    check('domande in ordine: orario dell\'azienda, orario personale di Pietro, "prima" di Nuovo, giorni di Nuovo', JSON.stringify(tipi) === JSON.stringify(['orario_azienda', 'orario_personale', 'prima', 'giustificare']), r.domande);
    const op = r.domande.find(d => d.tipo === 'orario_personale');
    check('orario proposto per Pietro: 07:30–16:30', op?.workerId === pietro.id && op.inizio === '07:30' && op.fine === '16:30', op);
    const P = (lv) => r.lavoratori.find(l => l.id === lv.id);
    check('prima della risposta Pietro ha un\'uscita anticipata al giorno (16:30 con orario 8–17)', P(pietro).tot.uscitePrima === P(pietro).tot.giorniLavorati && P(pietro).tot.ordinarieMin === P(pietro).tot.giorniLavorati * 450, P(pietro).tot);

    // Permessi e validazione
    check('un tecnico non può cambiare l\'orario: 403', (await call('PATCH', '/ore/orario', { inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00' }, 'tech')).status === 403);
    check('fine prima dell\'inizio: 400', (await call('PATCH', '/ore/orario', { inizio: '17:00', fine: '08:00', pausaDa: '12:00', pausaA: '13:00' })).status === 400);
    check('pausa fuori dall\'orario: 400', (await call('PATCH', '/ore/orario', { inizio: '08:00', fine: '17:00', pausaDa: '18:00', pausaA: '19:00' })).status === 400);
    check('tolleranza 45 min: 400', (await call('PATCH', '/ore/orario', { inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00', tolleranza: 45 })).status === 400);

    // 1. Orario dell'azienda confermato
    check('orario 8–17 confermato: 200', (await call('PATCH', '/ore/orario', { inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00' })).status === 200);
    // 2. Orario personale di Pietro
    check('orario personale 7:30–16:30 per Pietro: 200', (await call('PATCH', `/ore/lavoratori/${pietro.id}/orario`, { inizio: '07:30', fine: '16:30' })).status === 200);
    check('orario di un lavoratore di un\'altra azienda: 404', (await call('PATCH', '/ore/lavoratori/00000000-0000-0000-0000-000000000000/orario', { inizio: '07:30', fine: '16:30' })).status === 404);
    // 3. Nuovo: prima del 16 non era assunto
    check('"prima" senza motivo valido: 400', (await call('POST', '/ore/prima', { lavoratori: [{ id: nuovo.id, dal: '2026-03-16' }], motivo: 'boh' })).status === 400);
    check('"prima": Nuovo non era assunto prima del 16: 200', (await call('POST', '/ore/prima', { lavoratori: [{ id: nuovo.id, dal: '2026-03-16' }], motivo: 'assunto' })).status === 200);
    // 4. Nuovo: 19 e 20 ferie in un tocco
    check('giorni con tipo sconosciuto: 400', (await call('POST', '/assenze/giorni', { worker_id: nuovo.id, tipo: 'vacanza', giorni: ['2026-03-19'] })).status === 400);
    const g = await call('POST', '/assenze/giorni', { worker_id: nuovo.id, tipo: 'ferie', giorni: ['2026-03-20', '2026-03-19'] });
    check('19 e 20 marzo ferie in un tocco: un\'assenza sola (giorni consecutivi)', g.status === 201 && g.body.ids?.length === 1, g);

    r = await buildOreMese(company.id, '2026-03', { today: '2026-04-01' });
    check('dopo le risposte: nessuna domanda', r.domande.length === 0, r.domande);
    check('regole: orario confermato', r.regole.confermato === true, r.regole);
    check('Pietro col suo orario: 8 h al giorno, nessuna uscita anticipata, orario scritto nel foglio', P(pietro).tot.uscitePrima === 0 && P(pietro).tot.ordinarieMin === P(pietro).tot.giorniLavorati * 480 && P(pietro).orario === '07:30–16:30', P(pietro).tot);
    const N = P(nuovo);
    check('Nuovo: giorni prima del 16 "prima", 19–20 ferie, nessun giorno da giustificare', N.cells.find(c => c.date === '2026-03-13').tipo === 'prima' && N.cells.find(c => c.date === '2026-03-19').tipo === 'ferie' && N.tot.daGiustificare === 0 && N.tot.ferieGiorni === 2, N.tot);
    check('Nuovo: 7:55–17:01 = 8 h esatte, nessun ritardo (tolleranza), nessuno straordinario', N.cells.find(c => c.date === '2026-03-16').ore === 480 && N.tot.ritardi === 0 && N.tot.straordMin === 0, N.cells.find(c => c.date === '2026-03-16'));

    // "No, per lui vale l'orario dell'azienda": la domanda non torna
    await call('PATCH', `/ore/lavoratori/${pietro.id}/orario`, { rifiuta: true });
    r = await buildOreMese(company.id, '2026-03', { today: '2026-04-01' });
    check('rifiutato l\'orario personale: la domanda non torna e Pietro torna a 8–17', !r.domande.some(d => d.tipo === 'orario_personale') && P(pietro).orario === null && P(pietro).tot.uscitePrima > 0, r.domande);

    const { count: logsDopo } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    check('nessuna timbratura toccata', logsDopo === logsPrima, { logsPrima, logsDopo });
  } finally {
    server.close();
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    // presence_logs append-only: le righe di prova restano sull'azienda TEST-
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
