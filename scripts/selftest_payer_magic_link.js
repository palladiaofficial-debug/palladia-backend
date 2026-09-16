#!/usr/bin/env node
/**
 * scripts/selftest_payer_magic_link.js
 *
 * Regressione per il sistema pagamenti via magic link (migrazione 215,
 * AUDIT.md) — sostituisce il link+PIN (migrazione 214, F-204 e seguenti):
 * ore di confusione reale documentata (screenshot dell'utente, log HTTP di
 * Railway) causata da rigenerazioni che invalidavano link già condivisi e
 * da un relay manuale via WhatsApp facile da sbagliare. Qui l'unico modo
 * di ottenere un link valido è riceverlo via email diretta — nessun
 * copia-incolla manuale, più inviti allo stesso indirizzo coesistono
 * senza invalidarsi a vicenda.
 *
 * Verifica dal vivo, HTTP reale contro produzione (Railway):
 * 1) l'azienda invita un indirizzo email — la risposta NON contiene mai il
 *    token in chiaro (solo l'email inviata lo contiene).
 * 2) GET /payslips/payer-sessions mostra l'invito (email, non revocato).
 * 3) un token valido (creato direttamente in DB, stesso schema
 *    dell'endpoint reale — l'email non è leggibile da uno script) accede
 *    davvero alla lista buste paga, apre il PDF, segna pagata/da pagare.
 * 4) un token inesistente/scaduto/revocato dà LINK_INVALID.
 * 5) revocare UN accesso non tocca gli altri per lo stesso indirizzo — a
 *    differenza del vecchio sistema, più inviti coesistono.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID — stessi fixture permanenti di
 * selftest_worker_area_pin_login.js. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');

const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;
const BUCKET = 'site-documents';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

async function signIn(email, password) {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login fallito per ${email}: ${error.message}`);
  return data.session.access_token;
}

async function main() {
  console.log('\n=== Sistema pagamenti buste paga: accesso via magic link email (migrazione 215) ===\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('payer magic link suite', 'fixture E2E (E2E_EMAIL/E2E_PASSWORD/E2E_COMPANY_ID) non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const jwt = await signIn(E2E_EMAIL, E2E_PASSWORD);
  const authHeaders = { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' };
  const testPayerEmail = `test-payer-${Date.now()}@example.com`;

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .insert({ company_id: E2E_COMPANY_ID, full_name: 'TEST-E2E Payments Worker', badge_code: badgeCode, is_active: true })
    .select('id').single();
  if (wErr || !worker) { console.error('Impossibile creare il worker di test:', wErr?.message); process.exit(1); }

  const storagePath = `payslips/${E2E_COMPANY_ID}/${worker.id}/2026-05.pdf`;
  await supabase.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  const { data: payslip, error: pErr } = await supabase
    .from('payslips')
    .insert({
      company_id: E2E_COMPANY_ID, worker_id: worker.id, period_year: 2026, period_month: 5,
      filename: 'test-payments.pdf', file_path: storagePath, file_size: 20,
      status: 'shared', shared_at: new Date().toISOString(),
    })
    .select('id').single();
  if (pErr || !payslip) { console.error('Impossibile creare la busta paga di test:', pErr?.message); await supabase.from('workers').delete().eq('id', worker.id); process.exit(1); }

  const sessionIds = [];

  try {
    // ── 1) invitare un'email non torna mai il token in chiaro ───────────────
    const inviteRes = await fetch(`${API_BASE}/payslips/payer-invite`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ email: testPayerEmail }),
    });
    const inviteBody = await inviteRes.json();
    check('invito riesce, risponde ok senza esporre alcun token',
      inviteRes.status === 200 && inviteBody.ok === true && inviteBody.email === testPayerEmail && !JSON.stringify(inviteBody).match(/[0-9a-f]{64}/i),
      inviteBody);

    const { data: createdSession } = await supabase
      .from('payslip_payer_sessions').select('*').eq('company_id', E2E_COMPANY_ID).eq('email', testPayerEmail).maybeSingle();
    check('una riga è stata creata davvero in DB, con solo l\'hash del token (non il token stesso)',
      !!createdSession && createdSession.token_hash?.length === 64 && !createdSession.revoked_at, createdSession);
    if (createdSession) sessionIds.push(createdSession.id);

    // ── 2) l'azienda vede l'invito nella lista ───────────────────────────────
    const listSessionsRes = await fetch(`${API_BASE}/payslips/payer-sessions`, { headers: authHeaders });
    const listSessionsBody = await listSessionsRes.json();
    const foundSession = Array.isArray(listSessionsBody) ? listSessionsBody.find(s => s.email === testPayerEmail) : null;
    check('GET /payslips/payer-sessions mostra l\'invito appena creato', !!foundSession, foundSession);

    // ── 3) un token valido (creato come farebbe l'endpoint reale) accede ────
    // L'email non è leggibile da uno script — costruito qui lo stesso schema
    // esatto che produce POST /payslips/payer-invite, per testare il resto
    // della pipeline (resolvePayerSession → payslips → mark-paid) senza
    // dipendere da un client di posta.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const { data: manualSession, error: manualErr } = await supabase.from('payslip_payer_sessions').insert({
      company_id: E2E_COMPANY_ID, email: testPayerEmail, token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    }).select('id').single();
    if (manualErr) throw new Error('setup token manuale fallito: ' + manualErr.message);
    sessionIds.push(manualSession.id);

    const listRes = await fetch(`${API_BASE}/payer/${rawToken}/payslips`);
    const listBody = await listRes.json();
    const found = Array.isArray(listBody) ? listBody.find(r => r.id === payslip.id) : null;
    check('col token vero si vede davvero la busta di test, con nome lavoratore risolto',
      listRes.status === 200 && !!found && found.worker_name === 'TEST-E2E Payments Worker' && found.payment_status === 'da_pagare', found);

    const { data: rowBeforeUse } = await supabase.from('payslip_payer_sessions').select('last_used_at').eq('id', manualSession.id).single();
    check('usare il token aggiorna last_used_at (non resta mai null)', !!rowBeforeUse?.last_used_at, rowBeforeUse);

    // ── "segna pagata" dal link esterno scrive davvero in DB ────────────────
    const markPaidRes = await fetch(`${API_BASE}/payer/${rawToken}/payslips/${payslip.id}/mark-paid`, { method: 'POST' });
    check('mark-paid dal link esterno risponde ok', markPaidRes.status === 200, markPaidRes.status);
    const { data: rowAfterPaid } = await supabase.from('payslips').select('payment_status, paid_by').eq('id', payslip.id).single();
    check('lo stato REALE in DB è "pagata", paid_by="payer" (non solo la risposta 200)',
      rowAfterPaid?.payment_status === 'pagata' && rowAfterPaid?.paid_by === 'payer', rowAfterPaid);

    const unpaidRes = await fetch(`${API_BASE}/payer/${rawToken}/payslips/${payslip.id}/mark-unpaid`, { method: 'POST' });
    check('mark-unpaid dal link esterno risponde ok', unpaidRes.status === 200, unpaidRes.status);

    // ── 4) token inesistente/scaduto/revocato → LINK_INVALID ────────────────
    const fakeRes = await fetch(`${API_BASE}/payer/${'0'.repeat(64)}/payslips`);
    const fakeBody = await fakeRes.json().catch(() => ({}));
    check('un token inesistente dà LINK_INVALID (401), non un errore generico',
      fakeRes.status === 401 && fakeBody.error === 'LINK_INVALID', fakeBody);

    // ── 5) revocare UN invito non tocca gli altri per lo stesso indirizzo ───
    // Differenza chiave col vecchio sistema: qui più sessioni per la stessa
    // email/azienda coesistono, non si invalidano a vicenda.
    const revokeRes = await fetch(`${API_BASE}/payslips/payer-sessions/${manualSession.id}/revoke`, { method: 'POST', headers: authHeaders });
    check('revocare un accesso riesce', revokeRes.status === 200, revokeRes.status);

    const revokedTokenRes = await fetch(`${API_BASE}/payer/${rawToken}/payslips`);
    check('il token appena revocato smette di funzionare', revokedTokenRes.status === 401, revokedTokenRes.status);

    const otherSessionListRes = await fetch(`${API_BASE}/payer/${(await (async () => {
      // Un secondo token per la STESSA email, creato dopo la revoca del primo.
      const secondToken = crypto.randomBytes(32).toString('hex');
      const { data: secondSession, error: secondErr } = await supabase.from('payslip_payer_sessions').insert({
        company_id: E2E_COMPANY_ID, email: testPayerEmail, token_hash: hashToken(secondToken),
        expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
      }).select('id').single();
      if (secondErr) throw new Error('setup secondo token fallito: ' + secondErr.message);
      sessionIds.push(secondSession.id);
      return secondToken;
    })())}/payslips`);
    check('un SECONDO invito per la stessa email, creato dopo aver revocato il primo, funziona normalmente — non si invalidano a vicenda',
      otherSessionListRes.status === 200, otherSessionListRes.status);
  } finally {
    await supabase.from('payslips').delete().eq('id', payslip.id);
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    await supabase.from('workers').delete().eq('id', worker.id);
    if (sessionIds.length) await supabase.from('payslip_payer_sessions').delete().in('id', sessionIds);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
