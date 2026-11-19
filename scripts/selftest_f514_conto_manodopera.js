#!/usr/bin/env node
/**
 * scripts/selftest_f514_conto_manodopera.js — F-514 (AUDIT.md del frontend, 19/11/2026).
 *
 * Il costo della manodopera del mese, voce per voce dal prospetto contabile
 * (lib/quantoRende.js). Il 18/11 il totale era lorde + oneri ditta e basta;
 * il 19/11 la quadratura dare/avere ha mostrato cosa c'è dentro e cosa manca.
 * Controlla:
 *   1. lettura per codice (sezione GENERALE, co.co.co. a parte, TFR del mese);
 *   2. il conto: + TFR, + altri contributi ditta (W1004), + 13ª/14ª e ferie
 *      maturate (crescita delle Z dal mese prima); NON si aggiunge la Cassa
 *      Edile NA100-104 (già dentro le lorde); malattia INPS e CIG fuori;
 *      INAIL dichiarato fuori; senza il mese prima le voci mancanti si dicono;
 *   3. l'amministratore (IMP.LE F.A.P.) prende il costo del co.co.co., non
 *      una parte di quello degli operai;
 *   4. spese generali divise in parti misurate (ufficio per nome, magazzino,
 *      ore pagate e non timbrate in cantiere) che tornano al totale;
 *   5. dal vivo su MSC ottobre 2026: 59.829 + 4.628 = 64.458 €, «stima».
 */
'use strict';
require('dotenv').config({ quiet: true });
const Q = require('../lib/quantoRende');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const vicino = (a, b, t = 0.6) => typeof a === 'number' && Math.abs(a - b) < t;

// Righe vere del prospetto contabile di ottobre 2026 di MSC (Centro Paghe), solo i totali d'impresa
const OTT = `--- Pagina 1 ---
DIPENDENTE DIPENDENTI (NORM)
C1101 F.P.L.D. 15,00 35938,00 8556,85 3302,69
C1102 ASPI 15,00 35938,00 143,74
C1103 FONDO GARANZIA 15,00 35938,00 71,88
C1105 CASSA INTEGR. 1,00 2051,00 96,40
C1122 MALATTIA OPE. 11,00 26928,00 597,80
C1161 CIG ED/LAP IMP 4,00 9010,00 153,17
C1162 CIG ED/LAP OPE 11,00 26928,00 1265,62
C1209 F.P.L.D APP.24 1,00 2051,00 61,53 119,78
C1215 ASPI APP. 1,00 2051,00 26,87
C1222 ASPI FORM. 15,00 35938,00 107,82
C1224 ASPI APP.FORM. 1,00 2051,00 6,15
C7705 C.EDILE 12,00 21299,81 1642,23 319,51
C7802 F.DO SANIT. 12,00 19954,82 119,73
C7804 F.DO SANIT. 4,00 8662,09 22,53
C7818 FAQS FONDO ART 16,00 16,00 32,00
CARRD ARR. CONTR. DIPENDENTI ( 0,50
CCEDI CONTR. CONTRATT. EDILI 16,00 183,25
CMAPE CONTRIBUZIONE MINIMA APE 2,00 5,57
CMSAN CONTRIBUZIONE MINIMA SAN 2,00 11,46
CPRES PRESTAZIONI (DM10) 2,00 1855,68
CRECU REC. PREST./ONERI ENTI P 1,00 1949,19
CSOLI CONTR. SOLID. 10% (DM10) 33,69
--- Pagina 2 ---
DIPENDENTE DIPENDENTI (NORM)
R0042 ONERI CONTR 15087,48
R0001 I.LE INAIL 35938,00
R0004 IMP.LE TFR 38105,27
R0006 TFR ACCANT. 2643,86
--- Pagina 6 ---
DIPENDENTE CO.CO.CO. (NORM)
C1150 F.P.L.D. COLLAB. 1,00 3990,00 638,40 319,20
CARRC ARR. CONTR. 0,40
R0006 TFR ACCANT. 0,00
--- Pagina 8 ---
PROSPETTO CONTABILE
PERIODO LIQUIDAZIONE
TIPO SUDDIVISIONE PROSPETTO CDC 1 CDC 2 CDC 3 ALTRA SUDD.
GENERALE
COD. CONTO DESCRIZIONE DARE AVERE
N0100 Retribuzioni lorde 38.471,53
N0127 Rimborsi spese/km 72,00
N0310 Anticipazioni c/c.i.g. 756,16
N0359 Indennita' malattia INPS 1.855,68
N0420 Anticipo ditta mal/inf 474,32
N0700 Contr. Dip. INPS 3.422,47
NA100 Accant. cassa edile/Ceav 2.859,02
NA101 Accant. fest. cassa edile/Ceav 165,56
NA103 Acc. mal/inf cassa edile/Ceav 392,00
NA104 Arr. accant. cassa edile/Ceav 0,42
NC704 Bonus L.207/2024 (1704) 909,40
NLTBE Totale bonus L.207/2024 909,40-
NZ100 Arrotondamento retribuzioni 8,29 9,49
NZTOT Totale a pareggio 42.547,38 42.547,38
================ Oneri ditta ================
D0100 Oneri prev.li INPS Ditta 13.070,71
D0745 Contributo contrattuale edili 183,25
D0752 Ragg. ctr.one minima A.P.E. 5,57
D0753 Ragg. ctr.one minima SANEDIL 11,46
D7705 Contr.Ditta C.EDILE 1.642,23
DZTOT Totale oneri ditta 15.087,48
================ Versamenti =================
W1004 Altri contr. carico ditta 200,28
Centro Paghe S.r.l. - www.centropaghe.it
--- Pagina 9 ---
PROSPETTO CONTABILE
TIPO SUDDIVISIONE PROSPETTO CDC 1 CDC 2 CDC 3 ALTRA SUDD.
GENERALE
COD. CONTO DESCRIZIONE DARE AVERE
WE300 Accant. cassa edile/Ceav 3.417,00
Z0008 Rivalutaz. provv. ditta mm/aa 168,38 2.007,98
Z0032 TFR ditta anno corr. 25.477,16
Z0071 Residuo ferie a.c. 4.442,04
Z0073 Contributi su ferie a.c. 1.184,70
Z0074 Residuo ferie a.p. 474,98
Z0076 Contributi su ferie a.p. 126,68
Z0077 Residuo rol a.c. 3.108,73
Z0079 Contributi su rol a.c. 829,09
Z0080 Residuo rol a.p. 1.433,76
Z0082 Contributi su rol a.p. 382,38
Z0101 Residuo riposi a.c. 7.550,77
Z0102 Residuo riposi a.p. 1.908,74
Z0103 Contributi su residuo riposi 2.522,85
Z0104 Gratifica natalizia 6.712,51
Z0105 Contrib. su gratif. natalizia 1.790,22
Z0106 Quattordicesima 2.684,99
Z0107 Contrib. su quattordicesima 716,09
--- Pagina 10 ---
PROSPETTO CONTABILE
TIPO SUDDIVISIONE PROSPETTO CDC 1 CDC 2 CDC 3 ALTRA SUDD.
COLLABORATORI COORDINATI CONTINUATIVI
COD. CONTO DESCRIZIONE DARE AVERE
N0103 Compensi 3.990,00
DZTOT Totale oneri ditta 638,40
--- Pagina 11 ---
PROSPETTO CONTABILE
TIPO SUDDIVISIONE PROSPETTO CDC 1 CDC 2 CDC 3 ALTRA SUDD.
GENERALE + CO.CO.CO.
COD. CONTO DESCRIZIONE DARE AVERE
N0100 Retribuzioni lorde 38.471,53
DZTOT Totale oneri ditta 15.725,88
`;
// Settembre 2026: solo le righe Z che servono per la crescita del mese
const SET = `PROSPETTO CONTABILE
TIPO SUDDIVISIONE PROSPETTO CDC 1 CDC 2 CDC 3 ALTRA SUDD.
GENERALE
N0100 Retribuzioni lorde 39.391,33
DZTOT Totale oneri ditta 13.370,75
Z0032 TFR ditta anno corr. 22.833,30
Z0071 Residuo ferie a.c. 3.797,64
Z0073 Contributi su ferie a.c. 1.012,84
Z0074 Residuo ferie a.p. 474,98
Z0076 Contributi su ferie a.p. 126,68
Z0077 Residuo rol a.c. 3.071,95
Z0079 Contributi su rol a.c. 819,29
Z0080 Residuo rol a.p. 1.433,76
Z0082 Contributi su rol a.p. 382,38
Z0101 Residuo riposi a.c. 6.869,59
Z0102 Residuo riposi a.p. 1.908,74
Z0103 Contributi su residuo riposi 2.341,19
Z0104 Gratifica natalizia 6.041,25
Z0105 Contrib. su gratif. natalizia 1.611,19
Z0106 Quattordicesima 2.013,73
Z0107 Contrib. su quattordicesima 537,06
`;

async function main() {
  console.log('\nPalladia regression — F-514: il costo della manodopera voce per voce\n');

  // 1. Lettura
  const p = Q.leggiProspetto(OTT);
  check('lorde e oneri della sezione GENERALE (non «GENERALE + CO.CO.CO.»)', p && p.lorde === 38471.53 && p.oneri === 15087.48, p && { lorde: p.lorde, oneri: p.oneri });
  check('voci lette per codice (W1004, Z0104, malattia INPS)', p?.voci?.W1004 === 200.28 && p?.voci?.Z0104 === 6712.51 && p?.voci?.N0359 === 1855.68, p?.voci);
  check('riepilogo: solo i contributi dei dipendenti (le pagine del co.co.co. non entrano)', p?.contributi && p.contributi.C1150 == null && p.contributi.C7705 === 1642.23, p?.contributi);
  check('TFR del mese (R0006) e imponibile INAIL (R0001)', p?.tfrMese === 2643.86 && p?.imponibileInail === 35938, p && { tfr: p.tfrMese, inail: p.imponibileInail });
  check('co.co.co. a parte: compensi 3.990 + oneri 638,40', p?.cococo?.compensi === 3990 && p?.cococo?.oneri === 638.4, p?.cococo);
  const s = Q.leggiProspetto(SET);

  // 2. Il conto
  const c = Q.costoDelMese ? Q.costoDelMese(p, s) : null;
  const voce = (k) => c?.voci?.find(v => v.chiave === k);
  check('esiste il conto voce per voce (costoDelMese)', !!c);
  check('lorde 38.471,53 e oneri ditta 15.087,48', voce('lorde')?.importo === 38471.53 && voce('oneri')?.importo === 15087.48, c?.voci);
  check('+ TFR del mese 2.643,86', voce('tfr')?.importo === 2643.86, voce('tfr'));
  // 19/11: W1004 (200,28) = D0745 Prevedi 183,25 + APE 5,57 + Sanedil 11,46, già dentro DZTOT: contarlo era un doppio
  check('W1004 NON si aggiunge: è già dentro gli oneri ditta (Prevedi + APE + Sanedil)', !voce('altriContributi') && c?.fuori?.some(f => f.fonte === 'W1004' && /già/.test(f.perche)), c?.fuori);
  check('CRECU 1.949,19 dentro gli oneri ditta: resta nel conto ma è una domanda per il commercialista',
    c?.domande?.some(d => d.fonte === 'CRECU' && d.importo === 1949.19), c?.domande);
  check('contributi solo degli operai (Cassa Edile, CIG e malattia operai, apprendista): 3.816,33', vicino(c?.perGruppo?.operaio, 3816.33, 0.01), c?.perGruppo);
  check('solo degli impiegati: CIG e fondo sanitario impiegati + 13ª/14ª + ferie = 3.601,96', vicino(c?.perGruppo?.impiegato, 3601.96, 0.01), c?.perGruppo);
  check('+ 13ª e 14ª maturate con i contributi 1.700,58', vicino(voce('ratei')?.importo, 1700.58, 0.01), voce('ratei'));
  check('+ ferie, ROL e riposi maturati con i contributi 1.725,68 (da confermare)', vicino(voce('residui')?.importo, 1725.68, 0.01) && voce('residui')?.daConfermare, voce('residui'));
  check('la Cassa Edile NA100-104 NON si aggiunge (è già dentro le lorde)', !c?.voci?.some(v => /^NA1/.test(v.fonte || '')), c?.voci?.map(v => v.fonte));
  check('totale dipendenti 59.629,13', vicino(c?.totaleDipendenti, 59629.13, 0.01), c?.totaleDipendenti);
  check('malattia INPS, CIG, bonus e rimborsi km fuori dal conto, con il perché',
    ['N0359', 'N0310', 'NC704', 'N0127'].every(k => c?.fuori?.some(f => f.fonte === k && f.perche)), c?.fuori);
  check('«Anticipo ditta mal/inf» fra le cose da chiedere', c?.fuori?.some(f => f.fonte === 'N0420' && f.daChiedere), c?.fuori);
  check('INAIL dichiarato fuori con il suo imponibile', c?.inail?.compreso === false && c?.inail?.imponibile === 35938, c?.inail);
  check('amministratore (co.co.co.) 4.628,40', vicino(c?.amministratori, 4628.4, 0.01), c?.amministratori);
  check('totale del mese = dipendenti + amministratori', vicino(c?.totale, 59629.13 + 4628.4, 0.01), c?.totale);

  const c0 = Q.costoDelMese ? Q.costoDelMese(p, null) : null;
  check('senza il mese prima: 13ª/14ª e ferie «non calcolabili», conto segnato incompleto',
    c0 && c0.voci.find(v => v.chiave === 'ratei')?.importo === null && c0.incompleto === true && vicino(c0.totaleDipendenti, 38471.53 + 15087.48 + 2643.86, 0.01), c0);

  // 3. Ripartizione: l'amministratore non si prende una parte del costo degli operai
  const r = Q.ripartisci({
    lorde: 10000, costo: 14000, cococo: { compensi: 3000, oneri: 480 },
    imponibili: { a: { imp: 4000, tipo: 'FPLD' }, b: { imp: 6000, tipo: 'FPLD' }, amm: { imp: 3000, tipo: 'FAP' } },
  });
  check('operai: 14.000 divisi sull\'imponibile (5.600 + 8.400)', vicino(r.a?.costo, 5600) && vicino(r.b?.costo, 8400), r);
  check('amministratore: il costo del co.co.co. (3.480)', vicino(r.amm?.costo, 3480) && r.amm?.amministratore, r.amm);
  // 13ª e 14ª maturano solo per gli impiegati (gli operai edili le hanno dalla Cassa Edile, già nelle lorde)
  const r2 = Q.ripartisci({
    lorde: 10000, costo: 14000, perGruppo: { impiegato: 1000 },
    imponibili: { op: { imp: 6000, tipo: 'FPLD', qualifica: 'operaio' }, imp: { imp: 4000, tipo: 'FPLD', qualifica: 'impiegato' } },
  });
  check('13ª/14ª (1.000) tutte all\'impiegato: operaio 13.000 × 60% = 7.800, impiegato 5.200 + 1.000', vicino(r2.op?.costo, 7800) && vicino(r2.imp?.costo, 6200), r2);
  const r3 = Q.ripartisci({
    lorde: 10000, costo: 14000, perGruppo: { operaio: 1300, impiegato: 700 },
    imponibili: { op: { imp: 6000, tipo: 'FPLD', qualifica: 'operaio' }, imp: { imp: 4000, tipo: 'FPLD', qualifica: 'impiegato' } },
  });
  check("contributi per categoria: comune 12.000 diviso 7.200/4.800, + 1.300 all'operaio, + 700 all'impiegato", vicino(r3.op?.costo, 8500) && vicino(r3.imp?.costo, 5500), r3);
  check('qualifica letta dalla busta (OPERAIO / IMP P.TIME / CO.CO.CO.)',
    Q.leggiImponibileTipo('QUALIFICA INPS 1 OPERAIO(A) TIPO RAPPORTO IMP.LE F.P.L.D. 2655,00')?.qualifica === 'operaio'
    && Q.leggiImponibileTipo('QUALIFICA INPS Y IMP P.TIME TIPO RAPPORTO IMP.LE F.P.L.D. 1500,00')?.qualifica === 'impiegato'
    && Q.leggiImponibileTipo('QUALIFICA INPS 5 APP.OPERAIO TIPO RAPPORTO IMP.LE F.P.L.D 2051,00')?.qualifica === 'operaio'
    && Q.leggiImponibileTipo('QUALIFICA INPS CO.CO.CO. TIPO RAPPORTO IMP.LE F.A.P. 3990,00')?.qualifica === 'amministratore');

  // 4. Spese generali divise in parti misurate
  const conto = Q.contoMese({
    persone: [
      { id: 'a', nome: 'Operaio A', costo: 3360, perCantiere: { s1: 60 * 80, mag: 60 * 20 } }, // 20 €/h, 168 h di contratto
      { id: 't', nome: 'Tecnico T', costo: 5000, perCantiere: {} },
    ],
    cantieri: { s1: 'Via Balbi 31', mag: 'Magazzino MSCedilizia' },
    giorniLavorativi: 21, oreGiornoMin: 480, costoMese: 8360,
  });
  const g = conto.generali;
  check('ufficio: chi non lavora nei cantieri, per nome (Tecnico T 5.000)', g?.ufficio?.length === 1 && g.ufficio[0].nome === 'Tecnico T' && g.ufficio[0].costo === 5000, g);
  check('magazzino: 20 h × 20 €/h = 400', g?.magazzino === 400, g);
  check('ore pagate e non timbrate in cantiere (ferie, pioggia, permessi): 68 h × 20 = 1.360', g?.nonInCantiere === 1360, g);
  const somma = g ? g.ufficio.reduce((x, u) => x + u.costo, 0) + g.magazzino + g.nonInCantiere + (g.nonAttribuito || 0) : -1;
  check('le parti tornano alle spese generali', somma === conto.speseGenerali, { somma, speseGenerali: conto.speseGenerali });

  // 5. Dal vivo
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip controlli dal vivo: Supabase non configurato');
  } else {
    const ott = await Q.quantoRendeMese('309e9018-1bcc-4876-9430-99cb89e043dd', '2026-10');
    check('MSC ottobre: 64.258 € (59.629 dipendenti + 4.628 amministratore), INAIL escluso', ott.pronto && ott.costoMese === 64258, ott.costoMese);
    check('MSC ottobre: è una stima finché il commercialista non conferma', ott.stima === true && ott.verificatoCommercialista === false, { stima: ott.stima });
    check('MSC ottobre: totale = cantieri + spese generali', ott.aiCantieri + ott.speseGenerali === ott.costoMese, ott);
    const gg = ott.generali;
    const sg = gg ? gg.ufficio.reduce((x, u) => x + u.costo, 0) + gg.magazzino + gg.nonInCantiere + (gg.nonAttribuito || 0) : -1;
    check('MSC ottobre: le parti delle spese generali tornano', sg === ott.speseGenerali, { sg, sp: ott.speseGenerali });
    check('MSC ottobre: in ufficio le 5 persone senza timbrature, con il nome', gg?.ufficio?.length === 5 && gg.ufficio.every(u => u.nome && u.nome !== 'Senza nome'), gg?.ufficio);
    check('MSC ottobre: le voci del conto viaggiano con il risultato', ott.conto?.voci?.length >= 5 && ott.conto?.inail?.compreso === false, ott.conto);
    // La memoria dei mesi: un conto fatto con la formula vecchia (senza versione) non si riusa
    const supabase = require('../lib/supabase');
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    await supabase.from('quanto_rende_mesi').upsert({ company_id: CO, mese: '2026-10', risultato: { ...ott, costoMese: 53559, versione: undefined }, calcolato_at: new Date().toISOString() });
    const ric = await Q.quantoRendeMeseRicordato(CO, '2026-10');
    check('memoria: il conto vecchio di 18/11 (53.559) si rifà con la formula nuova', ric.costoMese === 64258 && ric.versione >= 3, { costoMese: ric.costoMese, versione: ric.versione });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
