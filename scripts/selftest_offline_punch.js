#!/usr/bin/env node
/**
 * scripts/selftest_offline_punch.js — F-284 (AUDIT.md del frontend).
 *
 * Caso reale: Ibrahim Canameti, 5/10/2026 — senza credito né connessione non
 * ha potuto timbrare; il titolare ha inserito a mano l'ingresso. Ora il
 * telefono salva la timbratura e la manda al ritorno della rete
 * (POST /badge/:code/offline-punch, routes/v1/badgeOfflinePunch.js).
 *
 * Contro il DB vero (azienda di prova), router montati su un server locale:
 *  - ora vera della timbratura e orologio cambiato (puro);
 *  - kit: cantieri con coordinate, stato, ora del server; senza consenso 403;
 *  - entrata pulita → nelle ore all'ora del telefono (worker_offline_punch);
 *  - stesso invio due volte → una riga sola;
 *  - entrata + uscita arrivate insieme → coppia completa;
 *  - orologio cambiato / senza posizione / lontano / dopo 12 ore / dopo altre
 *    timbrature / uscita a pochi minuti senza conferma → NON nelle ore, da decidere;
 *  - la timbratura normale subito dopo un'entrata senza rete → uscita, come sempre;
 *  - Da fare: "È giusta" su quelle registrate, "Registra" su quelle da decidere.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { PRIVACY_CONSENT_VERSION } = require('../lib/workerPrivacyConsent');
const { resolvePunchTime, applyOfflinePunch, confirmOfflinePunch } = require('../lib/offlinePunch');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F284-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const SITE = { latitude: 44.4157, longitude: 8.9568 };
const NEAR = { latitude: 44.41575, longitude: 8.95685, gps_accuracy_m: 10 };
const FAR = { latitude: 44.43, longitude: 8.99, gps_accuracy_m: 10 };
const minAgo = (m) => Date.now() - m * 60000;

async function main() {
  console.log('\n\x1b[1mF-284 — timbratura senza internet\x1b[0m');

  // ── Puro: ora vera e orologio ──────────────────────────────────────────────
  const now = Date.parse('2026-10-05T08:00:00Z');
  let r = resolvePunchTime({ deviceAt: now - 3600e3 - 180e3, deviceNow: now - 180e3, kitOffsetMs: 180e3, now });
  check('telefono 3 minuti indietro, sempre uguale: ora corretta dello scarto', r.flags.length === 0 && r.punchedAt === now - 3600e3, r);
  r = resolvePunchTime({ deviceAt: now - 3600e3, deviceNow: now + 3600e3, kitOffsetMs: 0, now });
  check('orologio spostato di un\'ora dopo l\'ultimo contatto: orologio_cambiato', r.flags.includes('orologio_cambiato'), r);
  r = resolvePunchTime({ deviceAt: now - 13 * 3600e3, deviceNow: now, kitOffsetMs: 0, now });
  check('oltre 12 ore: troppo_vecchia', r.flags.includes('troppo_vecchia'), r);
  r = resolvePunchTime({ deviceAt: now + 3600e3, deviceNow: now, kitOffsetMs: null, now });
  check('ora nel futuro: orologio_cambiato', r.flags.includes('orologio_cambiato'), r);

  // ── HTTP ───────────────────────────────────────────────────────────────────
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/badgePunch'));
  app.use('/api/v1', require('../routes/v1/badgeOfflinePunch'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) }; };

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Corso Test 284', status: 'attivo', ...SITE, geofence_radius_m: 120 });
    let n = 0;
    const worker = async (label, consent = true) => {
      n++;
      return ins('workers', {
        company_id: company.id, full_name: `${T} ${label}`, is_active: true,
        fiscal_code: `F284${Date.now()}${n}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
        ...(consent ? { privacy_consent_accepted_at: new Date().toISOString(), privacy_consent_version: PRIVACY_CONSENT_VERSION } : {}),
      });
    };
    const logs = async (w) => (await supabase.from('presence_logs').select('event_type, timestamp_server, method').eq('worker_id', w.id).order('timestamp_server')).data || [];
    const offline = (w, extra) => call('POST', `/badge/${w.badge_code}/offline-punch`, {
      client_request_id: crypto.randomUUID(), site_id: site.id, device_now: Date.now(), kit_offset_ms: 0, ...NEAR, ...extra,
    });

    // 1. Kit
    const ib = await worker('Ibrahim');
    const kit = await call('GET', `/badge/${ib.badge_code}/offline-kit`);
    const ks = kit.body.sites?.find(s => s.site_id === site.id);
    check('kit: ora del server, stato ENTRY e cantiere con coordinate e raggio', kit.status === 200 && Math.abs(kit.body.server_now - Date.now()) < 10000 && kit.body.next_action === 'ENTRY' && ks?.latitude === SITE.latitude && ks?.geofence_radius_m === 120, kit);
    const noConsent = await worker('SenzaConsenso', false);
    check('kit senza consenso privacy: 403', (await call('GET', `/badge/${noConsent.badge_code}/offline-kit`)).status === 403);
    check('timbratura senza consenso privacy: 403, niente scritto', (await offline(noConsent, { device_at: minAgo(5) })).status === 403 && (await logs(noConsent)).length === 0);

    // 2. Il caso di Ibrahim: entrata alle 7:31 arrivata più tardi
    const crid = crypto.randomUUID();
    const e1 = await offline(ib, { client_request_id: crid, device_at: minAgo(100), expected_type: 'ENTRY' });
    let l = await logs(ib);
    check('entrata pulita: registrata, nelle ore', e1.status === 200 && e1.body.status === 'registrata' && e1.body.event_type === 'ENTRY', e1);
    check('…all\'ora del telefono, non all\'ora di arrivo', l.length === 1 && l[0].method === 'worker_offline_punch' && Math.abs(Date.parse(l[0].timestamp_server) - minAgo(100)) < 15000, l);
    const e1b = await offline(ib, { client_request_id: crid, device_at: minAgo(100), expected_type: 'ENTRY' });
    check('stesso invio due volte (rete che va e viene): una riga sola', e1b.body.replayed === true && (await logs(ib)).length === 1, e1b);
    const kit2 = await call('GET', `/badge/${ib.badge_code}/offline-kit`);
    check('kit dopo l\'entrata: prossima azione EXIT', kit2.body.next_action === 'EXIT' && !!kit2.body.open_since, kit2.body);

    // 3. La timbratura normale dopo un'entrata arrivata senza rete: uscita come sempre
    const norm = await call('POST', `/badge/${ib.badge_code}/punch`, { site_id: site.id, ...NEAR, confirmed: true });
    check('timbratura normale dopo: uscita, percorso normale invariato', norm.status === 200 && norm.body.event_type === 'EXIT', norm);

    // 4. Entrata e uscita arrivate insieme (senza rete tutto il giorno)
    const day = await worker('TuttoIlGiorno');
    const d1 = await offline(day, { device_at: minAgo(9 * 60), expected_type: 'ENTRY' });
    const d2 = await offline(day, { device_at: minAgo(10), expected_type: 'EXIT' });
    l = await logs(day);
    check('entrata e uscita arrivate insieme: coppia completa nelle ore', d1.body.status === 'registrata' && d2.body.status === 'registrata' && l.map(x => x.event_type).join() === 'ENTRY,EXIT', { d1: d1.body, d2: d2.body, l });

    // 5. Casi da decidere (mai nelle ore senza il titolare)
    const cases = [
      ['orologio cambiato', { device_at: minAgo(30), device_now: Date.now() - 3600e3, kit_offset_ms: 0 }, 'orologio_cambiato'],
      ['senza posizione', { device_at: minAgo(30), latitude: null, longitude: null, gps_accuracy_m: null }, 'senza_posizione'],
      ['lontano dal cantiere', { device_at: minAgo(30), ...FAR }, 'lontano'],
      ['arrivata dopo 13 ore', { device_at: minAgo(13 * 60) }, 'troppo_vecchia'],
    ];
    for (const [label, extra, flag] of cases) {
      const w = await worker(label);
      const x = await offline(w, extra);
      check(`${label}: da decidere (${flag}), niente nelle ore`, x.status === 200 && x.body.status === 'da_decidere' && (await logs(w)).length === 0, x.body);
      const { data: row } = await supabase.from('presence_offline_punches').select('flags').eq('worker_id', w.id).single();
      check(`…motivo salvato per il titolare: ${flag}`, row?.flags?.includes(flag), row);
    }
    const after = await worker('DopoAltre');
    await ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: after.id, event_type: 'ENTRY', timestamp_server: new Date(minAgo(10)).toISOString(), method: 'worker_self_punch' });
    const af = await offline(after, { device_at: minAgo(40), expected_type: 'ENTRY' });
    check('arrivata dopo una timbratura normale più recente: da decidere (dopo_altre)', af.body.status === 'da_decidere' && (await logs(after)).length === 1, af.body);
    const shortW = await worker('UscitaBreve');
    await offline(shortW, { device_at: minAgo(20), expected_type: 'ENTRY' });
    const sh = await offline(shortW, { device_at: minAgo(10), expected_type: 'EXIT' });
    check('uscita 10 minuti dopo l\'entrata senza conferma: da decidere (uscita_breve)', sh.body.status === 'da_decidere' && sh.body.event_type === 'EXIT' && (await logs(shortW)).length === 1, sh.body);
    const shortOk = await worker('UscitaBreveConfermata');
    await offline(shortOk, { device_at: minAgo(20), expected_type: 'ENTRY' });
    const sk = await offline(shortOk, { device_at: minAgo(10), expected_type: 'EXIT', confirmed: true });
    check('…confermata dall\'operaio ("Sì, esco adesso"): registrata', sk.body.status === 'registrata', sk.body);

    // 6. Da fare del titolare
    const { buildDaFare } = require('../lib/daFare');
    const df = await buildDaFare(company.id, null);
    const items = (df.items || df).filter(i => i.type === 'offline');
    const ibItem = items.find(i => i.title.startsWith(`${T} Ibrahim`));
    check('Da fare: entrata di Ibrahim "senza internet" con "È giusta" e il suo indirizzo', !!ibItem && ibItem.fixDismiss?.label === 'È giusta' && ibItem.fixEndpoint?.includes('/presence/offline-punches/'), ibItem);
    const clockItem = items.find(i => i.title.startsWith(`${T} orologio cambiato`));
    check('Da fare: orologio cambiato → da controllare, "Registra" + altro orario, spiegazione', !!clockItem && !!clockItem.fixAction && clockItem.fixAltTime === true && /ora del telefono/i.test(clockItem.subtitle), clockItem);

    const { data: ibRow } = await supabase.from('presence_offline_punches').select('id').eq('worker_id', ib.id).single();
    const c1 = await confirmOfflinePunch({ id: ibRow.id, companyId: company.id, userId: null });
    const c2 = await confirmOfflinePunch({ id: ibRow.id, companyId: company.id, userId: null });
    check('"È giusta": confermata una volta sola', c1.ok && !c2.ok && c2.code === 'ALREADY_DONE', { c1, c2 });

    const farW = (await supabase.from('workers').select('id').eq('full_name', `${T} lontano dal cantiere`).single()).data;
    const { data: farRow } = await supabase.from('presence_offline_punches').select('id, punched_at').eq('worker_id', farW.id).single();
    const a1 = await applyOfflinePunch({ id: farRow.id, companyId: company.id, userId: null, userRole: 'owner' });
    const farLogs = await logs(farW);
    check('"Registra" su una da decidere: riga del titolare all\'ora del telefono', a1.ok && farLogs.length === 1 && farLogs[0].method === 'admin_manual_correction' && Date.parse(farLogs[0].timestamp_server) === Date.parse(farRow.punched_at), { a1, farLogs });
    const a2 = await applyOfflinePunch({ id: farRow.id, companyId: company.id, userId: null, userRole: 'owner' });
    check('…due tocchi non scrivono due volte', !a2.ok && a2.code === 'ALREADY_DONE' && (await logs(farW)).length === 1, a2);
  } finally {
    server.close();
    await new Promise(res => setTimeout(res, 1500));
    await supabase.from('presence_offline_punches').delete().eq('company_id', company.id);
    await supabase.from('presence_fix_requests').delete().eq('company_id', company.id);
    await supabase.from('notifications').delete().eq('company_id', company.id);
    await supabase.from('worksite_workers').delete().eq('company_id', company.id);
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
