'use strict';
/**
 * .eslintrc.js — Palladia Backend
 *
 * Livelli:
 *   error  = blocca CI, non si deploya
 *   warn   = visibile in review, non blocca
 *   off    = disabilitata
 *
 * Strategia: "errore" solo su ciò che causa bug reali o vulnerabilità di sicurezza.
 * Non usiamo linting stilistico — nessuna regola su spazi, virgole, ordine import.
 */
module.exports = {
  root: true,
  env: {
    node:  true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
  plugins: ['security'],
  extends: [
    'eslint:recommended',
    'plugin:security/recommended-legacy',
  ],

  rules: {

    // ── Sicurezza (blocca CI) ──────────────────────────────────────────────────

    // Blocca fetch/require con URL costruite da input utente non validato
    'security/detect-non-literal-fs-filename': 'error',

    // ReDoS: regex costruite da stringhe utente
    'security/detect-non-literal-regexp': 'error',

    // Object injection: troppi false positive (integer index, whitelist iteration) — disabilitata
    'security/detect-object-injection': 'off',

    // Buffer senza encoding esplicito (potenziale info leak)
    'security/detect-buffer-noassert': 'error',

    // Pseudo-random non crittograficamente sicuro (Math.random per token/secret)
    'security/detect-pseudoRandomBytes': 'error',

    // ── Bug comuni (blocca CI) ────────────────────────────────────────────────

    // == invece di === (falsy coercion — sorgente di bug silenziosi)
    'eqeqeq': ['error', 'always', { null: 'ignore' }],

    // Variabili dichiarate ma mai usate (spesso indice di codice non finito)
    'no-unused-vars': ['error', {
      vars:               'all',
      args:               'after-used',
      ignoreRestSiblings: true,
      caughtErrors:       'none',         // catch (e) {} è legittimo
      argsIgnorePattern:  '^_',           // parametri prefissati con _ sono intenzionalmente ignorati
      varsIgnorePattern:  '^_',           // variabili prefissate con _ (es. destructuring inutilizzati)
    }],

    // Return in constructor (quasi sempre un bug)
    'no-constructor-return': 'error',

    // Promise restituita ma non awaited (il bug più comune in questo codebase)
    'no-promise-executor-return': 'error',

    // Throw di valori non-Error (throw "stringa" perde lo stack trace)
    'no-throw-literal': 'error',

    // Assegnazione in condizione (if (x = foo()) è probabilmente if (x === foo()))
    'no-cond-assign': 'error',

    // Fallthrough in switch senza commento esplicito
    'no-fallthrough': 'error',

    // while(true) è un pattern legittimo per stream reader — non flaggare i loop
    'no-constant-condition': ['error', { checkLoops: false }],

    // ── Disabilitato intenzionalmente ─────────────────────────────────────────

    // no-console: off — usiamo console.log/error per logging strutturato (pino in prod)
    'no-console': 'off',

    // security/detect-child-process: off — non usiamo exec/spawn da input utente
    'security/detect-child-process': 'off',

    // security/detect-possible-timing-attacks: off — troppi false positive su confronti benigni
    'security/detect-possible-timing-attacks': 'off',

    // security/detect-unsafe-regex: off — sostituito da detect-non-literal-regexp
    'security/detect-unsafe-regex': 'off',

    // no-await-in-loop: off — i batch loop sequenziali sono intenzionali (es. insert voci computo)
    'no-await-in-loop': 'off',
  },

  ignorePatterns: [
    'node_modules/',
    'public/',
    'migrations/',
    'scripts/',        // script one-shot di sviluppo/debug, non production code
    '*.min.js',
  ],
};
