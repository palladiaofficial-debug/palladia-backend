#!/usr/bin/env node
/**
 * scripts/run_selftests.js — esegue i selftest elencati in scripts/selftests.txt,
 * uno dopo l'altro, e si ferma al primo che fallisce (come la vecchia catena
 * "node a.js && node b.js && …" di npm test).
 *
 * Perché esiste: con 197 script la riga di npm test superava il limite di
 * 8191 caratteri del prompt dei comandi di Windows ("La riga di comando è
 * troppo lunga") e la suite non partiva affatto.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const list = fs.readFileSync(path.join(__dirname, 'selftests.txt'), 'utf8')
  .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// --tutti: non si ferma al primo errore e li elenca alla fine.
// --da=N: riparte dal test numero N dell'elenco.
const tutti = process.argv.includes('--tutti');
const da = Number((process.argv.find(a => a.startsWith('--da=')) || '--da=1').slice(5)) || 1;
const falliti = [];
for (const [i, file] of list.entries()) {
  if (i + 1 < da) continue;
  const r = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    if (!tutti) {
      console.error(`\n✗ ${file} è fallito (${i + 1} di ${list.length}): suite interrotta.`);
      process.exit(r.status || 1);
    }
    falliti.push(`${i + 1}. ${file}`);
  }
}
if (falliti.length) {
  console.error(`\n✗ ${falliti.length} selftest falliti:\n${falliti.join('\n')}`);
  process.exit(1);
}
console.log(`\n✓ ${list.length - da + 1} selftest passati.`);
