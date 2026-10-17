#!/usr/bin/env node
/**
 * scripts/selftest_ratelimit_redis_down.js — F-368 (AUDIT.md del frontend).
 *
 * I limiti anti-abuso (middleware/rateLimit.js) contano su Redis quando
 * REDIS_URL c'è. Se Redis non risponde (riavvio, trasloco di regione, rete),
 * express-rate-limit di default RILANCIA l'errore: la richiesta finisce in 500.
 * Il badge passa da badgePunchLimiter → la timbratura falliva.
 *
 * Qui Redis punta a una porta chiusa: il server deve partire senza cadere e
 * timbratura (badgePunchLimiter) e API (apiLimiter) devono passare lo stesso,
 * senza limite, invece di dare errore.
 */
'use strict';
// Due casi: porta chiusa (Redis rifiuta) e indirizzo che non risponde (Redis
// appeso, come durante un trasloco). Ognuno in un processo suo.
if (!process.argv[2]) {
  const { spawnSync } = require('child_process');
  let ko = 0;
  for (const [nome, url] of [['Redis che rifiuta', 'redis://127.0.0.1:1'], ['Redis che non risponde', 'redis://10.255.255.1:6379']]) {
    console.log(`
— ${nome}`);
    const r = spawnSync(process.execPath, [__filename, url], { stdio: 'inherit', timeout: 120000 });
    if (r.status !== 0) ko++;
  }
  process.exit(ko ? 1 : 0);
}
process.env.REDIS_URL = process.argv[2];
const express = require('express');

let crash = null;
process.on('unhandledRejection', (e) => { crash = crash || e; });
process.on('uncaughtException', (e) => { crash = crash || e; });

const { badgePunchLimiter, apiLimiter } = require('../middleware/rateLimit');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

(async () => {
  console.log('\nF-368 — Redis irraggiungibile: le timbrature passano lo stesso');
  const app = express();
  app.post('/badge/:code/punch', badgePunchLimiter, (_req, res) => res.json({ ok: true }));
  app.get('/api', apiLimiter, (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const t0 = Date.now();
  const r1 = await fetch(`${base}/badge/ABC123/punch`, { method: 'POST' });
  const ms = Date.now() - t0;
  check('timbratura con Redis giù: 200, non errore', r1.status === 200, { status: r1.status, body: await r1.text().catch(() => '') });
  check('e senza restare appesa (meno di 5 s)', ms < 5000, ms);
  const r2 = await fetch(`${base}/api`);
  check('API con Redis giù: 200', r2.status === 200, r2.status);
  await new Promise(r => setTimeout(r, 500));
  check('il server non cade (nessun errore non gestito)', !crash, crash && String(crash.message || crash));

  server.close();
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
