#!/usr/bin/env node
/**
 * scripts/selftest_f521_tolti.js — AUDIT.md F-521 (2026-11-21)
 *
 * Inventario del 20/11: le voci che il titolare ha deciso di «togliere» non
 * devono solo essere spente, devono sparire dal codice. Il test fallisce se
 * una torna: file del modulo, rotta nel router, chiave tra i feature flag.
 *
 * Senza database e senza server: cerca le rotte delle voci tolte dentro il
 * router /api/v1 completo (con il flag spento il modulo rispondeva già 404,
 * quindi non basta guardare lo stato HTTP: la rotta non deve esistere).
 * Niente fetch: su Windows, con l'uscita in un file, Node andava in crash
 * all'uscita (UV_HANDLE_CLOSING) e la suite lo segnava rosso.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const esiste = (rel) => fs.existsSync(path.join(__dirname, '..', rel));

// Voce → file che non devono più esserci, rotte che non devono esistere, flag che non devono esistere
const TOLTI = {
  lavagna: {
    file: ['lib/lavagna.js', 'routes/v1/lavagna.js', 'scripts/selftest_lavagna.js', 'scripts/selftest_lavagna_in_corso.js'],
    rotte: [['GET', '/lavagna'], ['POST', '/lavagna/righe'], ['POST', '/lavagna/in-corso']],
    flag: ['lavagna'],
  },
};

// La rotta esiste se un layer del router (o di un sotto-router) la gestisce con quel metodo
function esisteRotta(stack, metodo, p) {
  for (const layer of stack) {
    if (!layer.match(p)) continue;
    if (layer.route) { if (layer.route.methods[metodo.toLowerCase()] || layer.route.methods._all) return true; continue; }
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      const resto = p.slice((layer.path || '').length) || '/';
      if (esisteRotta(layer.handle.stack, metodo, resto)) return true;
    }
  }
  return false;
}

function main() {
  console.log('\n\x1b[1mF-521 — le voci tolte non sono più nel codice\x1b[0m');
  const { FEATURES } = require('../lib/featureFlags');
  const router = require('../routes/v1');
  // controllo del controllo: una rotta che c'è deve risultare presente
  check('il cercarotte trova una rotta vera (GET /feature-flags)', esisteRotta(router.stack, 'GET', '/feature-flags'));
  for (const [voce, t] of Object.entries(TOLTI)) {
    for (const f of t.file) check(`${voce}: ${f} non c'è più`, !esiste(f));
    for (const [m, p] of t.rotte) check(`${voce}: ${m} ${p} non esiste`, !esisteRotta(router.stack, m, p));
    for (const k of t.flag) check(`${voce}: niente flag «${k}»`, !(k in FEATURES));
  }
  console.log(`\n  ${passed} ok, ${failed} falliti\n`);
  process.exit(failed ? 1 : 0);
}
main();
