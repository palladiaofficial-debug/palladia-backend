#!/usr/bin/env node
/**
 * scripts/selftest_ai_usage_status.js
 *
 * Test di regressione per F-056 (AUDIT.md): prima di questo lavoro un cliente
 * scopriva di aver esaurito il budget AI mensile SOLO quando Ladia smetteva
 * di rispondere (errore AI_BUDGET_EXCEEDED in chat) — nessun avviso prima del
 * muro, a differenza di come Claude Code/Claude.ai mostrano l'utilizzo prima
 * di esaurirlo. `formatAiUsageStatus` trasforma il risultato di checkAiBudget
 * (usato per bloccare/permettere) in un numero mostrabile in UI (percentuale
 * arrotondata) — questo test copre i casi limite: piano enterprise (nessun
 * tetto), spesa zero, spesa oltre il 100%, fallimento del controllo budget.
 */
'use strict';
require('dotenv').config();
const { formatAiUsageStatus } = require('../lib/ladiaUsageLog');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\n=== selftest_ai_usage_status (F-056) ===\n');

check('piano enterprise (limit null) → percentage null, niente da mostrare',
  JSON.stringify(formatAiUsageStatus({ allowed: true, plan: 'enterprise', limit: null, spend: null, resetsAt: null })) ===
  JSON.stringify({ spend: null, limit: null, percentage: null, resets_at: null }));

check('spesa a metà budget → percentage arrotondato correttamente',
  formatAiUsageStatus({ allowed: true, plan: 'grow', limit: 20, spend: 10, resetsAt: '2026-09-01' }).percentage === 50);

check('spesa zero → percentage 0, non null (deve poter mostrare la barra vuota)',
  formatAiUsageStatus({ allowed: true, plan: 'starter', limit: 10, spend: 0, resetsAt: '2026-09-01' }).percentage === 0);

check('spesa oltre il limite → percentage può superare 100 (il blocco è un fatto separato, qui solo il numero)',
  formatAiUsageStatus({ allowed: false, plan: 'starter', limit: 10, spend: 12.4, resetsAt: '2026-09-01' }).percentage === 124);

check('arrotondamento coerente (non tronca sempre per difetto)',
  formatAiUsageStatus({ allowed: true, plan: 'pro', limit: 40, spend: 31.8, resetsAt: '2026-09-01' }).percentage === 80);

check('checkAiBudget fallito (fail-open, budget null/undefined) → non esplode, percentage null',
  formatAiUsageStatus(null).percentage === null);

check('resets_at passato correttamente',
  formatAiUsageStatus({ allowed: true, plan: 'grow', limit: 20, spend: 5, resetsAt: '2026-09-01T00:00:00.000Z' }).resets_at === '2026-09-01T00:00:00.000Z');

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exit(failed > 0 ? 1 : 0);
