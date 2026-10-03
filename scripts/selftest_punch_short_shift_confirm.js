#!/usr/bin/env node
/**
 * scripts/selftest_punch_short_shift_confirm.js — F-266 (AUDIT.md del frontend).
 *
 * Caso reale: Binozi Armand, 29/09/2026 — entrata 07:38, uscita 07:45 (un
 * secondo tocco sul badge, non un reinvio), "entrata" 17:01 credendo di
 * uscire. Il server accettava tutto: l'unica protezione era "non due
 * timbrature entro 60 secondi". Sweep: 8 giornate su 133 in 60 giorni.
 *
 * Contro il DB vero (azienda di prova), router montati su un server locale:
 *  - badge: uscita 7 minuti dopo l'entrata → 409 CONFIRM_REQUIRED, niente scritto;
 *    con conferma → uscita scritta + avviso al titolare;
 *  - badge: nuova timbratura dopo un turno di pochi minuti oggi → conferma;
 *  - turno normale (4 ore) → nessuna domanda, uscita come sempre;
 *  - F-184 resta valido: un reinvio con lo stesso client_request_id non chiede nulla;
 *  - sotto i 60 secondi resta PUNCH_TOO_SOON;
 *  - "No, sto andando via" → richiesta d'aiuto ENTRY_NOT_EXIT con gli orari, niente scritto;
 *  - QR (/scan/punch): stessa conferma.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { PRIVACY_CONSENT_VERSION } = require('../lib/workerPrivacyConsent');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F266-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
// Gli avvisi partono dopo la risposta (fire-and-forget): si aspetta fino a 5 s
async function waitRows(q) { for (let i = 0; i < 25; i++) { const { data } = await q(); if (data?.length) return data; await new Promise(r => setTimeout(r, 200)); } return []; }
const GPS = { latitude: 44.4, longitude: 8.95, gps_accuracy_m: 8 };

async function main() {
  console.log('\n\x1b[1mF-266 — uscita pochi minuti dopo l\'entrata: conferma prima di scrivere\x1b[0m');
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/badgePunch'));
  app.use('/api/v1', require('../routes/v1/scan'));
  app.use('/api/v1', require('../routes/v1/scanExitReason'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 266', status: 'attivo' });
    let n = 0;
    const worker = async (label) => {
      n++;
      return ins('workers', {
        company_id: company.id, full_name: `${T} ${label}`, is_active: true,
        fiscal_code: `F266${Date.now()}${n}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
        privacy_consent_accepted_at: new Date().toISOString(), privacy_consent_version: PRIVACY_CONSENT_VERSION,
      });
    };
    const log = (w, type, ts, extra = {}) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'worker_self_punch', ...extra });
    const count = async (w) => (await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('worker_id', w.id)).count;
    const punch = (w, extra = {}) => post(`/badge/${w.badge_code}/punch`, { site_id: site.id, ...GPS, ...extra });

    // 1. Il caso di Armand: uscita 7 minuti dopo l'entrata
    const a = await worker('Armand');
    await log(a, 'ENTRY', ago(7));
    const r1 = await punch(a);
    check('uscita 7 min dopo l\'entrata: 409 CONFIRM_REQUIRED (SHORT_EXIT)', r1.status === 409 && r1.body.error === 'CONFIRM_REQUIRED' && r1.body.reason === 'SHORT_EXIT' && r1.body.minutes === 7, r1);
    check('…con l\'ora dell\'entrata, per la domanda all\'operaio', !!r1.body.entry_at, r1.body);
    check('…e niente scritto', await count(a) === 1);
    const r2 = await punch(a, { confirmed: true });
    check('confermata: uscita scritta come sempre', r2.status === 200 && r2.body.event_type === 'EXIT', r2);
    // Avviso al titolare = caso in Da fare → Timbrature da sistemare (la nuova app non ha la campanella)
    const notif = await waitRows(() => supabase.from('presence_fix_requests').select('kind, entry_at, exit_at, exit_log_id').eq('worker_id', a.id).eq('kind', 'short_shift'));
    check('avviso al titolare: turno di pochi minuti in Timbrature da sistemare', notif?.length === 1 && Math.round((new Date(notif[0].exit_at) - new Date(notif[0].entry_at)) / 60000) === 7 && !!notif[0].exit_log_id, notif);

    // 2. Dopo un turno di pochi minuti oggi, la timbratura successiva chiede se sta entrando
    const b = await worker('Sera');
    await log(b, 'ENTRY', ago(70));
    await log(b, 'EXIT', ago(63));
    const r3 = await punch(b);
    check('nuova timbratura dopo un turno di 7 min oggi: 409 ENTRY_AFTER_SHORT', r3.status === 409 && r3.body.reason === 'ENTRY_AFTER_SHORT' && !!r3.body.exit_at, r3);
    check('…niente scritto', await count(b) === 2);
    const h = await post(`/badge/${b.badge_code}/help-request`, { site_id: site.id, reason: 'ENTRY_NOT_EXIT' });
    const hn = await waitRows(() => supabase.from('presence_fix_requests').select('kind, entry_at, exit_at, touch_at, exit_log_id').eq('worker_id', b.id).eq('kind', 'entry_not_exit'));
    check('"No, sto andando via": caso da sistemare con gli orari (entrata, uscita breve, tocco)', h.status === 200 && hn.length === 1 && hn[0].entry_at && hn[0].exit_at && hn[0].touch_at && hn[0].exit_log_id, { h, hn });
    check('…e ancora niente scritto', await count(b) === 2);
    const r4 = await punch(b, { confirmed: true });
    check('"Sì, entro adesso": entrata scritta', r4.status === 200 && r4.body.event_type === 'ENTRY', r4);

    // 3. Turno normale: nessuna domanda
    const c = await worker('Normale');
    await log(c, 'ENTRY', ago(240));
    const r5 = await punch(c);
    check('turno di 4 ore: uscita senza domande', r5.status === 200 && r5.body.event_type === 'EXIT', r5);

    // 4. F-184: reinvio con lo stesso client_request_id → nessuna domanda, stesso evento
    const d = await worker('Reinvio');
    const crid = crypto.randomUUID();
    await log(d, 'ENTRY', ago(3), { client_request_id: crid });
    const r6 = await punch(d, { client_request_id: crid });
    check('reinvio stesso client_request_id: restituisce l\'entrata già scritta (F-184)', r6.status === 200 && r6.body.event_type === 'ENTRY', r6);
    check('…niente scritto in più', await count(d) === 1);

    // 5. Sotto i 60 secondi resta PUNCH_TOO_SOON
    const e = await worker('Doppio');
    await log(e, 'ENTRY', new Date(Date.now() - 20000).toISOString());
    const r7 = await punch(e);
    check('sotto i 60 secondi: PUNCH_TOO_SOON come prima', r7.status === 429 && r7.body.error === 'PUNCH_TOO_SOON', r7);

    // 6. QR (/scan/punch): stessa conferma
    const f = await worker('QR');
    await ins('worksite_workers', { company_id: company.id, site_id: site.id, worker_id: f.id, status: 'active' });
    const token = crypto.randomBytes(32).toString('hex');
    await ins('worker_device_sessions', { company_id: company.id, worker_id: f.id, token_hash: crypto.createHash('sha256').update(token).digest('hex') });
    await log(f, 'ENTRY', ago(10), { method: 'personal_phone' });
    const r8 = await post('/scan/punch', { worksite_id: site.id, session_token: token, ...GPS });
    check('QR: uscita 10 min dopo l\'entrata → 409 CONFIRM_REQUIRED', r8.status === 409 && r8.body.reason === 'SHORT_EXIT', r8);
    const r9 = await post('/scan/punch', { worksite_id: site.id, session_token: token, ...GPS, confirmed: true });
    check('QR: confermata → uscita scritta', r9.status === 200 && r9.body.event_type === 'EXIT', r9);
    const before = await count(f);
    const g = await post('/scan/help-entry-not-exit', { worksite_id: site.id, session_token: token });
    const gn = await waitRows(() => supabase.from('presence_fix_requests').select('kind, touch_at').eq('worker_id', f.id).eq('kind', 'entry_not_exit'));
    check('QR "No, sto andando via": caso da sistemare, niente scritto', g.status === 200 && gn.length === 1 && !!gn[0].touch_at && await count(f) === before, { g, gn });
    check('QR "No, sto andando via" senza sessione valida: 401', (await post('/scan/help-entry-not-exit', { worksite_id: site.id, session_token: 'b'.repeat(64) })).status === 401);
  } finally {
    server.close();
    await supabase.from('notifications').delete().eq('company_id', company.id);
    await supabase.from('presence_fix_requests').delete().eq('company_id', company.id);
    await supabase.from('worker_device_sessions').delete().eq('company_id', company.id);
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
