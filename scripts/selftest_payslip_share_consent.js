#!/usr/bin/env node
/**
 * scripts/selftest_payslip_share_consent.js
 *
 * F-212 (AUDIT.md, 2026-09-17): il titolare ha chiesto di chiedere ai
 * lavoratori il consenso esplicito alla condivisione della propria busta
 * paga con il soggetto esterno incaricato dei pagamenti — stesso schema del
 * consenso privacy/GPS obbligatorio (F-178): un gate verificato dal server,
 * non un flag cosmetico, bloccante finché non viene accettato.
 *
 * Verifica dal vivo, HTTP reale contro produzione, nessun mock:
 * 1) se l'azienda NON ha alcun accesso pagatore attivo, il lavoratore vede
 *    le sue buste paga subito — nessuna informativa su una pratica che non
 *    esiste.
 * 2) appena l'azienda attiva un accesso pagatore, la lista buste paga (e il
 *    PDF, anche con un id già noto) si bloccano con PAYSLIP_SHARE_CONSENT_
 *    REQUIRED finché il lavoratore non accetta.
 * 3) accettare scrive DAVVERO in DB (colonne su `workers` + riga durevole in
 *    admin_audit_log), non solo una risposta 200 — e sblocca subito l'accesso.
 *
 * Stesso schema di autenticazione di scripts/selftest_heat_certification.js
 * (utente ci-test@palladia.internal, company MSCedilizia di test).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { hashPin } = require('../lib/pinHash');
const { PAYSLIP_SHARE_CONSENT_VERSION } = require('../lib/workerPayslipShareConsent');

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
  console.log('\n\x1b[1mConsenso lavoratore alla condivisione busta paga col pagatore (F-212)\x1b[0m\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('consenso condivisione busta paga', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('consenso condivisione busta paga', 'utente/company ci-test non trovati'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const pin = '482913';
  const { data: worker, error: wErr } = await admin.from('workers').insert({
    company_id: auth.companyId, full_name: 'TEST-E2E F212 ShareConsent', badge_code: badgeCode, is_active: true,
    area_pin_hash: await hashPin(pin),
  }).select('id').single();
  if (wErr) { console.error('Impossibile creare il worker di test:', wErr.message); process.exitCode = 1; return; }

  let payslip, storagePath, payerSessionId;

  try {
    console.log('Blocco 1 — senza alcun accesso pagatore attivo, nessun gate (live HTTP)\n');

    storagePath = `payslips/${auth.companyId}/${worker.id}/2026-08.pdf`;
    await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
    const { data: p, error: pErr } = await admin.from('payslips').insert({
      company_id: auth.companyId, worker_id: worker.id, period_year: 2026, period_month: 8,
      filename: 'test-share-consent.pdf', file_path: storagePath, file_size: 20, status: 'shared', shared_at: new Date().toISOString(),
    }).select('id').single();
    if (pErr) throw new Error('setup busta paga fallito: ' + pErr.message);
    payslip = p;

    const loginRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const loginBody = await loginRes.json();
    check('login area lavoratore riesce', loginRes.status === 200 && !!loginBody.token, loginBody);
    const authHeaders = { Authorization: `WorkerArea ${loginBody.token}` };

    const preRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslips`, { headers: authHeaders });
    check('senza accesso pagatore attivo, la lista si vede subito (200, nessun gate)', preRes.status === 200, preRes.status);

    console.log('\nBlocco 2 — appena l\'azienda attiva un accesso pagatore, il gate scatta (live HTTP)\n');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const { data: payerSession, error: sErr } = await admin.from('payslip_payer_sessions').insert({
      company_id: auth.companyId, email: 'test-share-consent-payer@example.com', token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    }).select('id').single();
    if (sErr) throw new Error('setup sessione pagatore fallito: ' + sErr.message);
    payerSessionId = payerSession.id;

    const blockedRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslips`, { headers: authHeaders });
    const blockedBody = await blockedRes.json();
    check('con un accesso pagatore attivo, la lista si blocca con PAYSLIP_SHARE_CONSENT_REQUIRED',
      blockedRes.status === 403 && blockedBody.error === 'PAYSLIP_SHARE_CONSENT_REQUIRED', blockedBody);

    const blockedPdfRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslips/${payslip.id}/pdf`, { headers: authHeaders });
    const blockedPdfBody = await blockedPdfRes.json();
    check('anche il PDF si blocca allo stesso modo (difesa in profondità, id già noto non basta)',
      blockedPdfRes.status === 403 && blockedPdfBody.error === 'PAYSLIP_SHARE_CONSENT_REQUIRED', blockedPdfBody);

    console.log('\nBlocco 3 — accettare scrive DAVVERO in DB e sblocca subito (live HTTP)\n');

    const acceptRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslip-share-consent`, { method: 'POST', headers: authHeaders });
    check('accettare il consenso -> 200', acceptRes.status === 200, acceptRes.status);

    const { data: workerAfter } = await admin.from('workers').select('payslip_share_consent_accepted_at, payslip_share_consent_version').eq('id', worker.id).single();
    check('payslip_share_consent_accepted_at valorizzato davvero in DB (non solo la risposta HTTP)', !!workerAfter?.payslip_share_consent_accepted_at, workerAfter);
    check('payslip_share_consent_version corrisponde alla versione corrente', workerAfter?.payslip_share_consent_version === PAYSLIP_SHARE_CONSENT_VERSION, workerAfter);

    const { data: auditRow } = await admin.from('admin_audit_log')
      .select('id, action, target_id, payload').eq('target_id', worker.id).eq('action', 'worker.payslip_share_consent_accepted')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    check('riga durevole in admin_audit_log (prova consultabile, non solo lo stato presente)', !!auditRow, auditRow);
    check('la riga di audit riporta la versione accettata', auditRow?.payload?.version === PAYSLIP_SHARE_CONSENT_VERSION, auditRow);

    const afterAcceptRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslips`, { headers: authHeaders });
    const afterAcceptBody = await afterAcceptRes.json();
    const seesPayslip = Array.isArray(afterAcceptBody) && afterAcceptBody.some(r => r.id === payslip.id);
    check('dopo aver accettato, la lista si sblocca subito (200, la busta di test compare)', afterAcceptRes.status === 200 && seesPayslip, afterAcceptBody);

    const afterAcceptPdfRes = await fetch(`${BASE}/api/v1/area/${badgeCode}/payslips/${payslip.id}/pdf`, { headers: authHeaders });
    check('e anche il PDF si apre normalmente', afterAcceptPdfRes.status === 200, afterAcceptPdfRes.status);

  } finally {
    if (payslip) await admin.from('payslips').delete().eq('id', payslip.id);
    if (storagePath) await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    if (payerSessionId) await admin.from('payslip_payer_sessions').delete().eq('id', payerSessionId);
    await admin.from('admin_audit_log').delete().eq('target_id', worker.id).eq('action', 'worker.payslip_share_consent_accepted');
    await admin.from('workers').delete().eq('id', worker.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
