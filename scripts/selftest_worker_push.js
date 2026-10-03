#!/usr/bin/env node
/**
 * scripts/selftest_worker_push.js — F-267 (AUDIT.md del frontend).
 *
 * Il badge chiedeva il permesso per le notifiche ma mandava l'iscrizione a
 * POST /api/v1/push/subscribe (richiede il login dell'app) → 401, ignorato in
 * silenzio: a nessun operaio è mai arrivata una notifica. Contro il DB vero:
 *  - POST /badge/:code/push-subscribe salva l'iscrizione dell'operaio;
 *  - badge non valido / revocato / iscrizione malformata rifiutati;
 *  - stesso telefono: nessun doppione, e se passa a un altro operaio si sposta;
 *  - sendPushToWorker manda solo ai telefoni di quell'operaio e pulisce gli scaduti (410);
 *  - gli operai NON finiscono in push_subscriptions (avvisi dell'ufficio);
 *  - badge-punch.html usa la rotta nuova; sw.js apre l'url giusto al tocco.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F267-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-267 — notifiche push agli operai\x1b[0m');

  const html = fs.readFileSync(path.join(__dirname, '../public/badge-punch.html'), 'utf8');
  check('badge-punch.html iscrive l\'operaio sulla rotta del badge, non su quella col login', html.includes("'/api/v1/badge/' + BADGE_CODE + '/push-subscribe'") && !html.includes("fetch('/api/v1/push/subscribe'"));
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  check('sw.js apre l\'url della notifica (data.data.url), non sempre "/"', /data\.data\?\.url/.test(sw));
  check('sw.js usa icone servite dal backend (sagoma monocromatica presente)', sw.includes("badge:              '/badge-monochrome.png'") && fs.existsSync(path.join(__dirname, '../public/badge-monochrome.png')) && fs.existsSync(path.join(__dirname, '../public/icon-pwa-192.png')));

  let router;
  try { router = require('../routes/v1/workerPush'); } catch (e) { check('rotta routes/v1/workerPush esiste', false, e.message); }
  if (!router) { console.log(`\n${passed} passati, ${failed} falliti`); process.exit(1); }

  // webpush finto: si registrano gli invii e si simula un telefono scaduto (410)
  const sent = [];
  const webpush = require('web-push');
  // In locale le chiavi VAPID possono mancare (l'invio si spegnerebbe): chiavi di prova
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    const k = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = k.publicKey; process.env.VAPID_PRIVATE_KEY = k.privateKey;
  }
  webpush.sendNotification = async (sub) => {
    sent.push(sub.endpoint);
    if (sub.endpoint.endsWith('-scaduto')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  };
  const { sendPushToWorker } = require('../services/pushNotifications');

  const app = express(); app.use(express.json()); app.use('/api/v1', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const sub = async (code, body) => { const r = await fetch(`${base}/badge/${code}/push-subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const S = (ep) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${T}-${ep}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });

  const company = await ins('companies', { name: T });
  try {
    const mk = (n, extra = {}) => ins('workers', { company_id: company.id, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F267${Date.now()}${n}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), ...extra });
    const a = await mk('A'), b = await mk('B'), off = await mk('C', { is_active: false });

    const r1 = await sub(a.badge_code, S('tel1'));
    check('iscrizione dell\'operaio salvata', r1.status === 200, r1);
    const { data: rows } = await supabase.from('worker_push_subscriptions').select('worker_id, company_id').eq('endpoint', S('tel1').endpoint);
    check('…nella tabella degli operai, con operaio e azienda giusti', rows?.length === 1 && rows[0].worker_id === a.id && rows[0].company_id === company.id, rows);
    const { count: office } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    check('nessun operaio finisce tra gli iscritti dell\'ufficio (push_subscriptions)', office === 0, office);

    check('badge non valido: 400', (await sub('NONVALIDO', S('x'))).status === 400);
    check('badge inesistente: 404', (await sub(crypto.randomBytes(9).toString('hex').toUpperCase(), S('x'))).status === 404);
    check('operaio disattivato: 403', (await sub(off.badge_code, S('x'))).status === 403);
    check('iscrizione malformata: 400', (await sub(a.badge_code, { endpoint: 'x' })).status === 400);
    check('iscrizione con endpoint non https: 400', (await sub(a.badge_code, { endpoint: 'http://evil/x', keys: { p256dh: 'p', auth: 'a' } })).status === 400);

    await sub(a.badge_code, S('tel1'));
    const { count: dup } = await supabase.from('worker_push_subscriptions').select('id', { count: 'exact', head: true }).eq('endpoint', S('tel1').endpoint);
    check('stesso telefono due volte: nessun doppione', dup === 1, dup);
    await sub(b.badge_code, S('tel1'));
    const { data: moved } = await supabase.from('worker_push_subscriptions').select('worker_id').eq('endpoint', S('tel1').endpoint).single();
    check('telefono passato a un altro operaio: l\'iscrizione si sposta', moved?.worker_id === b.id, moved);

    await sub(a.badge_code, S('tel2'));
    await sub(a.badge_code, S('scaduto'));
    sent.length = 0;
    await sendPushToWorker(a.id, { title: 'Prova', body: 'Prova', url: `/timbratura/${a.badge_code}` });
    check('invio all\'operaio A: solo i suoi telefoni', sent.length === 2 && sent.every(e => /tel2|scaduto/.test(e)), sent);
    const { count: left } = await supabase.from('worker_push_subscriptions').select('id', { count: 'exact', head: true }).eq('worker_id', a.id);
    check('telefono scaduto (410) rimosso', left === 1, left);
  } finally {
    server.close();
    await supabase.from('worker_push_subscriptions').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
