#!/usr/bin/env node
/**
 * scripts/selftest_schede_v2.js — F-350 (AUDIT.md del frontend).
 *
 * Le schede nel formato nuovo e i dati di letteratura da cui escono i numeri
 * del POS. Fallisce se:
 *  1) un gruppo CPT del rumore non torna più: L_EX,8h ricalcolato dalle
 *     attività ≠ valore stampato nella fonte (±0,3 dB), o le % non fanno 100;
 *  2) un attrezzo delle vibrazioni non ha valore, o i calcoli A(8) e i minuti
 *     non seguono le formule dell'art. 201 / Allegato XXXV;
 *  3) una scheda nuova ha un rischio senza misure, un residuo più alto del
 *     rischio iniziale, un riferimento (gruppo, attrezzo, sostanza, cartello,
 *     DPI, formazione) che non esiste;
 *  4) i campi vecchi (rischi, misure) non coincidono con quelli nuovi.
 * Nessun accesso al DB.
 */
'use strict';
const S = require('../lib/lavorazioniSchede');
const F = require('../lib/schedeFonti');
const { AGENTI, SEGNALI } = require('../lib/schedeV2/cataloghi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

console.log('\n\x1b[1mF-350 — Dati delle fonti\x1b[0m');
const lexRaw = (att) => 10 * Math.log10(att.reduce((s, [, l, p]) => s + (p / 100) * 10 ** (l / 10), 0));
const nonTornano = F.RUMORE_GRUPPI.filter(g => Math.abs(lexRaw(g.attivita) - g.lexFonte) > 0.3).map(g => `${g.id}: ${lexRaw(g.attivita).toFixed(2)} vs ${g.lexFonte}`);
check(`${F.RUMORE_GRUPPI.length} gruppi CPT: L_EX ricalcolato = stampato (±0,3 dB)`, nonTornano.length === 0, nonTornano);
const pct = F.RUMORE_GRUPPI.filter(g => g.attivita.reduce((s, a) => s + a[2], 0) !== 100).map(g => g.id);
check('in ogni gruppo le percentuali fanno 100', pct.length === 0, pct);
check('almeno 30 gruppi CPT', F.RUMORE_GRUPPI.length >= 30, F.RUMORE_GRUPPI.length);
check('id dei gruppi unici', new Set(F.RUMORE_GRUPPI.map(g => g.id)).size === F.RUMORE_GRUPPI.length);
check('fasce: 80 → nessun obbligo, 85 → 80–85, 86 → 85–87, 88 → oltre 87',
  F.fasciaRumore(80).classe === 0 && F.fasciaRumore(85).classe === 1 && F.fasciaRumore(86).classe === 2 && F.fasciaRumore(88).classe === 3);
check('vibrazioni: ogni attrezzo ha a_hv > 0 e la tabella ISPESL', F.VIB_ATTREZZI.every(([, , a, , , t]) => a > 0 && /^A\/[1-6]$/.test(t)));
check('A(8) di 11 m/s² al 25% = 5,5 m/s²', F.a8([{ a: 11, pct: 25 }]) === 5.5, F.a8([{ a: 11, pct: 25 }]));
check('A(8) composto: 25 m/s² al 5% e 11 m/s² al 25% = 7,84 m/s²', F.a8([{ a: 25, pct: 5 }, { a: 11, pct: 25 }]) === 7.84);
check('14 m/s²: valore d\'azione in 15 min, limite in 61 min', F.minutiFino(2.5, 14) === 15 && F.minutiFino(5, 14) === 61, [F.minutiFino(2.5, 14), F.minutiFino(5, 14)]);
const gvErr = F.VIB_GRUPPI.flatMap(g => Object.values(g.uso).flat().filter(([id, p]) => !F.attrezzoVib(id) || !(p > 0 && p <= 100)).map(([id]) => `${g.id}: ${id}`));
check('gruppi CPT delle vibrazioni: attrezzi esistenti, percentuali tra 1 e 100', gvErr.length === 0, gvErr);

console.log('\n\x1b[1mF-350 — Schede nel formato nuovo\x1b[0m');
const v2 = S.SCHEDE.filter(s => s.v2);
check(`almeno le 3 schede del modello (${v2.length})`, ['ponteggio-montaggio', 'getto-calcestruzzo', 'demolizioni-interne'].every(id => S.getScheda(id)?.v2));
const err = [];
const attivitaNote = new Set(F.RUMORE_GRUPPI.flatMap(g => g.attivita.map(a => a[0])));
for (const s of v2) {
  const e = (m) => err.push(`${s.id}: ${m}`);
  if (!Array.isArray(s.valutazione) || s.valutazione.length < 3) e('meno di 3 rischi');
  for (const x of s.valutazione || []) {
    if (![x.p, x.d, x.pr, x.dr].every(n => [1, 2, 3, 4].includes(n))) e(`P/D fuori 1–4: ${x.r}`);
    if (x.pr * x.dr > x.p * x.d) e(`residuo più alto del rischio: ${x.r}`);
    if (!Array.isArray(x.m) || !x.m.length) e(`rischio senza misure: ${x.r}`);
    if (x.psc != null && !x.m[x.psc]) e(`misura PSC inesistente: ${x.r}`);
  }
  if (!s.mansioni?.length) e('nessuna mansione');
  if (!s.checklist?.prima?.length || !s.checklist?.durante?.length || !s.checklist?.dopo?.length) e('controlli del preposto incompleti');
  if (!s.emergenze?.length) e('nessuna emergenza');
  if (!s.psc?.interferenze?.length || !s.psc?.apprestamenti?.length) e('blocco PSC incompleto');
  for (const g of s.rumore?.gruppi || []) if (!F.gruppoRumore(g)) e(`gruppo rumore inesistente: ${g}`);
  for (const a of s.rumore?.attivita || []) if (!attivitaNote.has(a)) e(`attività rumore inesistente: ${a}`);
  for (const a of s.vibrazioni?.attrezzi || []) if (!F.attrezzoVib(a)) e(`attrezzo vibrazioni inesistente: ${a}`);
  for (const g of s.vibrazioni?.gruppi || []) if (!F.VIB_GRUPPI.some(x => x.id === g)) e(`gruppo vibrazioni inesistente: ${g}`);
  for (const x of s.sostanze || []) if (!AGENTI[x]) e(`sostanza inesistente: ${x}`);
  for (const c of s.segnaletica || []) if (!SEGNALI[c]) e(`cartello non nell'elenco verificato: ${c}`);
  for (const d of s.dpi) if (!S.DPI[d]) e(`DPI inesistente: ${d}`);
  for (const f of s.formazione) if (!S.FORMAZIONE[f]) e(`formazione inesistente: ${f}`);
  // campi vecchi ricavati
  if (JSON.stringify(s.rischi) !== JSON.stringify(s.valutazione.map(x => [x.r, x.p, x.d]))) e('rischi vecchi non ricavati dalla valutazione');
  if (s.misure.length !== new Set(s.valutazione.flatMap(x => x.m)).size) e('misure vecchie non ricavate');
}
check('schede nuove complete e con riferimenti validi', err.length === 0, err);
check('cartelli: solo codici ISO 7010 nel formato giusto', Object.keys(SEGNALI).every(c => /^[PWMEF]\d{3}$/.test(c)));
check('sostanze cancerogene con frase o allegato del cancerogeno', Object.values(AGENTI).filter(a => a.cancerogeno).every(a => /H350|XLII/.test(a.pericoli)));

(async () => {
  console.log('\n\x1b[1mF-350 — Sezione 5 del POS con le schede nuove\x1b[0m');
  const { composeSezione5 } = require('../lib/posSezione5');
  const { generatePosHtml } = require('../pos-html-generator');
  const s5 = composeSezione5(['ponteggio-montaggio', 'getto-calcestruzzo', 'demolizioni-interne', 'intonaci']);
  const md = s5.markdown;
  check('in testa: esposizione al rumore per gruppo omogeneo (5.1)', /^### 5\.1 Esposizione al rumore per gruppo omogeneo/m.test(md));
  check('rumore in decibel con fascia e obblighi (manovale 90,1 dB(A), oltre 87)', /\| Manovale \|[^\n]*\| \*\*90,1\*\* \| oltre 87 dB\(A\) \|/.test(md));
  check('vibrazioni per attrezzo con il tempo massimo (vibratore: 1 h 1 min)', /Vibratore per calcestruzzo ad immersione \| 14 ± 8 \| 15 min \| \*\*1 h 1 min\*\*/.test(md));
  check('A(8) del gruppo demolizioni nelle ristrutturazioni = 7,84, oltre il limite', /Operaio addetto alle demolizioni \| Ristrutturazioni \|[^\n]*\| \*\*7,84\*\* \| Supera il valore limite/.test(md));
  check('ogni rischio della scheda nuova accanto alle sue misure e al residuo', /\| Colpo di frusta del tubo terminale o scoppio di una tubazione \| 2 \| 3 \| 6 \| Tubo terminale guidato[^|]*\| 3 \|/.test(md));
  check('scheda nel formato di prima (intonaci) ancora presente', /^### Intonaci/m.test(md) && /Rischi identificati e valutazione/.test(md));
  check('senza schede nuove: niente tabelle di esposizione', !/5\.1 Esposizione/.test(composeSezione5(['intonaci']).markdown));

  const html = await generatePosHtml({ siteAddress: 'Via Prova 1', companyName: 'Impresa', rumore: 'Tra 80 e 85 dB(A)', selectedSchede: ['demolizioni-interne'] }, 1, composeSezione5(['demolizioni-interne']).markdown, []);
  check('4.9 rimanda al calcolo della 5.1 invece della risposta data a mano', /valutata per gruppo omogeneo, con dati di letteratura, nella Sezione 5\.1/.test(html) && !/<p>Tra 80 e 85 dB\(A\)<\/p>/.test(html));
  const htmlVecchio = await generatePosHtml({ siteAddress: 'Via Prova 1', companyName: 'Impresa', rumore: 'Tra 80 e 85 dB(A)' }, 1, '', []);
  check('POS senza schede nuove: 4.9 con la risposta di prima', /<p>Tra 80 e 85 dB\(A\)<\/p>/.test(htmlVecchio));
  check('tabelle con larghezze proporzionali (colonna P stretta, misure larga)', /<th style="width:6%;white-space:nowrap">P<\/th>/.test(html) && /<th style="width:(4\d|5\d)%">Misure di prevenzione e protezione<\/th>/.test(html));

  const PC = require('../lib/posPdfContenuti');
  const t10 = PC.tabellaSostanze({ selectedSchede: ['demolizioni-interne', 'getto-calcestruzzo'], sostanze: ['Nessuna'] });
  check('10.2: silice cristallina aggiunta dalle schede, con valore limite e registro degli esposti', /silice cristallina/.test(t10) && /0,1 mg\/m³/.test(t10) && /art\. 243/.test(t10));
  check('10.2: cemento aggiunto dal getto anche se in /pos/crea è stato scelto «Nessuna»', /Cemento, malte e calce/.test(t10));
  check('10.2: l\'amianto da verificare non diventa una «sostanza impiegata»', !/amianto/i.test(t10));

  console.log('\n\x1b[1mF-350 — PSC: una misura per rischio, più il coordinamento\x1b[0m');
  const L = require('../lib/psc/lavorazioni');
  const getto = S.getScheda('getto-calcestruzzo');
  const lg = L.fromScheda('getto-calcestruzzo');
  check(`getto: ${getto.valutazione.length} rischi → ${getto.valutazione.length} misure prescritte + ${getto.psc.interferenze.length} di coordinamento (non ${getto.misure.length})`,
    lg.misure.length === getto.valutazione.length + getto.psc.interferenze.length, lg.misure.length);
  check('la misura prescritta è quella indicata per il PSC', lg.misure.some(m => m.testo === getto.valutazione[0].m[getto.valutazione[0].psc ?? 0]));
  check('prescrizioni di coordinamento sulle interferenze tipiche', lg.misure.some(m => /un solo mezzo per volta sul getto/.test(m.testo)));
  check('tutte da approvare dal coordinatore', lg.misure.every(m => m.approvata === false && m.fonte === 'palladia'));
  check('scheda nel formato di prima: tutte le sue misure come prima', L.fromScheda('intonaci').misure.length === S.getScheda('intonaci').misure.length);

  console.log(`\n  ${passed} passati, ${failed} falliti\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
