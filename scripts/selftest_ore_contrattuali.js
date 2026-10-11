#!/usr/bin/env node
/**
 * scripts/selftest_ore_contrattuali.js — F-335 (AUDIT.md del frontend).
 *
 * Come si contano le ore di un giorno per le buste paga, dall'orario di
 * lavoro e non dai minuti timbrati. Regole decise dal titolare (11/10/2026):
 *   - si conta dall'orario di inizio (8:00): chi timbra prima è segnato ma
 *     quei minuti non contano, mai come straordinario;
 *   - chi arriva dopo si conta dall'ora vera ed è un ritardo (entro la
 *     tolleranza di 5 minuti è in orario; dopo le 12 è mezza giornata);
 *   - fine 17:00, pausa 12–13 non pagata;
 *   - straordinario solo da 30 minuti dopo la fine, a blocchi di 30.
 * Funzione pura: niente DB, niente timbrature.
 */
'use strict';
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

let O;
try { O = require('../lib/oreContrattuali'); } catch (e) { O = null; }
console.log('\n\x1b[1mF-335 — Ore contate dall\'orario di lavoro\x1b[0m');
check('esiste lib/oreContrattuali con contaGiorno e risolviOrario', !!O && typeof O.contaGiorno === 'function' && typeof O.risolviOrario === 'function');
if (!O) { console.log(`\n${passed} passati, ${failed} falliti.\n`); process.exit(1); }

const { contaGiorno, risolviOrario, ORARIO_PREDEFINITO } = O;
const m = (t) => { const [h, mm] = t.split(':').map(Number); return h * 60 + mm; };
const P = (...coppie) => coppie.map(([a, b, siteId = 's1', motivo = null]) => ({ in: m(a), out: m(b), siteId, motivo }));
const OR = ORARIO_PREDEFINITO;
const g = (coppie, extra = {}) => contaGiorno({ coppie: P(...coppie), orario: OR, lavorativo: true, ...extra });

// ── Orario ──
check('orario predefinito: 8:00–17:00, pausa 12–13, tolleranza 5, straordinario da 30 a blocchi di 30',
  OR.inizio === 480 && OR.fine === 1020 && OR.pausaDa === 720 && OR.pausaA === 780 && OR.tolleranza === 5 && OR.straordSoglia === 30 && OR.straordBlocco === 30, OR);
check('ore contrattuali del giorno: 8 h', O.oreGiornoContratto(OR) === 480);
const pers = risolviOrario({ company: { orario_inizio: '08:00:00', orario_fine: '17:00:00', pausa_inizio: '12:00:00', pausa_fine: '13:00:00' }, site: { orario_inizio: '07:00', orario_fine: '16:00' }, worker: { orario_inizio: '07:30', orario_fine: '16:30' } });
check('orario: il lavoratore vince sul cantiere, il cantiere sull\'azienda', pers.inizio === m('07:30') && pers.fine === m('16:30') && pers.pausaDa === 720 && pers.fonte === 'lavoratore', pers);
const cant = risolviOrario({ company: {}, site: { orario_inizio: '07:00', orario_fine: '16:00' }, worker: {} });
check('orario del cantiere sull\'azienda senza orario', cant.inizio === 420 && cant.fine === 960 && cant.fonte === 'cantiere', cant);
const def = risolviOrario({ company: {}, site: null, worker: null });
check('azienda senza orario: predefinito, segnato come da confermare', def.inizio === 480 && def.fonte === 'predefinito', def);
const conf = risolviOrario({ company: { orario_inizio: '08:00', orario_fine: '17:00', pausa_inizio: '12:00', pausa_fine: '13:00', orario_tolleranza_min: 0, straord_soglia_min: 15, straord_blocco_min: 15 } });
check('azienda: tolleranza e straordinario personalizzati', conf.tolleranza === 0 && conf.straordSoglia === 15 && conf.straordBlocco === 15 && conf.fonte === 'azienda', conf);

// ── Il caso del titolare ──
let r = g([['07:38', '17:02']]);
check('7:38–17:02: 8 h, niente straordinario, entrato prima segnato', r.ordinarie === 480 && r.straordinario === 0 && r.entratoPrima === 22 && r.ritardo === 0 && r.uscitoPrima === 0, r);
r = g([['06:30', '17:00']]);
check('6:30–17:00: le ore prima delle 8 non sono mai straordinario', r.ordinarie === 480 && r.straordinario === 0 && r.entratoPrima === 90, r);

// ── Ritardi ──
r = g([['08:04', '17:00']]);
check('8:04: dentro la tolleranza → in orario, 8 h', r.ordinarie === 480 && r.ritardo === 0, r);
r = g([['08:12', '17:00']]);
check('8:12: ritardo di 12 min, si conta dall\'ora vera (7 h 48)', r.ordinarie === 468 && r.ritardo === 12, r);
r = g([['09:30', '17:00']]);
check('9:30: ritardo 90 min, 6 h 30', r.ordinarie === 390 && r.ritardo === 90, r);
r = g([['13:00', '17:00']]);
check('13:00: mezza giornata, non ritardo; 4 h', r.mezzaGiornata === true && r.ritardo === 0 && r.ordinarie === 240, r);
r = g([['12:30', '17:00']]);
check('12:30 (dentro la pausa): mezza giornata, si conta dalle 13 → 4 h', r.mezzaGiornata === true && r.ordinarie === 240, r);

// ── Uscite ──
r = g([['07:50', '16:57']]);
check('16:57: dentro la tolleranza → 8 h, nessuna uscita anticipata', r.ordinarie === 480 && r.uscitoPrima === 0, r);
r = g([['07:50', '16:30']]);
check('16:30: uscito 30 min prima, 7 h 30', r.ordinarie === 450 && r.uscitoPrima === 30, r);
r = g([['07:50', '11:30']]);
check('11:30: uscito prima della pausa → 3 h 30, nessuna pausa tolta', r.ordinarie === 210 && r.uscitoPrima === 330, r);
r = g([['07:50', '14:30', 's1', 'maltempo']]);
check('uscita per pioggia alle 14:30: 5 h 30, il resto è maltempo, non "uscito prima"', r.ordinarie === 330 && r.uscitoPrima === 0 && r.motivo === 'maltempo' && r.mancanti === 150, r);

r = g([['07:50', '10:00', 's1', 'maltempo'], ['13:00', '17:00']]);
check('uscito per pioggia alle 10 e rientrato alle 13: il motivo vale anche se non è l\'ultima uscita', r.motivo === 'maltempo' && r.ordinarie === 360 && r.mancanti === 120 && r.uscitoPrima === 0, r);

// ── Straordinario ──
r = g([['07:45', '17:20']]);
check('17:20: meno di 30 min → niente straordinario', r.ordinarie === 480 && r.straordinario === 0 && r.oltreOrario === 20, r);
r = g([['07:45', '17:40']]);
check('17:40: 30 min di straordinario', r.straordinario === 30, r);
r = g([['07:45', '18:20']]);
check('18:20: 1 h (blocchi di 30, per difetto)', r.straordinario === 60, r);
r = g([['07:00', '18:00']]);
check('7:00–18:00: 8 h + 1 h straordinario (non 2)', r.ordinarie === 480 && r.straordinario === 60, r);
r = g([['08:30', '18:30']]);
check('ritardo e straordinario nello stesso giorno restano separati', r.ritardo === 30 && r.ordinarie === 450 && r.straordinario === 90, r);

// ── Pausa ──
r = g([['07:50', '12:02'], ['12:58', '17:01']]);
check('pausa timbrata 12–13: 8 h', r.ordinarie === 480 && r.pausaTimbrata === true, r);
r = g([['07:50', '12:30'], ['13:30', '17:00']]);
check('pausa timbrata spostata 12:30–13:30: 8 h, non 7 h 30', r.ordinarie === 480, r);
r = g([['07:50', '12:00'], ['12:20', '17:00']]);
check('pausa timbrata di 20 min: si contano 8 h (massimo da contratto), nessuno straordinario', r.ordinarie === 480 && r.straordinario === 0, r);
r = g([['07:50', '17:00']], { pausaSaltata: true });
check('"ho saltato la pausa" confermato e rimasto fino alle 17: 8 h + 1 h straordinario', r.ordinarie === 480 && r.straordinario === 60, r);
r = g([['07:29', '16:30']], { pausaSaltata: true });
check('"ho saltato la pausa" ed è uscito prima per questo (Petriccione 29/9): 8 h, niente straordinario, nessuna uscita anticipata', r.ordinarie === 480 && r.straordinario === 0 && r.uscitoPrima === 0, r);
r = g([['07:50', '12:00'], ['12:20', '16:40']]);
check('pausa timbrata corta e uscita alle 16:40 con 8 h fatte: nessuna uscita anticipata', r.ordinarie === 480 && r.uscitoPrima === 0, r);

// ── Più cantieri ──
r = g([['07:50', '12:00', 'A'], ['13:00', '17:00', 'B']]);
check('ore per cantiere: 4 h A, 4 h B', r.perCantiere.A === 240 && r.perCantiere.B === 240 && r.ordinarie === 480, r);
r = g([['07:50', '17:40', 'A']]);
check('lo straordinario va al cantiere dove si è fatto', r.perCantiere.A === 510, r);

// ── Sabato, domenica, festivi ──
r = g([['07:50', '12:05']], { lavorativo: false });
check('sabato 7:50–12:05: 4 h tutte straordinario (festivo), non ordinarie', r.ordinarie === 0 && r.straordinario === 240 && r.festivo === true, r);

// ── Orario personale ──
const p = risolviOrario({ company: {}, worker: { orario_inizio: '07:30', orario_fine: '16:30' } });
r = contaGiorno({ coppie: P(['07:27', '16:30']), orario: p, lavorativo: true });
check('orario personale 7:30–16:30: 7:27–16:30 → 8 h, niente segnalato', r.ordinarie === 480 && r.uscitoPrima === 0 && r.ritardo === 0, r);
r = contaGiorno({ coppie: P(['07:27', '15:35']), orario: p, lavorativo: true });
check('orario personale: 15:35 è uscita anticipata di 55 min', r.uscitoPrima === 55 && r.ordinarie === 425, r);

// ── Casi limite ──
r = g([]);
check('nessuna coppia: 0 ore, niente segnalato', r.ordinarie === 0 && r.straordinario === 0 && r.ritardo === 0, r);
r = g([['16:22', '16:24'], ['16:33', '17:02']]);
check('tocchi di prova nel pomeriggio: mezza giornata, 2 + 27 = 29 min (17:02 si ferma alle 17)', r.mezzaGiornata === true && r.ordinarie === 29, r);
r = g([['18:00', '20:00']]);
check('solo dopo l\'orario: 0 ordinarie, 2 h straordinario', r.ordinarie === 0 && r.straordinario === 120, r);

console.log(`\n${passed} passati, ${failed} falliti.\n`);
process.exit(failed ? 1 : 0);
