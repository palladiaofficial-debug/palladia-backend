#!/usr/bin/env node
/**
 * scripts/selftest_conteggio_unico.js — F-436 (AUDIT.md del frontend, 7/11).
 *
 * Il numero delle cose da fare era diverso da pagina a pagina. Su un'azienda di prova vera (DB):
 *  - POS: «Via Lavoro» (timbrata ieri, senza POS) e «Via Ferma» (mai timbrata, partita mesi fa,
 *    senza POS). Da fare segnala solo Via Lavoro; Cantieri › Sicurezza conta 1 da sistemare dove
 *    si lavora (Via Ferma c'è ma è «ferma»); il pallino di Sicurezza (altriPosti) dice 1.
 *  - Documenti: un operaio senza visita medica né corso, con la visita «prenotata» in Da fare →
 *    Documenti la mette tra i prenotati, non tra le cose da sistemare.
 *  - Oggi (componi, pura): con la lista di Documenti, «N documenti scaduti» e «N documenti
 *    mancano» hanno gli stessi numeri di Documenti (senza le imprese, che hanno le loro righe);
 *    «scadono questa settimana» non conta più i documenti che mancano.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const S = require('../lib/sicurezzaCantieri');
const D = require('../lib/documentiStato');
const { buildDaFare, romeDate } = require('../lib/daFare');
const { conta } = require('../lib/altriPosti');
const { componi } = require('../lib/oggi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}

(async () => {
  console.log('\n\x1b[1mF-436 — un conteggio unico delle cose da fare\x1b[0m');
  const T = `TEST-F436-${Date.now()}`;
  const stamp = String(Date.now()).slice(-6);
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  try {
    const oggi = romeDate();
    const ieri = new Date(Date.parse(`${oggi}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
    const lavoro = await ins('sites', { company_id: co.id, name: `${T} Via Lavoro`, address: 'Via Lavoro 1, Genova', status: 'attivo', start_date: '2026-01-10' });
    const ferma = await ins('sites', { company_id: co.id, name: `${T} Via Ferma`, address: 'Via Ferma 1, Genova', status: 'attivo', start_date: '2026-01-10' });
    const w = await ins('workers', { company_id: co.id, full_name: `${T} Mario Rossi`, is_active: true, fiscal_code: `F436MR${stamp}`.slice(0, 16), badge_code: `F436MR${stamp}` });
    await ins('presence_logs', { company_id: co.id, site_id: lavoro.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: `${ieri}T07:00:00Z`, method: 'worker_self_punch' });

    // ── POS: la stessa regola «qui si lavora» ──
    const df = await buildDaFare(co.id, null, { role: 'owner' });
    const pos = df.items.filter(i => i.type === 'pos_manca');
    check('Da fare: POS che manca solo dove si lavora (Via Lavoro, non Via Ferma)', pos.length === 1 && pos[0].entityId === lavoro.id, pos.map(i => i.title));
    const el = await S.elenco(co.id);
    const riga = (s) => el.cantieri.find(c => c.id === s.id);
    check('Sicurezza: Via Lavoro al lavoro, Via Ferma ferma', riga(lavoro)?.alLavoro === true && riga(ferma)?.alLavoro === false, el.cantieri.map(c => [c.nome, c.alLavoro]));
    check('Sicurezza: 1 da sistemare dove si lavora (non 2)', el.daSistemare === 1 && el.totale - el.aPosto === 2, { daSistemare: el.daSistemare, totale: el.totale, aPosto: el.aPosto });
    check('pallino di Sicurezza = 1, come Da fare', conta({ items: df.items, sicurezza: el }).sicurezza.daSistemare === 1, conta({ items: df.items, sicurezza: el }).sicurezza);

    // ── Documenti: il prenotato sta a parte ──
    await ins('da_fare_prenotazioni', { company_id: co.id, item_id: `worker:${w.id}:idoneita`, torna_il: new Date(Date.parse(`${oggi}T12:00:00Z`) + 5 * 864e5).toISOString().slice(0, 10) });
    const pan = await D.panoramica(co.id);
    const suoi = pan.daSistemare.filter(x => x.id === w.id);
    check('Documenti: la visita prenotata non è tra le cose da sistemare', !suoi.some(x => x.key === 'idoneita') && suoi.some(x => x.key === 'formazione'), suoi.map(x => [x.key, x.state]));
    check('Documenti: è tra i prenotati, con la data', (pan.prenotati || []).some(x => x.id === w.id && x.key === 'idoneita' && x.tornaIl), pan.prenotati);

    // ── Oggi: gli stessi numeri di Documenti ──
    const documenti = [
      { kind: 'lavoratori', id: 'a', name: 'Rossi', label: 'Visita medica', state: 'scaduto', expiry: '2026-09-17' },
      { kind: 'impresa', id: 'b', name: 'MSC', label: 'DURC', state: 'scaduto', expiry: '2026-10-10' },
      { kind: 'mezzi', id: 'c', name: 'Scooter', label: 'Assicurazione', state: 'manca', expiry: null },
      { kind: 'lavoratori', id: 'd', name: 'Bianchi', label: 'Corso sicurezza', state: 'manca', expiry: null },
      { kind: 'subappaltatori', id: 'e', name: 'AYAT', label: 'Visura camerale', state: 'scaduto', expiry: '2026-05-28' },
    ];
    const items = [
      { id: 'worker:d:formazione', kind: 'scadenza', type: 'formazione', bucket: 'settimana', title: 'Corso sicurezza — Bianchi', subtitle: 'manca: nessun documento caricato', date: oggi },
      { id: 'doc:x', kind: 'scadenza', type: 'idoneita', bucket: 'settimana', title: 'Visita medica — Verdi', subtitle: 'scade tra 3 giorni · 10 nov', date: oggi },
    ];
    const o = componi({ items, documenti, oggi });
    const r = (id) => o.righe.find(x => x.id === id);
    check('Oggi: «2 documenti scaduti» (l’impresa in subappalto ha la sua riga)', r('documenti-scaduti')?.titolo === '2 documenti scaduti', o.righe.map(x => x.titolo));
    check('Oggi: «2 documenti mancano»', r('documenti-mancano')?.titolo === '2 documenti mancano', o.righe.map(x => x.titolo));
    const presto = o.righe.find(x => /scade|Visita medica di Verdi/.test(x.titolo));
    check('Oggi: «scadono questa settimana» solo quello che scade davvero (non il corso che manca)', presto && presto.titolo === 'Visita medica di Verdi' && !o.righe.some(x => /scadono questa settimana/.test(x.titolo)), o.righe.map(x => x.titolo));
    check('Oggi: le righe dei documenti portano a Documenti', r('documenti-scaduti')?.link === '/documenti' && r('documenti-mancano')?.link === '/documenti', [r('documenti-scaduti')?.link, r('documenti-mancano')?.link]);
  } catch (e) {
    console.error(e); failed++;
  } finally {
    const { data: ss } = await supabase.from('sites').select('id').eq('company_id', co.id);
    const ids = (ss || []).map(s => s.id);
    if (ids.length) await supabase.from('presence_logs').delete().in('site_id', ids);
    await supabase.from('da_fare_prenotazioni').delete().eq('company_id', co.id);
    await supabase.from('workers').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    await supabase.from('companies').delete().eq('id', co.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})();
