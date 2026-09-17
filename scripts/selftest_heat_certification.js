#!/usr/bin/env node
/**
 * scripts/selftest_heat_certification.js
 *
 * F-210 (AUDIT.md, 2026-09-17): il Registro Caldo Cantiere calcolava un
 * "bollino rosso" da una stima WBGT interna (ARPAL, migrations/218). Il
 * titolare ha corretto: Worklimate (INAIL-CNR) è la fonte che le ordinanze
 * citano per lo stop cantieri, più autorevole legalmente della nostra
 * stima — ma non ha API pubblica (solo un archivio storico con login, max
 * 5 ricerche/mese, verificato via web il 2026-09-17). Il registro è quindi
 * ora un flusso di INSERIMENTO MANUALE: un utente legge l'archivio
 * Worklimate e trascrive i giorni esatti, mai un calcolo interno.
 *
 * Live HTTP contro l'API in produzione (stesso pattern di
 * selftest_weather_confirm_undo_db_consistency.js) — verifica che ogni
 * scrittura arrivi DAVVERO al DB, non solo che la risposta HTTP sia 200:
 *   Blocco 1: batch di inserimento (giorni misti verde/rosso) -> le righe
 *             esistono in site_heat_logs con risk_level esatto, comune ed
 *             entered_by tracciati.
 *   Blocco 2: confirm su un giorno rosso -> site_suspension_days ha la riga
 *             E site_heat_logs.suspension_confirmed è true in DB.
 *   Blocco 3: undo -> site_suspension_days non ha più la riga E i flag sul
 *             log sono azzerati in DB.
 *   Blocco 4: dismiss su un altro giorno rosso -> suspension_dismissed true.
 *   Blocco 5: delete corregge un errore di trascrizione (riga sparita), ma
 *             rifiuta la cancellazione di un giorno confermato (409).
 *   Blocco 6: guardie di validazione — livello non nella scala Worklimate,
 *             data malformata, comune mancante -> 400, mai un inserimento.
 *   Blocco 7: "verità legale" nel report — cita Worklimate come fonte
 *             ufficiale, mai un WBGT/ARPAL stimato, e non usa le date
 *             contrattuali del cantiere per il periodo (stesso principio
 *             già corretto in F-209).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { generateHeatReportHtml } = require('../services/heatReport');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function getCiTestAuth(admin, anon) {
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) return null;
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map(m => m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  if (!companyId) return null;
  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  return { jwt: session?.session?.access_token, userId: user.id, companyId };
}

async function main() {
  console.log('\n\x1b[1mRegistro Caldo Cantiere — inserimento manuale Worklimate (F-210)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('registro caldo Worklimate', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('registro caldo Worklimate', 'utente/company ci-test non trovati'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const { data: site } = await admin.from('sites').insert({
    company_id: auth.companyId, name: `TEST-E2E-F210-HeatWorklimate-${crypto.randomUUID().slice(0, 8)}`,
    address: 'Via Test F-210', comune: 'Genova', status: 'attivo', latitude: 44.4056, longitude: 8.9463,
    start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi',
  }).select('id, comune, address, client, start_date').single();
  const siteId = site.id;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.jwt}`, 'X-Company-Id': auth.companyId };
  const dateRed1 = '2026-07-10', dateRed2 = '2026-07-11', dateGreen = '2026-07-12', dateTypo = '2026-07-13';

  try {
    console.log('Blocco 1 — batch di inserimento scrive DAVVERO in site_heat_logs (live HTTP)\n');

    const batchRes = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/batch`, {
      method: 'POST', headers, body: JSON.stringify({
        comune: 'Genova', source_note: 'Archivio Worklimate, ricerca test F-210 del 2026-09-17',
        entries: [
          { log_date: dateRed1, risk_level: 'rosso' },
          { log_date: dateRed2, risk_level: 'rosso' },
          { log_date: dateGreen, risk_level: 'verde' },
          { log_date: dateTypo, risk_level: 'rosso' },
        ],
      }),
    });
    const batchBody = await batchRes.json().catch(() => ({}));
    check('batch -> 200', batchRes.status === 200, { status: batchRes.status, body: batchBody });
    check('imported = 4', batchBody.imported === 4, batchBody);
    check('red_flag_days = 3', batchBody.red_flag_days === 3, batchBody);

    const { data: rows } = await admin.from('site_heat_logs').select('*').eq('site_id', siteId).order('log_date');
    check('4 righe presenti davvero in DB', rows?.length === 4, rows?.length);
    check('risk_level esatto per ogni riga (non un calcolo, la trascrizione esatta)', rows?.find(r => r.log_date === dateGreen)?.risk_level === 'verde' && rows?.find(r => r.log_date === dateRed1)?.risk_level === 'rosso', rows);
    check('comune tracciato', rows?.every(r => r.comune === 'Genova'), rows?.map(r => r.comune));
    check('entered_by tracciato (mai una scrittura anonima)', rows?.every(r => r.entered_by === auth.userId), rows?.map(r => r.entered_by));

    console.log('\nBlocco 2 — confirm scrive DAVVERO su site_suspension_days E su site_heat_logs (live HTTP)\n');

    const confirmRes = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateRed1}/confirm`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    const confirmBody = await confirmRes.json().catch(() => ({}));
    check('confirm -> 200', confirmRes.status === 200, { status: confirmRes.status, body: confirmBody });

    const { data: suspRow } = await admin.from('site_suspension_days')
      .select('id, day, reason, notes').eq('site_id', siteId).eq('day', dateRed1).maybeSingle();
    check('site_suspension_days ha davvero la riga', !!suspRow, suspRow);
    check('reason = caldo', suspRow?.reason === 'caldo', suspRow);
    check('notes cita Worklimate come fonte (mai ARPAL/WBGT)', suspRow?.notes?.includes('Worklimate') && !/ARPAL|WBGT/i.test(suspRow?.notes || ''), suspRow?.notes);

    const { data: logAfterConfirm } = await admin.from('site_heat_logs')
      .select('suspension_confirmed, suspension_id').eq('site_id', siteId).eq('log_date', dateRed1).single();
    check('suspension_confirmed è davvero true in DB', logAfterConfirm?.suspension_confirmed === true, logAfterConfirm);
    check('suspension_id punta davvero alla riga creata', logAfterConfirm?.suspension_id === suspRow?.id, { a: logAfterConfirm?.suspension_id, b: suspRow?.id });

    console.log('\nBlocco 3 — undo elimina DAVVERO la sospensione e azzera i flag (live HTTP)\n');

    const undoRes = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateRed1}/undo`, { method: 'POST', headers });
    check('undo -> 200', undoRes.status === 200, undoRes.status);
    const { data: suspAfterUndo } = await admin.from('site_suspension_days').select('id').eq('site_id', siteId).eq('day', dateRed1).maybeSingle();
    check('site_suspension_days non ha più la riga', !suspAfterUndo, suspAfterUndo);
    const { data: logAfterUndo } = await admin.from('site_heat_logs')
      .select('suspension_confirmed, suspension_dismissed, suspension_id').eq('site_id', siteId).eq('log_date', dateRed1).single();
    check('flag azzerati in DB dopo undo', logAfterUndo?.suspension_confirmed === false && logAfterUndo?.suspension_id === null, logAfterUndo);

    console.log('\nBlocco 4 — dismiss ignora un giorno rosso senza sospenderlo (live HTTP)\n');

    const dismissRes = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateRed2}/dismiss`, { method: 'POST', headers });
    check('dismiss -> 200', dismissRes.status === 200, dismissRes.status);
    const { data: logAfterDismiss } = await admin.from('site_heat_logs')
      .select('suspension_dismissed, suspension_confirmed').eq('site_id', siteId).eq('log_date', dateRed2).single();
    check('suspension_dismissed true, suspension_confirmed resta false', logAfterDismiss?.suspension_dismissed === true && logAfterDismiss?.suspension_confirmed === false, logAfterDismiss);

    console.log('\nBlocco 5 — delete corregge un errore di trascrizione, ma non un giorno confermato (live HTTP)\n');

    const delTypo = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateTypo}`, { method: 'DELETE', headers });
    check('delete su riga non confermata -> 200', delTypo.status === 200, delTypo.status);
    const { data: gone } = await admin.from('site_heat_logs').select('id').eq('site_id', siteId).eq('log_date', dateTypo).maybeSingle();
    check('la riga è sparita davvero dal DB', !gone, gone);

    await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateGreen}/confirm`, { method: 'POST', headers, body: JSON.stringify({}) });
    // dateGreen è 'verde', non 'rosso' — confermabile lo stesso (l'endpoint non impone il colore),
    // usato qui solo per verificare che il DELETE sia bloccato una volta confermato.
    const delConfirmed = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateGreen}`, { method: 'DELETE', headers });
    check('delete su riga confermata -> 409 CONFIRMED (mai una cancellazione silenziosa di un dato legale)', delConfirmed.status === 409, delConfirmed.status);
    await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/${dateGreen}/undo`, { method: 'POST', headers });

    console.log('\nBlocco 6 — guardie di validazione: mai un inserimento con dati fuori scala (live HTTP)\n');

    const badLevel = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/batch`, {
      method: 'POST', headers, body: JSON.stringify({ comune: 'Genova', entries: [{ log_date: '2026-07-20', risk_level: 'bollino-rosa' }] }),
    });
    check('livello fuori dalla scala Worklimate -> 400 (mai un valore inventato)', badLevel.status === 400, badLevel.status);

    const badDate = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/batch`, {
      method: 'POST', headers, body: JSON.stringify({ comune: 'Genova', entries: [{ log_date: '20-07-2026', risk_level: 'rosso' }] }),
    });
    check('data malformata -> 400', badDate.status === 400, badDate.status);

    const noComune = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log/batch`, {
      method: 'POST', headers, body: JSON.stringify({ entries: [{ log_date: '2026-07-21', risk_level: 'rosso' }] }),
    });
    check('comune mancante -> 400 (audit trail obbligatorio)', noComune.status === 400, noComune.status);

    console.log('\nBlocco 7 — "verità legale" nel report (live, nessun mock)\n');

    const listRes = await fetch(`${BASE}/api/v1/sites/${siteId}/heat-log`, { headers });
    const { logs: liveLogs } = await listRes.json();
    check('GET heat-log riflette lo stato reale (3 righe rimaste: rosso1, rosso2 dismissed, verde)', liveLogs?.length === 3, liveLogs?.length);

    const decoyStartDate = '2020-01-01';
    const html = generateHeatReportHtml({ site: { ...site, start_date: decoyStartDate, client: 'TEST Committente' }, rows: liveLogs || [], from: undefined, to: undefined, filter: undefined });
    check('il report NON usa la data di inizio lavori del cantiere per il periodo (stesso principio F-209)', !html.includes(decoyStartDate), decoyStartDate);
    check('il report cita Worklimate come fonte ufficiale', html.includes('Worklimate'), null);
    check('il report NON parla mai di ARPAL/WBGT stimato (fonte sostituita, non affiancata)', !/ARPAL|WBGT/i.test(html), null);
    check('il report dichiara la trascrizione manuale (nessuna API pubblica)', html.includes('archivio.worklimate.it') && html.toLowerCase().includes('manual'), null);

  } finally {
    await admin.from('site_heat_logs').delete().eq('site_id', siteId);
    await admin.from('site_suspension_days').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
