#!/usr/bin/env node
/**
 * scripts/selftest_f506_f507_documenti_impresa.js
 *
 * Regressione per F-506 e F-507 (AUDIT.md del frontend, 18/11/2026).
 *
 * F-506: in Documenti › impresa di MSC c'erano 13 «Documento senza nome».
 * Erano prospetti paghe del commercialista (prospetto contabile, fondi
 * pensione, TFR) importati con «Importa cartella», salvati col nome «altro»
 * e visibili a tecnici e coordinatori. Il riconoscimento delle paghe non li
 * vedeva.
 *   1. sembraPaghe riconosce prospetto contabile, dettaglio fondi e TFR, ma
 *      non DURC, visura, DVR né un contratto che nomina il TFR.
 *   2. Un documento non si salva mai col codice del tipo come nome
 *      («altro», «busta_paga»): si usa il nome del file.
 *   3. Dal vivo: nessun documento delle imprese vere ha un codice come nome, e
 *      nessun PDF di Documenti › impresa è un prospetto paghe.
 *
 * F-507: le scadenze dei documenti d'impresa non venivano lette. La lettura
 * partiva una volta sola e, se falliva, nessuno la ritentava.
 *   4. La lettura salva il tipo riconosciuto se il documento era «altro»
 *      (mai se il titolare ne aveva già scelto uno), e il prompt conosce i
 *      rinnovi di RSPP e RLS.
 *   5. C'è la rilettura: lib/documentiRilettura.js trova i documenti non
 *      letti e un lavoro programmato la fa girare ogni giorno.
 *   6. Dal vivo: nessun PDF o immagine d'impresa o di cantiere delle imprese
 *      vere, caricato da più di 2 giorni, è ancora senza lettura e senza
 *      scadenza.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const PROVA = /^(test|e2e)|test-|f184|prova|autoexplore/i;
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

// Testi presi (accorciati) dalle pagine vere del commercialista di MSC
const CONTABILE = 'PROSPETTO CONTABILE PERIODO LIQUIDAZIONE Pag. 1 LUGLIO 2026 COD. DITTA RAGIONE SOCIALE CI10119 MSC EDILIZIA SRL TIPO SUDDIVISIONE PROSPETTO COD. CONTO DESCRIZIONE DARE AVERE N0100 Retribuzioni lorde 40.785,65 N0359 Indennita\' malattia INPS NC Irpef ================ Oneri ditta ================ D Oneri prev.li INPS Ditta DZTOT Totale oneri ditta W Totale contr. Dipendente';
const FONDI = '(07/08/2026 14:47 BPYSDFPC) PAG. ENTE: 5633 FONDO NEGOZIALE Ctr.assic. Quota TFR C.F. Ctr. dit. Ctr. dip. FPC COVIP MSC EDILIZIA SRL PROGRESSIVO VERSAMENTO PROSPETTO DETTAGLIO FONDI CI10119 MENSILE - GRUPPO 1';
const TFR = '(07/08/2026 14:47 BPYSDTFR) PAG. FPC F.do TES. Azienda Azie./QUIR TFR mat. MSC EDILIZIA SRL Nominativo TOTALI AZIENDA: RIEPILOGO TFR MATURATO: TOTALI FPC: = Si dispone che il TFR maturando rimanga in azienda PROSPETTO DETTAGLIO QUOTE TFR/FPC Destinazione TFR in AZIENDA';
const DURC = 'DURC DOCUMENTO UNICO DI REGOLARITA CONTRIBUTIVA Numero Protocollo INAIL_12345 Data richiesta 12/06/2026 Scadenza validita 10/10/2026 Denominazione MSC EDILIZIA SRL RISULTA REGOLARE nei confronti di I.N.P.S. I.N.A.I.L. CNCE';
const VISURA = 'Camera di Commercio VISURA ORDINARIA SOCIETA DI CAPITALE MSC EDILIZIA SRL Codice fiscale e n. iscr. al Registro Imprese Forma giuridica societa a responsabilita limitata Data atto di costituzione Attivita prevalente costruzione di edifici residenziali e non residenziali addetti 16';
const DVR = 'DOCUMENTO DI VALUTAZIONE DEI RISCHI art. 17 e 28 D.Lgs. 81/2008 MSC EDILIZIA SRL datore di lavoro RSPP medico competente RLS valutazione del rischio rumore vibrazioni movimentazione manuale dei carichi';
const CONTRATTO = 'CONTRATTO DI SUBAPPALTO tra MSC EDILIZIA SRL e ROSSI IMPIANTI SRL Il subappaltatore si impegna a corrispondere ai propri dipendenti retribuzione, contributi e TFR secondo il CCNL edilizia; trattamento economico non inferiore';

async function main() {
  console.log('\nPalladia regression — F-506/F-507: documenti dell\'impresa senza nome e senza scadenza\n');
  const { sembraPaghe } = require('../lib/bustePaga/riconosci');

  // 1. Riconoscimento dei prospetti
  check('prospetto contabile del commercialista = paghe', sembraPaghe(CONTABILE).paghe, sembraPaghe(CONTABILE));
  check('mese del prospetto contabile letto (luglio 2026)', JSON.stringify(sembraPaghe(CONTABILE).periodo) === '{"anno":2026,"mese":7}', sembraPaghe(CONTABILE).periodo);
  check('dettaglio fondi pensione (FPC) = paghe', sembraPaghe(FONDI).paghe, sembraPaghe(FONDI));
  check('riepilogo TFR maturato = paghe', sembraPaghe(TFR).paghe, sembraPaghe(TFR));
  for (const [n, t] of [['DURC', DURC], ['visura', VISURA], ['DVR', DVR], ['contratto che nomina il TFR', CONTRATTO]]) {
    check(`${n}: non è paghe`, !sembraPaghe(t).paghe, sembraPaghe(t));
  }

  // 2. Mai il codice del tipo come nome
  const dc = require('../lib/documentCategory');
  check('lib/documentCategory esporta nomeLeggibile', typeof dc.nomeLeggibile === 'function');
  if (typeof dc.nomeLeggibile === 'function') {
    const n1 = dc.nomeLeggibile('altro', 'CI10119@01@AZIENDA.PDF (pag. 39-44)');
    check('«altro» + file del commercialista → nome del file', n1 === 'CI10119@01@AZIENDA (pag. 39-44)', n1);
    check('«busta_paga» → nome del file', dc.nomeLeggibile('busta_paga', 'scan001.pdf') === 'scan001', dc.nomeLeggibile('busta_paga', 'scan001.pdf'));
    check('un nome vero resta com\'è', dc.nomeLeggibile('Attestato RSPP Catalano', 'x.pdf') === 'Attestato RSPP Catalano');
    check('senza nome e senza file → «Documento»', dc.nomeLeggibile('altro', '') === 'Documento');
  }
  const pipe = fs.readFileSync(path.join(__dirname, '../services/smartImportPipeline.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../services/chatDocumentAnalysis.js'), 'utf8');
  check('Importa cartella: il nome passa da nomeLeggibile', /nomeLeggibile\(/.test(pipe));
  check('archiveChatUpload (Importa cartella, Ladia, /carica): il nome passa da nomeLeggibile', /nomeLeggibile\(/.test(chat));

  // 4. Lettura: tipo riconosciuto e rinnovi
  const ai = require('../services/documentAI');
  check('documentAI esporta patchLettura', typeof ai.patchLettura === 'function');
  if (typeof ai.patchLettura === 'function') {
    const p1 = ai.patchLettura({ doc_type_detected: 'soa', expiry_date: '2029-03-01' }, 'company_documents', 'altro');
    check('«altro» letto come SOA → categoria soa', p1.category === 'soa' && p1.ai_expiry_date === '2029-03-01', p1);
    const p2 = ai.patchLettura({ doc_type_detected: 'iso' }, 'company_documents', 'dvr');
    check('categoria scelta dal titolare non si tocca', p2.category === undefined, p2);
    const p3 = ai.patchLettura({ doc_type_detected: 'rspp' }, 'site_documents', 'altro');
    check('tipo non ammesso nella tabella → resta «altro»', p3.category === undefined, p3);
    check('la lettura riuscita segna ai_analyzed_at', !!p1.ai_analyzed_at);
  }
  const src = fs.readFileSync(path.join(__dirname, '../services/documentAI.js'), 'utf8');
  check('il prompt conosce il rinnovo RSPP (5 anni) e RLS (1 anno)', /RSPP[^\n]*5 anni/i.test(src) && /RLS[^\n]*1 anno/i.test(src));

  // 5. Rilettura
  let ril = null;
  try { ril = require('../lib/documentiRilettura'); } catch { /* manca */ }
  check('lib/documentiRilettura esiste con daRileggere e rileggi', !!ril && typeof ril.daRileggere === 'function' && typeof ril.rileggi === 'function');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  check('server.js fa partire il lavoro di rilettura', /startDocumentiRiletturaCron\(\)/.test(server));

  // 3 e 6. Dal vivo
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip controlli dal vivo: Supabase non configurato');
  } else {
    const supabase = require('../lib/supabase');
    const { controllaFile } = require('../lib/bustePaga/riconosci');
    const cos = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await supabase.from('companies').select('id, name').range(f, f + 999);
      cos.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    const vere = new Set(cos.filter(c => !PROVA.test(c.name || '')).map(c => c.id));
    const docs = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await supabase.from('documents')
        .select('id, company_id, source_table, name, mime_type, bucket, file_path, ai_analyzed_at, expiry_date, ai_expiry_date, created_at')
        .is('deleted_at', null).not('source_table', 'in', '(payslips,studio_document_requests,ladia_document_templates)').range(f, f + 999);
      if (error) throw new Error(error.message);
      docs.push(...data); if (data.length < 1000) break;
    }
    const mie = docs.filter(d => vere.has(d.company_id));
    const codici = mie.filter(d => /^[a-z_]+$/.test(String(d.name || '').trim()));
    check(`nessun documento delle imprese vere ha un codice come nome (${mie.length} guardati)`, codici.length === 0, codici.map(d => `${d.source_table}:${d.id}:${d.name}`));

    const impresaPdf = mie.filter(d => d.source_table === 'company_documents' && /pdf/i.test(d.mime_type || '') && d.file_path);
    const paghe = [];
    for (let i = 0; i < impresaPdf.length; i += 8) {
      await Promise.all(impresaPdf.slice(i, i + 8).map(async d => {
        const { data: b } = await supabase.storage.from(d.bucket || 'site-documents').download(d.file_path);
        if (b && (await controllaFile(Buffer.from(await b.arrayBuffer()), 'application/pdf', 'x.pdf')).paghe) paghe.push(d.id);
      }));
    }
    check(`nessun PDF di Documenti › impresa è un prospetto paghe (${impresaPdf.length} letti)`, paghe.length === 0, paghe);

    const dueGiorniFa = new Date(Date.now() - 2 * 86400000).toISOString();
    const nonLetti = mie.filter(d => ['company_documents', 'site_documents'].includes(d.source_table)
      && /pdf|image\//i.test(d.mime_type || '') && !d.ai_analyzed_at && !d.expiry_date && !d.ai_expiry_date && d.created_at < dueGiorniFa);
    check('nessun documento d\'impresa o di cantiere resta senza lettura e senza scadenza', nonLetti.length === 0, nonLetti.map(d => `${d.source_table}:${d.name}`));
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
