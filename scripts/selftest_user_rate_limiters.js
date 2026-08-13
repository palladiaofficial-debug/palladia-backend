#!/usr/bin/env node
/**
 * scripts/selftest_user_rate_limiters.js
 *
 * Regressione per userChatLimiter/userImportLimiter (middleware/rateLimit.js).
 * Monta un server Express reale con GLI STESSI oggetti middleware usati in
 * produzione (import diretto, non una copia), con uno stub di autenticazione
 * al posto di verifySupabaseJwt — così il test esercita la vera logica
 * express-rate-limit (finestra, conteggio, handler 429) con vere richieste
 * HTTP, senza mai chiamare Anthropic o toccare il DB: nessun costo reale,
 * nessuna fixture esterna richiesta, sempre eseguibile.
 */
'use strict';
const express = require('express');
const { userChatLimiter, userImportLimiter } = require('../middleware/rateLimit');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function stubUser(req, _res, next) {
  req.user = { id: req.params.userId };
  req.companyId = 'test-company';
  next();
}

function startApp() {
  const app = express();
  app.get('/chat-probe/:userId', stubUser, userChatLimiter, (_req, res) => res.json({ ok: true }));
  app.get('/import-probe/:userId', stubUser, userImportLimiter, (_req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function fireN(url, n) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(url);
    results.push({ status: res.status, body: await res.json().catch(() => ({})) });
  }
  return results;
}

async function main() {
  console.log('\nPalladia regression — rate limiter per utente (chat + importazioni)\n');
  const { server, base } = await startApp();

  try {
    // ── userChatLimiter: max 30/min ─────────────────────────────────────────
    const userA = `chat-user-${Date.now()}-A`;
    const chatResults = await fireN(`${base}/chat-probe/${userA}`, 31);
    const chatOk  = chatResults.slice(0, 30).every(r => r.status === 200);
    const chat31  = chatResults[30];
    check('userChatLimiter: le prime 30 richieste dello stesso utente passano', chatOk, chatResults.slice(0, 30).map(r => r.status));
    check('userChatLimiter: la 31ª viene bloccata con 429', chat31.status === 429, chat31);
    check('userChatLimiter: messaggio comprensibile, non un codice grezzo', chat31.body.error === 'USER_CHAT_RATE_LIMIT' && typeof chat31.body.message === 'string' && chat31.body.message.length > 10, chat31.body);

    // Un utente diverso non eredita il blocco del primo — la chiave è per utente, non globale.
    const userB = `chat-user-${Date.now()}-B`;
    const otherUserRes = await fetch(`${base}/chat-probe/${userB}`);
    check('userChatLimiter: un utente diverso non è bloccato dal limite del primo', otherUserRes.status === 200, otherUserRes.status);

    // ── userImportLimiter: max 20/ora ───────────────────────────────────────
    const importUserA = `import-user-${Date.now()}-A`;
    const importResults = await fireN(`${base}/import-probe/${importUserA}`, 21);
    const importOk = importResults.slice(0, 20).every(r => r.status === 200);
    const import21 = importResults[20];
    check('userImportLimiter: le prime 20 richieste dello stesso utente passano', importOk, importResults.slice(0, 20).map(r => r.status));
    check('userImportLimiter: la 21ª viene bloccata con 429', import21.status === 429, import21);
    check('userImportLimiter: messaggio comprensibile, non un codice grezzo', import21.body.error === 'USER_IMPORT_RATE_LIMIT' && typeof import21.body.message === 'string' && import21.body.message.length > 10, import21.body);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
