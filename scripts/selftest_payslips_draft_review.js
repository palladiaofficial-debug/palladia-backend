#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_payslips_draft_review.js
 *
 * Regressione per F-187 (AUDIT.md, 2026-09-14): il titolare ha chiesto un
 * "controllo mirato manuale" prima che le buste paga importate arrivino sui
 * badge dei lavoratori — prima di questo fix l'unico modo di condividerle
 * era entrare nella scheda di ogni lavoratore uno alla volta. Nuovo
 * GET /api/v1/payslips/draft elenca in un posto solo tutte le buste paga
 * ancora in bozza dell'azienda, col nome del lavoratore risolto.
 *
 * Verifica dal vivo, HTTP reale, con lo stesso JWT che userebbe l'app:
 * 1) elenca solo status='draft', mai 'shared'/'acknowledged'.
 * 2) il nome del lavoratore è risolto (non solo l'id).
 * 3) isolamento multi-tenant: un JWT di company A non vede le bozze di B.
 * 4) dopo PATCH .../share, la riga sparisce dall'elenco (non più 'draft').
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE          = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — GET /payslips/draft: revisione mirata prima della condivisione (F-187)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('payslips draft review', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  async function makeCompanyWithOwner(name) {
    const { data: company } = await admin.from('companies').insert([{ name }]).select('id').single();
    const email = `test-f187-${crypto.randomUUID()}@example.com`;
    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    if (userErr) throw new Error('createUser: ' + userErr.message);
    await admin.from('company_users').insert([{ company_id: company.id, user_id: userRes.user.id, role: 'owner' }]);
    return { company, userId: userRes.user.id, email };
  }

  async function jwtFor(email) {
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
    const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (verErr) throw verErr;
    return verified.session.access_token;
  }

  const A = await makeCompanyWithOwner('TEST-F187-DraftReviewA');
  const B = await makeCompanyWithOwner('TEST-F187-DraftReviewB');

  const { data: workerA } = await admin.from('workers').insert([{
    company_id: A.company.id, full_name: 'Luca Bianchi', fiscal_code: `F187A${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Muratore', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  async function makePayslip(companyId, workerId, month, status) {
    const filePath = `payslips/${companyId}/${workerId}/2026-${String(month).padStart(2, '0')}.pdf`;
    await admin.storage.from('site-documents').upload(filePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
    const { data } = await admin.from('payslips').insert([{
      company_id: companyId, worker_id: workerId, period_year: 2026, period_month: month,
      filename: `busta-${month}.pdf`, file_path: filePath, file_size: 20, status,
    }]).select('id').single();
    return data.id;
  }

  const draftId  = await makePayslip(A.company.id, workerA.id, 6, 'draft');
  const sharedId = await makePayslip(A.company.id, workerA.id, 7, 'shared');
  const { data: workerB } = await admin.from('workers').insert([{
    company_id: B.company.id, full_name: 'Altro Lavoratore', fiscal_code: `F187B${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Muratore', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();
  await makePayslip(B.company.id, workerB.id, 6, 'draft');

  const jwtA = await jwtFor(A.email);
  const jwtB = await jwtFor(B.email);

  async function getDrafts(jwt, companyId) {
    const r = await fetch(BASE + '/payslips/draft', { headers: { Authorization: 'Bearer ' + jwt, 'X-Company-Id': companyId } });
    return { status: r.status, body: await r.json() };
  }

  const rA1 = await getDrafts(jwtA, A.company.id);
  check('company A: la busta paga draft è nell\'elenco', rA1.body.some(p => p.id === draftId), rA1.body);
  check('company A: la busta paga già "shared" NON è nell\'elenco', !rA1.body.some(p => p.id === sharedId), rA1.body);
  const draftRow = rA1.body.find(p => p.id === draftId);
  check('il nome del lavoratore è risolto, non solo l\'id', draftRow?.worker_name === 'Luca Bianchi', draftRow);

  const rB = await getDrafts(jwtB, B.company.id);
  check('isolamento multi-tenant: il JWT di company B non vede le bozze di company A',
    !rB.body.some(p => p.id === draftId), rB.body);

  const shareRes = await fetch(BASE + `/payslips/${draftId}/share`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + jwtA, 'X-Company-Id': A.company.id } });
  check('PATCH .../share riesce', shareRes.status === 200, shareRes.status);

  const rA2 = await getDrafts(jwtA, A.company.id);
  check('dopo la condivisione, la riga sparisce dall\'elenco "da rivedere"',
    !rA2.body.some(p => p.id === draftId), rA2.body);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
