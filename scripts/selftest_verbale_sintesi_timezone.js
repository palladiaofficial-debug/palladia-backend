#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_verbale_sintesi_timezone.js
 *
 * F-120 (AUDIT.md): "Nota onesta, non ancora corretta" — la sezione "Sintesi
 * del Sopralluogo" in cima al verbale CSE mostrava l'ora nel fuso del server
 * (UTC su Railway) invece di Europe/Rome, stesso difetto già corretto altrove
 * nello stesso file (i timestamp delle foto, riga ~218) ma dimenticato qui.
 * Funzione pura, nessun DB/HTTP: buildVerbaleHtml() genera solo HTML da un
 * fixture in memoria.
 */
require('dotenv').config();
const { buildVerbaleHtml } = require('../routes/v1/verbale');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${got}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function main() {
  console.log('\nPalladia — Verbale CSE: fuso orario "Sintesi del Sopralluogo" (F-120)\n');

  const invite = { coordinator_name: 'Test Coordinatore', coordinator_company: null };
  const data = { site: { name: 'TEST Cantiere' }, company: { name: 'TEST Impresa' }, workers: [], nc: [], notes: [] };

  const html = buildVerbaleHtml(invite, data);

  const expectedTime = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  const expectedDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });

  check('Sezione "Sintesi del Sopralluogo" presente nell\'HTML', html.includes('Sintesi del Sopralluogo'), html.slice(0, 200));
  check(`Ora mostrata in Europe/Rome ("ore ${expectedTime}"), non nel fuso del server`, html.includes(`ore ${expectedTime}`), html.match(/Data sopralluogo[\s\S]{0,120}/)?.[0]);
  check(`Data mostrata in Europe/Rome ("${expectedDate}")`, html.includes(expectedDate), html.match(/Data sopralluogo[\s\S]{0,120}/)?.[0]);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
