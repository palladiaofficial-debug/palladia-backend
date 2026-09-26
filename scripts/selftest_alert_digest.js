#!/usr/bin/env node
/**
 * scripts/selftest_alert_digest.js — F-240 (AUDIT.md), Le quattro porte passo 4.
 *
 * Il riepilogo delle 7:30 sostituisce i messaggi dei singoli automatismi del
 * mattino. Quello che non deve mai succedere, e che qui si prova su dati reali:
 *   - con il riepilogo spento un avviso non parte (deve partire subito, come prima);
 *   - con il riepilogo acceso un avviso si perde (deve restare in coda);
 *   - il riepilogo ripete ogni giorno le stesse cose (deve dire solo le novità);
 *   - un guasto del riepilogo produce silenzio (devono partire i messaggi di sempre);
 *   - il riepilogo non parte affatto e nessuno se ne accorge (controllo delle 7:50).
 * Nessun messaggio reale esce: l'azienda TEST- non ha Telegram né push collegati.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const daFare = require('../lib/daFare');
const digest = require('../lib/alertDigest');
const { notifyExpiryAlert } = require('../services/telegramNotifications');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const T = `TEST-F240-${Date.now()}`;
const today = daFare.romeDate();

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const queueRows = (cid) => supabase.from('alert_digest_queue').select('id, kind, delivered_at, delivered_via').eq('company_id', cid).order('created_at');

async function main() {
  console.log('\n\x1b[1mF-240 — riepilogo unico delle 7:30 con rete di sicurezza\x1b[0m');
  const on = await ins('companies', { name: `${T} acceso` });
  const off = await ins('companies', { name: `${T} spento` });
  try {
    await ins('company_feature_flags', { company_id: on.id, feature: 'alert_digest', enabled: true });
    await ins('workers', {
      company_id: on.id, full_name: `${T} Anna`, is_active: true,
      fiscal_code: `F240A${Date.now()}`.slice(0, 16), badge_code: `F240A${Date.now()}`,
      health_fitness_expiry: daFare.addDays(today, -2),
    });

    // ── Spento: invio immediato, nessuna coda ─────────────────────────────
    let sentNow = 0;
    await digest.queueOrSend(off.id, { kind: 'expiry', telegramText: 'x' }, async () => { sentNow++; });
    const { data: offQueue } = await queueRows(off.id);
    check('riepilogo spento: l\'avviso parte subito, come prima', sentNow === 1 && (offQueue || []).length === 0, { sentNow, offQueue });

    // ── Acceso: in coda, non inviato ──────────────────────────────────────
    await notifyExpiryAlert(on.id, '⚠️ <b>Documenti</b>\nAnna — idoneità');
    let { data: q } = await queueRows(on.id);
    check('riepilogo acceso: l\'avviso degli automatismi va in coda invece di partire', q?.length === 1 && q[0].kind === 'expiry' && !q[0].delivered_at, q);

    // ── Anteprima: testo con la riga nuova di Da fare ─────────────────────
    const preview = await digest.buildDigest(on.id);
    check('anteprima: il riepilogo contiene l\'idoneità scaduta di Anna e il link a Da fare',
      !!preview && /Idoneità medica — .*Anna/.test(preview.text) && preview.text.includes('/scadenze'), preview?.text);

    // ── Giro delle 7:30 ───────────────────────────────────────────────────
    const r1 = await digest.runDigestForCompany(on.id);
    ({ data: q } = await queueRows(on.id));
    const { data: sentItems } = await supabase.from('da_fare_digest_sent').select('item_id').eq('company_id', on.id);
    check('giro 7:30: riepilogo inviato, coda chiusa come "digest"', r1.status === 'sent' && q.every(x => x.delivered_via === 'digest'), { r1, q });
    check('le righe comunicate sono registrate', (sentItems || []).length >= 1, sentItems);

    // ── Giorno dopo senza novità: silenzio, niente ripetizioni ────────────
    await notifyExpiryAlert(on.id, '⚠️ di nuovo la stessa scadenza');
    const r2 = await digest.runDigestForCompany(on.id);
    check('nessuna riga nuova: nessun messaggio (una volta sola, come da mockup)', r2.status === 'empty', r2);

    // ── Guasto del riepilogo: partono i messaggi di sempre ────────────────
    await notifyExpiryAlert(on.id, '⚠️ avviso da non perdere');
    const original = daFare.buildDaFare;
    daFare.buildDaFare = async () => { throw new Error('guasto simulato'); };
    let r3;
    try { r3 = await digest.runDigestForCompany(on.id); } finally { daFare.buildDaFare = original; }
    ({ data: q } = await queueRows(on.id));
    const last = q[q.length - 1];
    check('guasto del riepilogo: la coda parte com\'è ("fallback"), non silenzio', r3.status === 'failed' && r3.fallback === 1 && last.delivered_via === 'fallback', { r3, last });
    const { data: run } = await supabase.from('alert_digest_runs').select('status, error').eq('company_id', on.id).eq('run_date', today).single();
    check('il guasto resta registrato con il suo motivo', run?.status === 'failed' && /guasto simulato/.test(run.error || ''), run);

    // ── Riepilogo mai partito: il controllo delle 7:50 recupera ───────────
    await supabase.from('alert_digest_runs').delete().eq('company_id', on.id);
    await notifyExpiryAlert(on.id, '⚠️ avviso di un giorno senza riepilogo');
    await digest.runWatchdog();
    ({ data: q } = await queueRows(on.id));
    check('7:50: senza giro registrato la coda viene spedita comunque', q[q.length - 1].delivered_via === 'fallback', q[q.length - 1]);
  } finally {
    for (const cid of [on.id, off.id]) {
      for (const t of ['alert_digest_queue', 'alert_digest_runs', 'da_fare_digest_sent', 'company_feature_flags', 'workers']) {
        await supabase.from(t).delete().eq('company_id', cid);
      }
      await supabase.from('companies').delete().eq('id', cid);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
