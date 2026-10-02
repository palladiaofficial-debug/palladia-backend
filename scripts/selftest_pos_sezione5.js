#!/usr/bin/env node
/**
 * scripts/selftest_pos_sezione5.js — F-261 (AUDIT.md del frontend), passo 4.
 *
 * La Sezione 5 del POS si compone dalle schede lavorazione, non dall'AI:
 *  1) senza selectedSchede (vecchio generatore, Ladia) → null: resta l'AI;
 *  2) con le schede → markdown deterministico, doppioni tolti, id ignoti segnalati;
 *  3) il vero renderer del PDF (pos-html-generator) produce un blocco per
 *     scheda, con tabelle rischi/DPI/attrezzature e livelli colorati;
 *  4) nessuna cella di tabella rompe le colonne.
 * Nessun accesso al DB, nessuna chiamata AI.
 */
'use strict';
const { composeSezione5 } = require('../lib/posSezione5');
const S = require('../lib/lavorazioniSchede');
const { generatePosHtml } = require('../pos-html-generator');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}

async function main() {
  console.log('\n\x1b[1mF-261 — Sezione 5 del POS dalle schede lavorazione\x1b[0m');

  check('senza selectedSchede → null (resta il percorso AI)', composeSezione5(undefined) === null && composeSezione5([]) === null && composeSezione5('ple') === null);
  check('solo id sconosciuti → null', composeSezione5(['non-esiste']) === null);

  const r = composeSezione5(['ple', 'scavo-trincea', 'ple', 'non-esiste']);
  check('doppioni tolti, ordine della scelta', JSON.stringify(r.schede) === '["ple","scavo-trincea"]', r.schede);
  check('id sconosciuti segnalati', JSON.stringify(r.sconosciute) === '["non-esiste"]', r.sconosciute);
  check('un blocco ### per scheda', (r.markdown.match(/^### /gm) || []).length === 2);
  check('PLE: rischio ribaltamento con P=2, D=4, R=8, Alto',
    r.markdown.includes('| Ribaltamento per terreno cedevole o stabilizzatori non estesi | 2 | 4 | 8 | Alto |'));
  check('PLE: DPI con norma', r.markdown.includes('| Imbracatura anticaduta | UNI EN 361 |'));
  check('PLE: formazione richiesta', r.markdown.includes(S.FORMAZIONE.ple));
  check('deterministica: stesso input, stesso testo', composeSezione5(['ple', 'scavo-trincea']).markdown === r.markdown);

  // Tutte le schede: ogni riga di tabella ha le stesse colonne della sua intestazione
  const all = composeSezione5(S.SCHEDE.map(s => s.id));
  const bad = [];
  let header = null;
  for (const line of all.markdown.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) { header = null; continue; }
    const cols = t.split('|').length;
    if (header === null) header = cols;
    else if (cols !== header) bad.push(t);
  }
  check(`tabelle integre in tutte le ${S.SCHEDE.length} schede`, bad.length === 0, bad);

  // Il vero renderer del PDF
  const posData = { siteAddress: 'Via Prova 1, Genova', companyName: 'Impresa Prova', selectedWorks: S.SCHEDE.map(s => s.nome), workers: [], subappaltatori: [], fasi: [] };
  const html = await generatePosHtml(posData, 1, all.markdown, []);
  const blocchi = (html.match(/class="lavorazione-block"/g) || []).length;
  check(`renderer PDF: ${S.SCHEDE.length} blocchi lavorazione`, blocchi === S.SCHEDE.length, blocchi);
  check('renderer PDF: nessun "Nessuna lavorazione generata"', !html.includes('Nessuna lavorazione generata'));
  check('renderer PDF: livelli colorati (molto alto, alto, medio)',
    html.includes('badge badge-very-high') && html.includes('badge badge-high') && html.includes('badge badge-medium'));
  // Il colore del numero R segue la legenda, come il badge del livello accanto
  const rp = await generatePosHtml(posData, 1, composeSezione5(['ple', 'scavo-trincea']).markdown, []);
  check('renderer PDF: R=8 colorato "alto" come il badge Alto', rp.includes('<span class="risk-num risk-high">8</span>'), (rp.match(/risk-num [a-z-]+">8</) || [])[0]);
  check('renderer PDF: R=12 colorato "molto alto"', rp.includes('<span class="risk-num risk-very-high">12</span>'));
  check('renderer PDF: R=4 colorato "medio"', rp.includes('<span class="risk-num risk-medium">4</span>'));
  const titoli = S.SCHEDE.filter(s => !html.includes(`<div class="lav-header">${s.nome.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}</div>`)).map(s => s.id);
  check('renderer PDF: ogni scheda ha il suo titolo', titoli.length === 0, titoli);

  console.log(`\n  ${passed} passati, ${failed} falliti\n`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
