#!/usr/bin/env node
/**
 * scripts/selftest_f513_estratto_conto.js — F-513 (AUDIT.md del frontend, 18/11/2026).
 *
 * L'estratto conto della banca, caricato dal titolare, segna le fatture pagate davvero.
 *   1. si leggono i formati di cinque banche (Intesa xlsx, UniCredit csv, BPER csv
 *      Dare/Avere, Banco BPM xlsx Entrate/Uscite, Poste csv con anno a 2 cifre):
 *      stessi 7 movimenti, stessi importi, stesse date;
 *   2. importi e date all'italiana; PDF e colonne sconosciute danno un errore chiaro;
 *   3. abbinamento sulle fatture di MSC (importi e fornitori veri):
 *      Stelli 600 + 1.500 con un solo bonifico da 2.100 → sicuro;
 *      Guardalà 4.702 e WC Loc 922,47 col nome nel bonifico → sicuro;
 *      3.450,91 pagato col POS (nessun nome) → da confermare;
 *      stipendi, F24 e l'incasso dal condominio → mai.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const L = require('../lib/estrattoConto/leggi');
const { abbina } = require('../lib/estrattoConto/abbina');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

const ATTESI = [
  ['2026-10-20', -2100], ['2026-10-22', -4702], ['2026-10-25', -922.47], ['2026-10-27', -3450.91],
  ['2026-10-27', -38471.53], ['2026-10-16', -5120.4], ['2026-10-30', 12000],
];
const FATTURE = [
  { id: 'stelli-207', fornitore: 'STELLI IMPIANTI DI STELLI MARCO', importo: 600, data: '2026-10-15' },
  { id: 'stelli-277', fornitore: 'STELLI IMPIANTI DI STELLI MARCO', importo: 1500, data: '2026-10-15' },
  { id: 'guardala-10', fornitore: "GUARDALA' GIUSEPPINA", importo: 4702, data: '2026-10-15' },
  { id: 'wcloc-621', fornitore: 'WC Loc Italia S.r.l. Unipersonale', importo: 922.47, data: '2026-08-31' },
  { id: 'wcloc-pos', fornitore: 'WC LOC ITALIA S.r.l.', importo: 3450.91, data: '2026-10-15' },
];

async function main() {
  console.log('\nPalladia regression — F-513: l\'estratto conto segna le fatture pagate davvero\n');

  // 2. Numeri e date all'italiana
  check('«-2.100,00» → -2100', L.importoItaliano('-2.100,00') === -2100);
  check('«1.234,56» → 1234.56', L.importoItaliano('1.234,56') === 1234.56);
  check('«12,00-» (segno in fondo) → -12', L.importoItaliano('12,00-') === -12);
  check('«€ 922,47» → 922.47', L.importoItaliano('€ 922,47') === 922.47);
  check('«1234.56» (punto decimale) → 1234.56', L.importoItaliano('1234.56') === 1234.56);
  check('«20/10/2026» → 2026-10-20', L.dataIso('20/10/2026') === '2026-10-20');
  check('«20/10/26» → 2026-10-20', L.dataIso('20/10/26') === '2026-10-20');
  check('«Saldo finale» non è una data', L.dataIso('Saldo finale') === null);

  // 1. Cinque banche
  const DIR = path.join(__dirname, 'fixtures', 'estratti');
  if (!fs.existsSync(path.join(DIR, 'intesa.xlsx'))) require('child_process').execSync(`node "${path.join(__dirname, 'fixture_estratti_conto.js')}"`);
  for (const f of ['intesa.xlsx', 'unicredit.csv', 'bper.csv', 'bancobpm.xlsx', 'poste.csv']) {
    const r = await L.leggiEstratto(fs.readFileSync(path.join(DIR, f)), f);
    const ok = !r.errore && r.movimenti.length === 7 && ATTESI.every(([d, imp], i) => r.movimenti[i].data === d && r.movimenti[i].importo === imp);
    check(`${f}: 7 movimenti con date e importi giusti`, ok, r.errore || r.movimenti.map(m => [m.data, m.importo]));
    check(`${f}: la descrizione c'è`, r.movimenti[0]?.descrizione?.includes('STELLI'), r.movimenti[0]);
  }
  check('PDF → errore chiaro (scarica l\'Excel)', (await L.leggiEstratto(Buffer.from('%PDF-1.4'), 'estratto.pdf')).errore === 'PDF');
  check('colonne sconosciute → errore chiaro', L.movimentiDaRighe([['nome', 'cognome'], ['a', 'b']]).errore === 'COLONNE');

  // 3. Abbinamento
  const { movimenti } = await L.leggiEstratto(fs.readFileSync(path.join(DIR, 'unicredit.csv')), 'unicredit.csv');
  const ris = abbina(movimenti, FATTURE);
  const di = (id) => ris.find(r => r.fatture.some(f => f.id === id));
  const stelli = di('stelli-207');
  check('Stelli: un bonifico da 2.100 € per le due fatture (600 + 1.500) → sicuro',
    stelli && stelli.tipo === 'sicuro' && stelli.fatture.length === 2 && di('stelli-277') === stelli && stelli.movimento.importo === -2100, stelli);
  check('Guardalà 4.702 € col nome nel bonifico → sicuro', di('guardala-10')?.tipo === 'sicuro', di('guardala-10'));
  check('WC Loc 922,47 € (addebito SDD col nome) → sicuro', di('wcloc-621')?.tipo === 'sicuro', di('wcloc-621'));
  check('3.450,91 € pagato col POS, senza nome → da confermare', di('wcloc-pos')?.tipo === 'da_confermare', di('wcloc-pos'));
  check('stipendi, F24 e incasso dal condominio non abbinano', ris.every(r => ![-38471.53, -5120.4, 12000].includes(r.movimento.importo)), ris.map(r => r.movimento.importo));
  check('ogni fattura al massimo una volta', new Set(ris.flatMap(r => r.fatture.map(f => f.id))).size === ris.flatMap(r => r.fatture).length);
  // Un bonifico più vecchio della fattura (oltre 10 giorni) non la paga
  const vecchio = abbina([{ data: '2026-09-01', importo: -4702, descrizione: 'BONIFICO GUARDALA GIUSEPPINA' }], FATTURE);
  check('un bonifico di settembre non paga una fattura del 15 ottobre', vecchio.length === 0, vecchio);
  // Due importi uguali senza nome: nessuna proposta (non si indovina)
  const due = abbina([{ data: '2026-10-20', importo: -100, descrizione: 'PAGAMENTO' }], [{ id: 'a', fornitore: 'Alfa', importo: 100, data: '2026-10-01' }, { id: 'b', fornitore: 'Beta', importo: 100, data: '2026-10-01' }]);
  check('stesso importo per due fornitori, senza nome → nessuna proposta', due.length === 0, due);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
