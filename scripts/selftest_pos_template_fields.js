#!/usr/bin/env node
/**
 * scripts/selftest_pos_template_fields.js — F-258 (AUDIT.md del frontend).
 *
 * Il nuovo percorso POS passa al documento nuovi dati: datore di lavoro,
 * impresa subappaltatrice e affidataria, lavori in quota, rumore, macchine,
 * sostanze, misure richieste dal PSC. Verifica che:
 *  - un POS "vecchio" (senza questi campi) non mostri nessuna delle nuove parti;
 *  - un POS nuovo le mostri, sia nel PDF (pos-html-generator) sia nel testo
 *    (pos-template);
 *  - il testo inserito dall'utente sia sempre escapato nel PDF.
 */
'use strict';
const { generatePosHtml } = require('../pos-html-generator');
const { buildPosDocument } = require('../pos-template');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); failed++; }
}

const base = { companyName: 'Impresa Test', companyVat: '01234567890', siteAddress: 'Via Test 1', client: 'Committente', workType: 'Ristrutturazione', rspp: 'RSPP', cse: 'CSE' };
const nuovo = {
  ...base,
  presentedBy: 'subappaltatore', affidatariaName: 'Affidataria Srl', datoreLavoro: 'Titolare <script>x</script>',
  lavoriInQuota: 'Sì, dal ponteggio', rumore: 'Tra 80 e 85 dB(A)',
  macchine: ['Impastatrice', 'Intonacatrice'], sostanze: ['Malte e cementi'],
  pscRef: 'PSC rev. 2', pscRichieste: [{ titolo: 'Uso del ponteggio dell’affidataria', dettaglio: 'Verifica prima dell’uso', pagina: 31 }],
};
const NEW_MARKERS = ['Impresa subappaltatrice', 'valutazione del rumore', 'richieste dal PSC', 'impiegate dall’impresa'.replace('’', "'"), 'Lavori in quota:'];

async function main() {
  console.log('\n\x1b[1mF-258 — nuovi dati nel documento POS\x1b[0m');
  const oldHtml = await generatePosHtml(base, 1, 'Rischi', []);
  const oldMd = buildPosDocument(base, 1, 'Rischi', []);
  check('POS vecchio (PDF): nessuna delle nuove parti', NEW_MARKERS.every(m => !oldHtml.includes(m)));
  check('POS vecchio (testo): nessuna delle nuove parti', ['Impresa subappaltatrice', 'valutazione del rumore', 'richieste dal PSC', '**Lavori in quota:**'].every(m => !oldMd.includes(m)));
  check('POS vecchio: il datore di lavoro resta la ragione sociale', oldHtml.includes('<td>Datore di Lavoro</td><td>Impresa Test</td>'));

  const html = await generatePosHtml(nuovo, 1, 'Rischi', []);
  const md = buildPosDocument(nuovo, 1, 'Rischi', []);
  check('PDF: impresa subappaltatrice e affidataria', html.includes('Impresa subappaltatrice') && html.includes('Affidataria Srl'));
  check('PDF: datore di lavoro con la ragione sociale, escapato', html.includes('Titolare &lt;script&gt;x&lt;/script&gt; (Impresa Test)') && !html.includes('<script>x</script>'));
  check('PDF: lavori in quota, rumore, macchine, sostanze', html.includes('Sì, dal ponteggio') && html.includes('Tra 80 e 85 dB(A)') && html.includes('Intonacatrice') && html.includes('Malte e cementi'));
  check('PDF: misure richieste dal PSC con pagina', html.includes('richieste dal PSC') && html.includes('PSC p. 31') && html.includes('PSC rev. 2'));
  check('testo: stesse informazioni', md.includes('Impresa subappaltatrice') && md.includes('Affidataria Srl') && md.includes('Tra 80 e 85') && md.includes('(PSC p. 31)') && md.includes('Intonacatrice'));
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
