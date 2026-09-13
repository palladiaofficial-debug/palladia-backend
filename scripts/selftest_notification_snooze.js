#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_notification_snooze.js
 *
 * Regressione per F-182 (AUDIT.md) — le notifiche di compliance non immediata
 * ("idoneità mediche mancanti", "formazione in scadenza") ripetevano l'alert
 * Telegram ogni giorno finché il documento non veniva davvero caricato,
 * senza alcun modo per l'admin di segnalare "prenotato, in fase di rinnovo"
 * e ridurre il fastidio nel frattempo. Richiesta esplicita dell'utente.
 *
 * Copre: (1) isSnoozeActive (funzione pura) — attivo entro la data, mai per
 * worker_doc_expiry già scaduto (severity critical), sì per worker_doc_missing
 * anche se la sua severity è sempre 'critical'; (2) ruolo viewer negato 403 su
 * PATCH .../snooze, owner riesce; (3) snooze rifiutato (400 ALREADY_EXPIRED)
 * su un worker_doc_expiry già scaduto; (4) upsertNotification (la stessa
 * funzione usata dai due cron) restituisce snoozed_until invariato finché
 * attivo — un secondo "giro" non lo cancella, non lo tratta come "risolto";
 * (5) DELETE .../snooze annulla.
 *
 * Usa upsertNotification() direttamente (stessa funzione chiamata da
 * workerMissingDocsCron.js/workerExpiryCron.js) invece di eseguire i cron
 * interi: i cron veri scansionano TUTTE le company e mandano Telegram reale
 * a ogni cliente — eseguirli da un test contro l'ambiente di produzione
 * spammerebbe ogni azienda reale. upsertNotification() è invece già
 * correttamente scoped a companyId, quindi sicuro da chiamare qui.
 *
 * Nota: richiede la migration 207 (notifications.snoozed_until/snoozed_by)
 * già applicata — se la colonna non esiste, le sezioni DB-dipendenti
 * falliscono con un errore chiaro (non uno skip silenzioso: è uno stato
 * "fix scritto, migration non ancora eseguita", non "ambiente non
 * configurato").
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (o SUPABASE_KEY), SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { isSnoozeActive, upsertNotification } = require('../services/expiryHelper');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

function inDaysStr(n) { return new Date(Date.now() + n * 86400000).toISOString().split('T')[0]; }

async function main() {
  console.log('\nPalladia regression — snooze notifiche compliance non immediata (F-182)\n');

  // ── 1. isSnoozeActive — pura, nessun DB ────────────────────────────────────
  const in10 = inDaysStr(10), past = inDaysStr(-3);
  check('snooze futuro, worker_doc_missing (severity sempre critical): attivo',
    isSnoozeActive({ snoozedUntil: in10, type: 'worker_doc_missing', severity: 'critical' }) === true);
  check('snooze futuro, worker_doc_expiry severity warning: attivo',
    isSnoozeActive({ snoozedUntil: in10, type: 'worker_doc_expiry', severity: 'warning' }) === true);
  check('snooze futuro, worker_doc_expiry severity critical (scaduto per davvero): MAI attivo',
    isSnoozeActive({ snoozedUntil: in10, type: 'worker_doc_expiry', severity: 'critical' }) === false);
  check('snooze già scaduto (data nel passato): non più attivo',
    isSnoozeActive({ snoozedUntil: past, type: 'worker_doc_missing', severity: 'critical' }) === false);
  check('nessuno snooze (null): non attivo',
    isSnoozeActive({ snoozedUntil: null, type: 'worker_doc_missing', severity: 'critical' }) === false);

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('sezione DB/HTTP', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const admin     = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonOwner = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonView  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Colonna esistente? Se la migration 207 non è ancora stata applicata,
  // fallisce qui con un errore chiaro invece di comportarsi in modo strano
  // più avanti.
  const { error: colErr } = await admin.from('notifications').select('snoozed_until').limit(1);
  if (colErr) {
    fail('migrations/207_notifications_snooze.sql applicata (colonna notifications.snoozed_until esiste)', colErr.message);
    console.log('\n  → esegui: node scripts/run-migration-207.js\n');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 1;
    return;
  }

  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-F182-NotifSnooze' }]).select('id').single();
  const companyId = company.id;

  const suffix = Date.now();
  const { data: workerMissing } = await admin.from('workers').insert([{
    company_id: companyId, full_name: `TEST-F182-Missing ${suffix}`, fiscal_code: `F182M${suffix}`.slice(0, 16).toUpperCase(),
    badge_code: `F182M-${suffix}`, is_active: true,
  }]).select('id').single();

  const viewerEmail = `test-f182-viewer-${suffix}@palladia-test.local`;
  const ownerEmail  = `test-f182-owner-${suffix}@palladia-test.local`;
  const { data: viewerUser } = await admin.auth.admin.createUser({ email: viewerEmail, email_confirm: true });
  const { data: ownerUser }  = await admin.auth.admin.createUser({ email: ownerEmail,  email_confirm: true });
  await admin.from('company_users').insert([
    { company_id: companyId, user_id: viewerUser.user.id, role: 'viewer' },
    { company_id: companyId, user_id: ownerUser.user.id,  role: 'owner'  },
  ]);
  const viewerJwt = await sessionFor(admin, anonView,  viewerEmail);
  const ownerJwt  = await sessionFor(admin, anonOwner, ownerEmail);

  try {
    // ── Simula quello che farebbe workerMissingDocsCron.js per questo lavoratore ──
    await upsertNotification({
      companyId, type: 'worker_doc_missing', severity: 'critical',
      title: `${workerMissing.full_name} — Visita medica`, body: 'Documenti obbligatori mancanti',
      entityType: 'worker', entityId: workerMissing.id,
    });
    const { data: notifMissing } = await admin.from('notifications')
      .select('id, type, severity').eq('company_id', companyId).eq('type', 'worker_doc_missing')
      .eq('entity_id', workerMissing.id).maybeSingle();
    check('upsertNotification ha creato la notifica per il lavoratore senza idoneità', !!notifMissing, notifMissing);

    // ── Simula un'idoneità in scadenza tra 5gg (severity warning) su un secondo lavoratore ──
    const { data: workerExpiring } = await admin.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F182-Expiring ${suffix}`, fiscal_code: `F182E${suffix}`.slice(0, 16).toUpperCase(),
      badge_code: `F182E-${suffix}`, is_active: true,
    }]).select('id').single();
    const fakeDocIdExpiring = workerExpiring.id; // entity_id per worker_doc_expiry è l'id del documento — qui basta un id stabile
    await upsertNotification({
      companyId, type: 'worker_doc_expiry', severity: 'warning',
      title: `${workerExpiring.full_name} — Idoneità medica`, body: 'scade in 5 giorni',
      entityType: 'worker_document', entityId: fakeDocIdExpiring,
    });
    const { data: notifExpiring } = await admin.from('notifications')
      .select('id, type, severity').eq('company_id', companyId).eq('type', 'worker_doc_expiry')
      .eq('entity_id', fakeDocIdExpiring).maybeSingle();
    check('upsertNotification ha creato la notifica per l\'idoneità in scadenza (severity warning)',
      !!notifExpiring && notifExpiring.severity === 'warning', notifExpiring);

    if (notifMissing && notifExpiring) {
      // ── Ruolo viewer: PATCH .../snooze negato ──────────────────────────────
      const viewerRes = await fetch(`${BASE}/api/v1/notifications/${notifMissing.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${viewerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(14) }),
      });
      check('ruolo viewer: PATCH .../snooze negato con 403', viewerRes.status === 403, { status: viewerRes.status });

      // ── Ruolo owner: snooze riesce sul missing-doc (nonostante severity critical) ──
      const ownerRes = await fetch(`${BASE}/api/v1/notifications/${notifMissing.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(14) }),
      });
      const ownerBody = await ownerRes.json().catch(() => null);
      check('ruolo owner: PATCH .../snooze su worker_doc_missing riesce (200) — è il caso segnalato dall\'utente',
        ownerRes.status === 200, { status: ownerRes.status, body: ownerBody });

      // ── Snooze riesce anche sull'idoneità in scadenza (severity warning, non critical) ──
      const ownerRes2 = await fetch(`${BASE}/api/v1/notifications/${notifExpiring.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(10) }),
      });
      check('owner: PATCH .../snooze su worker_doc_expiry severity warning riesce (200)', ownerRes2.status === 200, { status: ownerRes2.status });

      // ── Data nel passato → 400 ──────────────────────────────────────────────
      const pastRes = await fetch(`${BASE}/api/v1/notifications/${notifMissing.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(-1) }),
      });
      check('data nel passato: 400 INVALID_PARAMS', pastRes.status === 400, { status: pastRes.status });

      // ── Un secondo "giro" di upsertNotification (come farebbe il cron il giorno dopo)
      // deve restituire lo snoozed_until intatto — non è "risolto", solo silenziato ──
      const secondRun = await upsertNotification({
        companyId, type: 'worker_doc_missing', severity: 'critical',
        title: `${workerMissing.full_name} — Visita medica`, body: 'Documenti obbligatori mancanti',
        entityType: 'worker', entityId: workerMissing.id,
      });
      check('secondo upsertNotification: snoozedUntil ancora quello impostato (non azzerato dal semplice re-upsert)',
        secondRun.snoozedUntil === inDaysStr(14), secondRun);
      check('secondo upsertNotification: isSnoozeActive lo considera ancora attivo',
        isSnoozeActive({ snoozedUntil: secondRun.snoozedUntil, type: 'worker_doc_missing', severity: 'critical' }) === true);

      // ── DELETE annulla lo snooze ────────────────────────────────────────────
      const delRes = await fetch(`${BASE}/api/v1/notifications/${notifMissing.id}/snooze`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId },
      });
      check('DELETE .../snooze riesce (200)', delRes.status === 200, { status: delRes.status });
      const { data: afterDelete } = await admin.from('notifications')
        .select('snoozed_until').eq('id', notifMissing.id).maybeSingle();
      check('dopo la DELETE, snoozed_until torna null', afterDelete?.snoozed_until === null, afterDelete);
    }

    // ── Un worker_doc_expiry già SCADUTO (severity critical) non è snoozabile ──
    const { data: workerExpired } = await admin.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F182-Expired ${suffix}`, fiscal_code: `F182X${suffix}`.slice(0, 16).toUpperCase(),
      badge_code: `F182X-${suffix}`, is_active: true,
    }]).select('id').single();
    await upsertNotification({
      companyId, type: 'worker_doc_expiry', severity: 'critical',
      title: `${workerExpired.full_name} — Idoneità medica`, body: 'scaduto 2 giorni fa',
      entityType: 'worker_document', entityId: workerExpired.id,
    });
    const { data: notifExpired } = await admin.from('notifications')
      .select('id, severity').eq('company_id', companyId).eq('type', 'worker_doc_expiry')
      .eq('entity_id', workerExpired.id).maybeSingle();
    if (notifExpired) {
      const expiredSnoozeRes = await fetch(`${BASE}/api/v1/notifications/${notifExpired.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(14) }),
      });
      const expiredSnoozeBody = await expiredSnoozeRes.json().catch(() => null);
      check('worker_doc_expiry GIÀ SCADUTO: snooze rifiutato (400 ALREADY_EXPIRED) — nessun falso senso di "gestito"',
        expiredSnoozeRes.status === 400 && expiredSnoozeBody?.error === 'ALREADY_EXPIRED',
        { status: expiredSnoozeRes.status, body: expiredSnoozeBody });
    } else {
      fail('notifica creata per l\'idoneità scaduta', notifExpired);
    }

    // ── Tipo non snoozabile (es. equipment_expiry) → 400 NOT_SNOOZABLE ─────────
    const { data: eqWorker } = await admin.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F182-NotSnoozable ${suffix}`, fiscal_code: `F182N${suffix}`.slice(0, 16).toUpperCase(),
      badge_code: `F182N-${suffix}`, is_active: true,
    }]).select('id').single();
    await upsertNotification({
      companyId, type: 'equipment_expiry', severity: 'warning',
      title: 'Mezzo test — Assicurazione', body: 'scade in 10 giorni',
      entityType: 'equipment', entityId: eqWorker.id, // riuso id come entity_id fittizio, non serve un mezzo reale qui
    });
    const { data: notifOther } = await admin.from('notifications')
      .select('id').eq('company_id', companyId).eq('type', 'equipment_expiry').eq('entity_id', eqWorker.id).maybeSingle();
    if (notifOther) {
      const otherRes = await fetch(`${BASE}/api/v1/notifications/${notifOther.id}/snooze`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: inDaysStr(14) }),
      });
      const otherBody = await otherRes.json().catch(() => null);
      check('tipo non nella whitelist (equipment_expiry): 400 NOT_SNOOZABLE',
        otherRes.status === 400 && otherBody?.error === 'NOT_SNOOZABLE', { status: otherRes.status, body: otherBody });
    } else {
      fail('notifica di test equipment_expiry creata', notifOther);
    }
  } finally {
    await admin.from('notifications').delete().eq('company_id', companyId);
    await admin.from('worker_documents').delete().eq('company_id', companyId);
    await admin.from('company_users').delete().eq('company_id', companyId);
    await admin.auth.admin.deleteUser(viewerUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(ownerUser.user.id).catch(() => {});
    await admin.from('workers').delete().eq('company_id', companyId);
    await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
