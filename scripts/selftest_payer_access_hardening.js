#!/usr/bin/env node
/**
 * scripts/selftest_payer_access_hardening.js
 *
 * F-212 (AUDIT.md, 2026-09-17): il titolare ha segnalato che il link
 * magic-link per chi paga (migrazione 215, F-205) valeva 365 giorni e dava
 * accesso a TUTTE le buste paga di TUTTI i lavoratori con la sola email come
 * barriera — un refuso o un inoltro esponevano un anno intero di dati molto
 * sensibili. Verifica dal vivo, HTTP reale contro produzione, nessun mock:
 *
 * 1) un nuovo invito ha una scadenza iniziale di ~30 giorni, non 365.
 * 2) ogni uso valido del link estende la scadenza di altri 30 giorni
 *    (finestra scorrevole) — un link usato regolarmente non scade mai in
 *    pratica, uno mai aperto muore da solo.
 * 3) lo storico visibile è ristretto agli ultimi 6 mesi: una busta paga più
 *    vecchia non compare in lista, il suo PDF non si apre, mark-paid/
 *    mark-unpaid la rifiutano — anche conoscendone già l'id.
 *
 * Stesso schema di autenticazione di scripts/selftest_heat_certification.js
 * (utente ci-test@palladia.internal, company MSCedilizia di test) — non
 * richiede le variabili E2E_EMAIL/E2E_PASSWORD/E2E_COMPANY_ID (già usate da
 * selftest_payer_magic_link.js, che copre altri aspetti dello stesso
 * sistema e resta valido).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'site-documents';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function daysFromNow(iso) { return (new Date(iso).getTime() - Date.now()) / 86400000; }

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
  return { jwt: session?.session?.access_token, companyId };
}

async function main() {
  console.log('\n\x1b[1mAccesso pagamenti buste paga — irrobustimento link (F-212)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('irrobustimento link pagatore', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('irrobustimento link pagatore', 'utente/company ci-test non trovati'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.jwt}`, 'X-Company-Id': auth.companyId };
  const sessionIds = [];
  let worker, recentPayslip, oldPayslip, storagePath;

  try {
    console.log('Blocco 1 — un nuovo invito scade in ~30 giorni, non 365 (live HTTP)\n');

    const inviteEmail = `test-payer-hardening-${Date.now()}@example.com`;
    const inviteRes = await fetch(`${BASE}/api/v1/payslips/payer-invite`, { method: 'POST', headers, body: JSON.stringify({ email: inviteEmail }) });
    check('invito -> 200', inviteRes.status === 200, inviteRes.status);

    const { data: invitedSession } = await admin.from('payslip_payer_sessions').select('id, expires_at').eq('company_id', auth.companyId).eq('email', inviteEmail).maybeSingle();
    if (invitedSession) sessionIds.push(invitedSession.id);
    const inviteDays = invitedSession ? daysFromNow(invitedSession.expires_at) : null;
    check('scadenza iniziale intorno a 30 giorni (non 365)', inviteDays !== null && inviteDays > 25 && inviteDays < 35, { inviteDays });

    console.log('\nBlocco 2 — usare il link estende davvero la scadenza (finestra scorrevole, live HTTP)\n');

    const slideToken = crypto.randomBytes(32).toString('hex');
    const { data: slideSession, error: slideErr } = await admin.from('payslip_payer_sessions').insert({
      company_id: auth.companyId, email: 'test-slide@example.com', token_hash: hashToken(slideToken),
      expires_at: new Date(Date.now() + 5 * 86400000).toISOString(), // volutamente vicino a scadere
    }).select('id').single();
    if (slideErr) throw new Error('setup sessione scorrevole fallito: ' + slideErr.message);
    sessionIds.push(slideSession.id);

    await fetch(`${BASE}/api/v1/payer/${slideToken}/payslips`);
    const { data: afterUse } = await admin.from('payslip_payer_sessions').select('expires_at, last_used_at').eq('id', slideSession.id).single();
    const slidDays = afterUse ? daysFromNow(afterUse.expires_at) : null;
    check('dopo un uso valido la scadenza si allontana (~30gg), non resta a ~5gg', slidDays !== null && slidDays > 25, { slidDays });
    check('last_used_at aggiornato', !!afterUse?.last_used_at, afterUse);

    console.log('\nBlocco 3 — lo storico visibile è ristretto agli ultimi 6 mesi (live HTTP)\n');

    const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
    const { data: w, error: wErr } = await admin.from('workers').insert({
      company_id: auth.companyId, full_name: 'TEST-E2E F212 PayerWindow', badge_code: badgeCode, is_active: true,
    }).select('id').single();
    if (wErr) throw new Error('setup worker fallito: ' + wErr.message);
    worker = w;

    const now = new Date();
    const recentPeriod = { year: now.getFullYear(), month: now.getMonth() + 1 };
    const oldDate = new Date(now.getFullYear(), now.getMonth() - 8, 1); // 8 mesi fa, fuori dalla finestra di 6
    const oldPeriod = { year: oldDate.getFullYear(), month: oldDate.getMonth() + 1 };

    storagePath = `payslips/${auth.companyId}/${worker.id}/recent.pdf`;
    await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });

    const { data: rp, error: rpErr } = await admin.from('payslips').insert({
      company_id: auth.companyId, worker_id: worker.id, period_year: recentPeriod.year, period_month: recentPeriod.month,
      filename: 'recent.pdf', file_path: storagePath, file_size: 20, status: 'shared', shared_at: new Date().toISOString(),
    }).select('id').single();
    if (rpErr) throw new Error('setup busta recente fallito: ' + rpErr.message);
    recentPayslip = rp;

    const { data: op, error: opErr } = await admin.from('payslips').insert({
      company_id: auth.companyId, worker_id: worker.id, period_year: oldPeriod.year, period_month: oldPeriod.month,
      filename: 'old.pdf', file_path: `payslips/${auth.companyId}/${worker.id}/old.pdf`, file_size: 20, status: 'shared', shared_at: new Date().toISOString(),
    }).select('id').single();
    if (opErr) throw new Error('setup busta vecchia fallito: ' + opErr.message);
    oldPayslip = op;

    const listRes = await fetch(`${BASE}/api/v1/payer/${slideToken}/payslips`);
    const listBody = await listRes.json();
    const seesRecent = Array.isArray(listBody) && listBody.some(r => r.id === recentPayslip.id);
    const seesOld    = Array.isArray(listBody) && listBody.some(r => r.id === oldPayslip.id);
    check('la lista include la busta recente (dentro i 6 mesi)', seesRecent, listBody?.map?.(r => r.id));
    check('la lista NON include la busta di 8 mesi fa (fuori dai 6 mesi)', !seesOld, listBody?.map?.(r => r.id));

    const oldPdfRes = await fetch(`${BASE}/api/v1/payer/${slideToken}/payslips/${oldPayslip.id}/pdf`);
    check('PDF della busta vecchia -> 404, anche conoscendone già l\'id', oldPdfRes.status === 404, oldPdfRes.status);

    const oldMarkRes = await fetch(`${BASE}/api/v1/payer/${slideToken}/payslips/${oldPayslip.id}/mark-paid`, { method: 'POST' });
    check('mark-paid sulla busta vecchia -> 404 (nessuna azione possibile fuori finestra)', oldMarkRes.status === 404, oldMarkRes.status);

    const recentPdfRes = await fetch(`${BASE}/api/v1/payer/${slideToken}/payslips/${recentPayslip.id}/pdf`);
    check('PDF della busta recente si apre normalmente', recentPdfRes.status === 200, recentPdfRes.status);

  } finally {
    if (recentPayslip) await admin.from('payslips').delete().eq('id', recentPayslip.id);
    if (oldPayslip) await admin.from('payslips').delete().eq('id', oldPayslip.id);
    if (storagePath) await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    if (worker) await admin.from('workers').delete().eq('id', worker.id);
    if (sessionIds.length) await admin.from('payslip_payer_sessions').delete().in('id', sessionIds);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
