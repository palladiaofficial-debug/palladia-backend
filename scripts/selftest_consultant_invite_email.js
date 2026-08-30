#!/usr/bin/env node
/**
 * scripts/selftest_consultant_invite_email.js
 *
 * F-103 (AUDIT.md) — segnalato dall'utente: un invito creato da uno Studio
 * Professionale (POST /api/v1/consultant/clients/invite) non faceva mai
 * arrivare nessuna email al destinatario. Causa reale: l'endpoint aveva un
 * TODO mai completato ("invia email di invito quando template pronto") —
 * l'unico output era l'invite_link mostrato al consulente da copiare a
 * mano. Fix: services/email.js (sendConsultantInviteEmail,
 * sendConsultantPendingInviteEmail) + wiring in routes/v1/consultantProfile.js.
 *
 * Questo test chiama il vero endpoint di produzione/staging e verifica, via
 * l'API reale di Resend (non un mock), che un'email sia stata davvero
 * accodata per il destinatario dell'invito.
 *
 * Env: TEST_BASE_URL (default http://localhost:3001), SUPABASE_URL,
 * SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
 * E2E_CONSULENTE_EMAIL, E2E_CONSULENTE_PASSWORD. Se mancano, il test si
 * salta — non è una regressione, è un ambiente senza le credenziali di test.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const E2E_CONSULENTE_EMAIL = process.env.E2E_CONSULENTE_EMAIL;
const E2E_CONSULENTE_PASSWORD = process.env.E2E_CONSULENTE_PASSWORD;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\nPalladia regression — invito Studio Professionale, email realmente inviata (F-103)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !RESEND_API_KEY || !E2E_CONSULENTE_EMAIL || !E2E_CONSULENTE_PASSWORD) {
    skip('invito consulente invia email reale', 'fixture E2E consulente/Resend non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin  = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon   = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const resend = new Resend(RESEND_API_KEY);

  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_CONSULENTE_EMAIL, password: E2E_CONSULENTE_PASSWORD });
  if (loginErr || !session?.session) {
    fail('login bot E2E consulente', loginErr?.message);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 1;
    return;
  }
  const jwt = session.session.access_token;

  const testEmail = `test-e2e-invite-${Date.now()}@palladia-test.local`;
  let clientId = null;

  try {
    const res = await fetch(`${BASE}/api/v1/consultant/clients/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_email: testEmail }),
    });
    const body = await res.json().catch(() => ({}));
    check('POST /consultant/clients/invite risponde 201', res.status === 201, { status: res.status, body });
    clientId = body?.client?.id || null;
    check('invite_link presente nella risposta', typeof body?.invite_link === 'string' && body.invite_link.includes('/formazione/accetta-consulente/'), body?.invite_link);

    // L'invio è fire-and-forget lato server — piccola attesa prima di controllare Resend.
    await sleep(3000);

    const { data: list, error: listErr } = await resend.emails.list({ limit: 10 });
    check('Resend API raggiungibile', !listErr, listErr);

    const sent = (list?.data?.data || []).find(e => (e.to || []).includes(testEmail));
    check('un\'email è stata davvero accodata per il destinatario dell\'invito', !!sent, list?.data?.data?.slice(0, 3));
    if (sent) {
      check('subject cita il nome dello studio invitante', /ti invita su Palladia|ti ha invitato su Palladia/.test(sent.subject || ''), sent.subject);
    }
  } finally {
    if (clientId) await admin.from('consultant_clients').delete().eq('id', clientId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('[selftest_consultant_invite_email] errore imprevisto:', e.message); process.exit(1); });
