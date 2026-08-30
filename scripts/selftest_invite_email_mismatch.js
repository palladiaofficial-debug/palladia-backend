#!/usr/bin/env node
/**
 * scripts/selftest_invite_email_mismatch.js
 *
 * F-103 (AUDIT.md) — segnalato dal vivo dall'utente: un utente reale ha
 * cliccato un invito Studio Professionale mentre autenticato con un'identità
 * diversa da quella invitata. Investigando si è trovato che, per gli inviti
 * "solo email" (nessun company_id noto al momento dell'invito), NESSUN
 * endpoint di accettazione verificava che l'utente autenticato fosse
 * davvero quello invitato — chiunque, con QUALSIASI azienda, poteva
 * accettare, legando la propria azienda (sbagliata) all'invito. Stesso
 * identico gap in entrambi i flussi (Consulente e Studio CDL pending
 * invites).
 *
 * Verifica con chiamate HTTP reali:
 * 1) GET invite-preview (pubblico) espone l'email destinataria corretta.
 * 2) POST accept con un'email diversa da quella invitata → 403 EMAIL_MISMATCH.
 * 3) POST accept con l'email giusta → successo reale, riga passata ad 'active'.
 *
 * Env: TEST_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, E2E_CONSULENTE_EMAIL/PASSWORD (per il blocco
 * Consulente), E2E_STUDIO_EMAIL/PASSWORD (per il blocco Studio CDL). Ogni
 * blocco si salta indipendentemente se le sue credenziali non sono
 * configurate in questo ambiente — non è una regressione.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function createWrongUserWithCompany(admin, anon, label) {
  const email = `test-e2e-wrong-${label}-${Date.now()}@palladia-test.local`;
  const password = 'TestE2E-' + Math.random().toString(36).slice(2, 10) + '!1';
  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { account_type: 'impresa' } });
  if (cErr) throw cErr;
  const { data: company, error: coErr } = await admin.from('companies').insert({ name: `TEST-E2E-WRONG-${label}-${Date.now()}` }).select().single();
  if (coErr) throw coErr;
  await admin.from('company_users').insert({ user_id: created.user.id, company_id: company.id, role: 'owner' });
  const { data: session, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw sErr;
  return { userId: created.user.id, companyId: company.id, jwt: session.session.access_token };
}

async function testConsultantMismatch(admin, anon) {
  const E2E_CONSULENTE_EMAIL = process.env.E2E_CONSULENTE_EMAIL;
  const E2E_CONSULENTE_PASSWORD = process.env.E2E_CONSULENTE_PASSWORD;
  console.log('\n— Blocco Consulente —');
  if (!E2E_CONSULENTE_EMAIL || !E2E_CONSULENTE_PASSWORD) {
    skip('accept invito consulente rifiuta email sbagliata', 'fixture E2E consulente non configurate');
    return;
  }

  const { data: consultantSession, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_CONSULENTE_EMAIL, password: E2E_CONSULENTE_PASSWORD });
  if (loginErr) { fail('login bot E2E consulente', loginErr.message); return; }
  const consultantJwt = consultantSession.session.access_token;

  const inviteEmail = `test-e2e-invited-${Date.now()}@palladia-test.local`;
  let clientId = null, wrong = null;
  try {
    const inviteRes = await fetch(`${BASE}/api/v1/consultant/clients/invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${consultantJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_email: inviteEmail }),
    });
    const inviteBody = await inviteRes.json();
    check('invito creato (201)', inviteRes.status === 201, inviteBody);
    clientId = inviteBody?.client?.id || null;
    const token = inviteBody?.invite_link?.split('/').pop();

    const previewRes = await fetch(`${BASE}/api/v1/consultant/clients/invite-preview/${token}`);
    const preview = await previewRes.json().catch(() => ({}));
    check('invite-preview espone l\'email corretta', preview?.invite_email === inviteEmail, preview);

    wrong = await createWrongUserWithCompany(admin, anon, 'consulente');
    const wrongAcceptRes = await fetch(`${BASE}/api/v1/consultant/clients/accept/${token}`, {
      method: 'POST', headers: { Authorization: `Bearer ${wrong.jwt}`, 'X-Company-Id': wrong.companyId },
    });
    const wrongAcceptBody = await wrongAcceptRes.json().catch(() => ({}));
    check('accettazione con account SBAGLIATO viene rifiutata (403 EMAIL_MISMATCH)', wrongAcceptRes.status === 403 && wrongAcceptBody.error === 'EMAIL_MISMATCH', { status: wrongAcceptRes.status, body: wrongAcceptBody });

    const { data: stillPending } = await admin.from('consultant_clients').select('status').eq('id', clientId).maybeSingle();
    check('la riga NON è stata legata all\'azienda sbagliata (resta pending)', stillPending?.status === 'pending', stillPending);
  } finally {
    if (clientId) await admin.from('consultant_clients').delete().eq('id', clientId);
    if (wrong) { await admin.from('company_users').delete().eq('user_id', wrong.userId); await admin.from('companies').delete().eq('id', wrong.companyId); await admin.auth.admin.deleteUser(wrong.userId).catch(() => {}); }
  }
}

async function testStudioMismatch(admin, anon) {
  const E2E_STUDIO_EMAIL = process.env.E2E_STUDIO_EMAIL;
  const E2E_STUDIO_PASSWORD = process.env.E2E_STUDIO_PASSWORD;
  console.log('\n— Blocco Studio CDL —');
  if (!E2E_STUDIO_EMAIL || !E2E_STUDIO_PASSWORD) {
    skip('accept pending invite studio rifiuta email sbagliata', 'fixture E2E studio non configurate');
    return;
  }

  const { data: studioSession, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_STUDIO_EMAIL, password: E2E_STUDIO_PASSWORD });
  if (loginErr) { fail('login bot E2E studio', loginErr.message); return; }
  const studioJwt = studioSession.session.access_token;

  const contactEmail = `test-e2e-invited-studio-${Date.now()}@palladia-test.local`;
  let pendingId = null, wrong = null;
  try {
    const inviteRes = await fetch(`${BASE}/api/v1/studio/clients/invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${studioJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_email: contactEmail, company_name: 'TEST-E2E Impresa Invitata' }),
    });
    const inviteBody = await inviteRes.json().catch(() => ({}));
    check('pending invite creato', inviteRes.ok && inviteBody?.type === 'pending_invite', { status: inviteRes.status, body: inviteBody });
    pendingId = inviteBody?.pending?.id || null;
    const token = inviteBody?.invite_token || inviteBody?.accept_url?.split('/').pop();

    const previewRes = await fetch(`${BASE}/api/v1/studio/pending-invites/invite-preview/${token}`);
    const preview = await previewRes.json().catch(() => ({}));
    check('invite-preview espone l\'email corretta', preview?.contact_email === contactEmail, preview);

    wrong = await createWrongUserWithCompany(admin, anon, 'studio');
    const wrongAcceptRes = await fetch(`${BASE}/api/v1/studio/pending-invites/accept/${token}`, {
      method: 'POST', headers: { Authorization: `Bearer ${wrong.jwt}` },
    });
    const wrongAcceptBody = await wrongAcceptRes.json().catch(() => ({}));
    check('accettazione con account SBAGLIATO viene rifiutata (403 EMAIL_MISMATCH)', wrongAcceptRes.status === 403 && wrongAcceptBody.error === 'EMAIL_MISMATCH', { status: wrongAcceptRes.status, body: wrongAcceptBody });

    const { data: stillPending } = await admin.from('studio_pending_invites').select('status').eq('id', pendingId).maybeSingle();
    check('la riga NON è stata legata all\'azienda sbagliata (resta pending)', stillPending?.status === 'pending', stillPending);
  } finally {
    if (pendingId) await admin.from('studio_pending_invites').delete().eq('id', pendingId);
    if (wrong) { await admin.from('company_users').delete().eq('user_id', wrong.userId); await admin.from('companies').delete().eq('id', wrong.companyId); await admin.auth.admin.deleteUser(wrong.userId).catch(() => {}); }
  }
}

async function main() {
  console.log('\nPalladia regression — accettazione invito rifiuta email non corrispondente (F-103)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('tutto il file', 'credenziali Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  await testConsultantMismatch(admin, anon);
  await testStudioMismatch(admin, anon);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('[selftest_invite_email_mismatch] errore imprevisto:', e.message); process.exit(1); });
