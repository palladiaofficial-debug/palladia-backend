#!/usr/bin/env node
/**
 * scripts/selftest_psc_extract.js — F-259 (AUDIT.md del frontend).
 *
 * Percorso "Express" del POS: legge il PSC caricato nel cantiere. Qui senza
 * chiamare davvero l'AI (funzione iniettata), verifica:
 *  - il PSC di un altro cantiere o di un'altra azienda non si legge (404);
 *  - al modello arriva il testo del PDF con i separatori di pagina e il nome
 *    dell'impresa per cui si fa il POS;
 *  - la risposta del modello viene ricontrollata campo per campo: date in
 *    formato AAAA-MM-GG, orari HH:MM, pagine mai oltre la fine del documento,
 *    liste troncate, testi lunghi tagliati, tipi sbagliati scartati;
 *  - un documento che non è un PSC viene riconosciuto.
 * Lettura reale con l'AI: verificata a parte dal vivo (vedi AUDIT.md F-259).
 */
'use strict';
require('dotenv').config();
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { extractPsc, sanitizePsc } = require('../lib/pscExtract');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F259-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const pg = doc.addPage([595, 842]);
    lines.forEach((l, i) => pg.drawText(l, { x: 50, y: 790 - i * 18, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}
async function status(p) { try { await p; return 200; } catch (e) { return e.status || 500; } }

async function main() {
  console.log('\n\x1b[1mF-259 — lettura del PSC per il POS\x1b[0m');
  const filler = Array.from({ length: 30 }, (_, i) => `Riga descrittiva ${i + 1} del piano di sicurezza e coordinamento del cantiere.`);
  const pdf = await makePdf([
    ['PIANO DI SICUREZZA E COORDINAMENTO rev. 2', 'Committente: Condominio Test', ...filler],
    ['Coordinatore per l\'esecuzione: Geom. Paolo Test tel. 010 123456', ...filler],
    ['Fase: intonaci interni - impresa Sub Test', 'Procedura per uso ponteggio', ...filler],
  ]);
  const company = await ins('companies', { name: T });
  const other = await ins('companies', { name: `${T}-altra` });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-C`, address: 'Via 1', status: 'attivo' });
    const site2 = await ins('sites', { company_id: company.id, name: `${T}-C2`, address: 'Via 2', status: 'attivo' });
    const doc = await ins('site_documents', { company_id: company.id, site_id: site.id, name: 'PSC.pdf', category: 'psc', file_path: `${company.id}/${site.id}/psc.pdf`, file_size: pdf.length, mime_type: 'application/pdf' });
    const docOther = await ins('site_documents', { company_id: other.id, site_id: site.id, name: 'x.pdf', category: 'psc', file_path: 'x', file_size: 10, mime_type: 'application/pdf' });

    let seen = null;
    const ai = async (req) => {
      seen = req;
      return {
        e_un_psc: true, riferimento: 'PSC rev. 2', committente: 'Condominio Test',
        cse_nome: 'Geom. Paolo Test', cse_telefono: '010 123456',
        data_inizio: '15/09/2026', data_fine: '2027-03-20', orario_inizio: '7.30', orario_fine: '25:00', pausa_minuti: 30,
        importo_lavori: '€ 250.000,00',
        fasi_impresa: [{ titolo: 'Intonaci interni', pagina: 3 }, { titolo: 'Fase inventata', pagina: 99 }],
        richieste_per_impresa: Array.from({ length: 20 }, (_, i) => ({ titolo: `Richiesta ${i + 1}`, dettaglio: 'x'.repeat(1000), pagina: 3 })),
        rischi_interferenza: [{ titolo: 42 }, { titolo: 'Caduta materiali dall’alto', pagina: 2 }],
        pagine: { committente: 1, cse: 2, date: 7 },
      };
    };
    const download = async () => pdf;

    const out = await extractPsc(company.id, { siteId: site.id, documentId: doc.id, impresaName: 'Sub Test', lavori: 'Intonaci' }, { ai, download });
    check('al modello arriva il testo con i separatori di pagina', typeof seen.content === 'string' && seen.content.includes('--- Pagina 2 ---') && seen.content.includes('Paolo Test'), typeof seen.content === 'string' ? seen.content.slice(0, 200) : seen.content);
    check('al modello arriva l’impresa per cui si fa il POS', seen.system.includes('"Sub Test"') && seen.system.includes('Intonaci'));
    check('3 pagine lette dal testo', out.numPages === 3 && out.source === 'testo', { n: out.numPages, s: out.source });
    check('date normalizzate (15/09/2026 → 2026-09-15)', out.dataInizio === '2026-09-15' && out.dataFine === '2027-03-20', out);
    check('orari: 7.30 → 07:30, 25:00 scartato', out.orarioInizio === '07:30' && out.orarioFine === '', out);
    check('importo solo cifre', out.importo === '250.000,00', out.importo);
    check('pagina oltre la fine del documento → nessuna pagina', out.fasi[1].pagina === null && out.fasi[0].pagina === 3 && out.pagine.date === null && out.pagine.cse === 2, { fasi: out.fasi, pagine: out.pagine });
    check('richieste al massimo 12, dettagli tagliati', out.richieste.length === 12 && out.richieste[0].dettaglio.length <= 300, out.richieste.length);
    check('voci con tipo sbagliato scartate', out.interferenze.length === 1 && out.interferenze[0].titolo.startsWith('Caduta'), out.interferenze);
    check('CSE con telefono', out.cse.nome === 'Geom. Paolo Test' && out.cse.telefono === '010 123456', out.cse);

    check('PSC di un altro cantiere: 404', await status(extractPsc(company.id, { siteId: site2.id, documentId: doc.id }, { ai, download })) === 404);
    check('PSC di un’altra azienda: 404', await status(extractPsc(company.id, { siteId: site.id, documentId: docOther.id }, { ai, download })) === 404);
    check('documento che non è un PSC riconosciuto', sanitizePsc({ e_un_psc: false }, 3).isPsc === false && sanitizePsc({}, 3).isPsc === true);
    check('risposta vuota del modello: errore chiaro', await status(extractPsc(company.id, { siteId: site.id, documentId: doc.id }, { ai: async () => null, download })) === 502);
  } finally {
    for (const id of [company.id, other.id]) {
      await supabase.from('site_documents').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
