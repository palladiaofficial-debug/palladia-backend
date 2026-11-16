#!/usr/bin/env node
/**
 * scripts/selftest_f485_pioggia_giorno_intero.js — F-485 (AUDIT.md del frontend).
 *
 * Il titolare (10/11/2026), regola confermata dal datore di lavoro: chi esce
 * per pioggia entro le 10 (si aspetta fino alle 10 per vedere se smette) ha
 * «pioggia tutto il giorno»; chi esce dopo ha le ore lavorate + il resto di
 * pioggia. È un'impostazione dell'impresa (companies.pioggia_giorno_intero_entro):
 * spenta = conteggio di prima.
 *
 * Senza DB: la regola (lib/pioggiaGiornoIntero.js) e come la scrive il foglio.
 */
'use strict';
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

let regola = null;
try { regola = require('../lib/pioggiaGiornoIntero'); } catch { regola = null; }
console.log('\n\x1b[1mF-485 — uscita per pioggia entro le 10 = tutto il giorno pioggia\x1b[0m');
check('esiste lib/pioggiaGiornoIntero.js', !!regola);

// giorno 08:00–17:00 (8 h), uscito per pioggia: ore lavorate fino all'uscita, il resto pioggia
const cella = (uscita, ore, extra = {}) => ({ date: '2026-10-07', tipo: 'lavoro', ore, straord: 0, maltempoMin: 480 - ore, permessoMin: 0, malattiaMin: 0, infortunioMin: 0, primaEntrata: '08:00', ultimaUscita: uscita, perCantiere: { s1: ore }, uscitoPrima: 0, ...extra });
const opz = { limite: '10:00', tolleranza: 5, contratto: 480 };
const applica = (c, o = opz, motivo = 'maltempo') => { if (regola) regola.applicaPioggiaGiornoIntero(c, { ...o, motivo }); return c; };

if (regola) {
  let c = applica(cella('10:00', 120));
  check('uscito alle 10:00 → 0 ore, 8 h di pioggia, giorno «pioggia»', c.ore === 0 && c.maltempoMin === 480 && c.tipo === 'maltempo', c);
  check('…e ricorda le ore lavorate prima di uscire (per le note)', c.pioggiaGiornoIntero && c.pioggiaGiornoIntero.oreLavorate === 120 && c.pioggiaGiornoIntero.entro === '10:00', c.pioggiaGiornoIntero);
  check('…nessuna ora per cantiere (non sono ore lavorate)', Object.keys(c.perCantiere).length === 0, c.perCantiere);
  c = applica(cella('09:30', 90));
  check('uscito alle 09:30 → tutto il giorno pioggia', c.tipo === 'maltempo' && c.ore === 0 && c.maltempoMin === 480, c);
  // F-505: il margine è già nell'ora limite, la tolleranza dell'orario NON si aggiunge
  c = applica(cella('10:04', 124));
  check('F-505: uscito alle 10:04 con limite 10:00 → ore + pioggia (niente tolleranza in più)', c.tipo === 'lavoro' && c.ore === 124 && !c.pioggiaGiornoIntero, c);
  const msc = { limite: '10:30', tolleranza: 5, contratto: 480 };
  c = applica(cella('10:30', 150), msc);
  check('F-505 (MSC, limite 10:30): uscito alle 10:30 → tutto il giorno pioggia', c.tipo === 'maltempo' && c.ore === 0 && c.maltempoMin === 480, c);
  c = applica(cella('10:34', 154), msc);
  check('F-505 (Elton Lika, 20/10): uscito alle 10:34 → 2 h 34 lavorate + 5 h 26 di pioggia', c.tipo === 'lavoro' && c.ore === 154 && c.maltempoMin === 326 && !c.pioggiaGiornoIntero, c);
  c = applica(cella('10:31', 151), msc);
  check('F-505: uscito alle 10:31 → ore + pioggia', c.tipo === 'lavoro' && c.ore === 151, c);
  c = applica(cella('10:30', 150));
  check('uscito alle 10:30 → 2,5 h lavorate + 5,5 h di pioggia (come prima)', c.tipo === 'lavoro' && c.ore === 150 && c.maltempoMin === 330 && !c.pioggiaGiornoIntero, c);
  c = applica(cella('12:00', 240));
  check('uscito a mezzogiorno → 4 h + 4 h di pioggia', c.tipo === 'lavoro' && c.ore === 240 && c.maltempoMin === 240, c);
  c = applica(cella('10:00', 120), { ...opz, limite: null });
  check('impostazione spenta → conteggio di prima (2 h + 6 h)', c.tipo === 'lavoro' && c.ore === 120 && c.maltempoMin === 360, c);
  c = applica(cella('10:00', 120), opz, 'caldo');
  check('uscita per il caldo alle 10 → non cambia (la regola è solo per la pioggia)', c.tipo === 'lavoro' && c.ore === 120, c);
  c = applica(cella('10:00', 120, { maltempoMin: 0, permessoMin: 360 }), opz, null);
  check('uscita per permesso alle 10 → non cambia', c.tipo === 'lavoro' && c.ore === 120 && c.permessoMin === 360, c);
  c = applica(cella('10:00', 120, { straord: 60 }));
  check('giorno con straordinario (rientrato dopo) → non cambia', c.tipo === 'lavoro' && c.ore === 120, c);
}

// F-505: la riga della proposta «Da vedere» dice all'ufficio cosa sta confermando
try { require('dotenv').config({ quiet: true }); } catch { /* le variabili possono già esserci */ }
let riga = null;
try { riga = require('../lib/pioggiaDaConfermare').rigaUscita; } catch { riga = null; }
check('F-505: esiste rigaUscita in lib/pioggiaDaConfermare.js', typeof riga === 'function');
if (typeof riga === 'function') {
  const g = (ordinarie) => ({ contratto: 480, straord: 0, ordinarie });
  let r = riga({ kind: 'pioggia', uscita: '10:30', rientro: false, g: g(150), limite: '10:30', oreMin: 330 });
  check('F-505 proposta: uscito alle 10:30 → tutto il giorno (8 h di pioggia, 0 lavoro, «entro le 10:30»)', r.giornoIntero === true && r.oreMin === 480 && r.lavoratoMin === 0 && r.entro === '10:30', r);
  r = riga({ kind: 'pioggia', uscita: '10:34', rientro: false, g: g(154), limite: '10:30', oreMin: 326 });
  check('F-505 proposta: uscito alle 10:34 → 2 h 34 di lavoro + 5 h 26 di pioggia, «dopo le 10:30»', !r.giornoIntero && r.oreMin === 326 && r.lavoratoMin === 154 && r.dopo === '10:30', r);
  r = riga({ kind: 'pioggia', uscita: '09:00', rientro: true, g: g(400), limite: '10:30', oreMin: 80 });
  check('F-505 proposta: uscito presto ma rientrato → ore + pioggia', !r.giornoIntero && r.lavoratoMin === 400, r);
  r = riga({ kind: 'caldo', uscita: '10:00', rientro: false, g: g(120), limite: '10:30', oreMin: 360 });
  check('F-505 proposta: il caldo non diventa mai tutto il giorno', !r.giornoIntero && !r.dopo, r);
}

// Il foglio per la commercialista dice la regola e spiega il giorno
const { generateFoglioHtml, noteGiorni } = require('../lib/oreMeseFoglio');
const days = [{ date: '2026-10-07', day: 7, dow: 3, weekend: false, festivo: null }];
const c7 = cella('10:00', 120);
applica(c7);
const data = {
  month: '2026-10', from: '2026-10-07', to: '2026-10-07', days, giorniLavorativi: 1,
  azienda: { nome: 'Prova F-485', piva: '' }, cantieri: { s1: 'Via Roma 1' },
  regole: { oreGiornoMin: 480, inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00', tolleranza: 5, straordSoglia: 30, straordBlocco: 30, confermato: true, pioggiaGiornoInteroEntro: '10:00' },
  assenze: [], richieste: [], domande: [],
  lavoratori: [{ id: 'w1', nome: 'Rossi Mario', cf: 'RSSMRA80A01H501U', cells: [c7], tot: { ordinarieMin: c7.ore, straordMin: 0, maltempoMin: c7.maltempoMin, giorniLavorati: c7.tipo === 'lavoro' ? 1 : 0 } }],
};
const html = generateFoglioHtml(data, 'Prova F-485');
check('foglio: nelle regole in testa «uscita per pioggia entro le 10:00 = tutto il giorno pioggia»', /pioggia entro le 10:00[^<]*tutto il giorno/i.test(html), (html.match(/class="rules">[^<]*/) || [])[0]);
const nota = noteGiorni(data).map(n => n.testo).join(' | ');
check('note sui giorni: «pioggia tutto il giorno… uscito alle 10:00»', /pioggia tutto il giorno/i.test(nota) && /uscito alle 10:00/.test(nota), nota);

console.log(`\n${passed} passati, ${failed} falliti.\n`);
process.exit(failed ? 1 : 0);
