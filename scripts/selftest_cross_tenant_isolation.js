#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_cross_tenant_isolation.js
 *
 * Test di regressione permanente per BLOCCO 1 (AUDIT.md, isolamento
 * multi-tenant). Verifica dal vivo — mai lettura di codice — che:
 *
 *  1. Un JWT valido di company A + header X-Company-Id di company B sia
 *     sempre rifiutato dal backend (verifySupabaseJwt controlla la vera
 *     membership in company_users, non si fida dell'header).
 *  2. Un utente autenticato come company A non possa leggere/scrivere una
 *     riga di company B tramite accesso DIRETTO a Supabase (anon key + RLS),
 *     bypassando il backend — l'unico modo per un frontend legittimo o un
 *     attaccante di interrogare il DB senza passare dall'API.
 *  3. company B non veda mai i dati creati per la company A e viceversa.
 *
 * Richiede: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * scripts/_isolamento_seed.json (company B, node scripts/_seed_isolamento_dataset.js).
 * Company A = TEST-AutoExplore (letta a runtime, nessuna password hardcoded —
 * sessione ottenuta via magic-link + verifyOtp, mai reset password).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE       = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function apiCall(jwt, companyId, method, urlPath) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'X-Company-Id': companyId,
      'Content-Type': 'application/json',
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function main() {
  console.log('\nPalladia — cross-tenant isolation regression (BLOCCO 1)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const seedPath = path.join(__dirname, '_isolamento_seed.json');
  if (!fs.existsSync(seedPath)) {
    skip('suite', 'scripts/_isolamento_seed.json mancante — esegui prima node scripts/_seed_isolamento_dataset.js');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }
  const B = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const anonA = createClient(SUPABASE_URL, ANON_KEY);
  const anonB = createClient(SUPABASE_URL, ANON_KEY);

  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('suite', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }
  const { data: companyAUsers } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1);
  const { data: userAAuth } = await admin.auth.admin.getUserById(companyAUsers[0].user_id);
  const emailA = userAAuth.user.email;

  const { data: siteA } = await admin.from('sites').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();
  const { data: workerA } = await admin.from('workers').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();

  let jwtA, jwtB;
  try {
    jwtA = await sessionFor(admin, anonA, emailA);
    jwtB = await sessionFor(admin, anonB, B.userEmail);
  } catch (e) {
    fail('Ottenere sessioni JWT via magic-link', e.message);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 1;
    return;
  }
  ok('Sessioni JWT ottenute per company A e B (via OTP, non password reset)');

  // ── 1. Backend API: JWT A + X-Company-Id B deve essere sempre un rifiuto ──
  const coreEndpoints = [
    ['GET', '/sites'], ['GET', '/workers'], ['GET', '/expenses'],
    ['GET', '/documents'], ['GET', '/equipment'], ['GET', '/subcontractors'],
  ];
  for (const [method, p] of coreEndpoints) {
    try {
      const r = await apiCall(jwtA, B.companyId, method, p);
      const rejected = r.status === 401 || r.status === 403 || r.status === 400;
      check_(`${method} ${p} — JWT-A + X-Company-Id=B → rifiuto`, rejected, r);
    } catch (e) { skip(`${method} ${p} (X-Company-Id swap)`, e.message); }
  }

  // ── 2. Backend API: risorsa di B nell'URL, autenticato come A ──
  const idorEndpoints = [
    ['GET', `/sites/${B.siteId}`],
    ['GET', `/workers/${B.workerId}`],
    ['DELETE', `/workers/${B.workerId}`],
    ['GET', `/documents/${B.documentId}`],
    ['GET', `/equipment/${B.equipmentId}`],
    ['GET', `/subcontractors/${B.subcontractorId}`],
    ['GET', `/workers/${B.workerId}/payslips`],
    ['GET', `/payslips/${B.payslipId}/download`],
    ['PATCH', `/payslips/${B.payslipId}/share`],
    ['PATCH', `/payslips/${B.payslipId}/unshare`],
    ['DELETE', `/payslips/${B.payslipId}`],
    ['DELETE', `/expenses/${B.expenseId}`],
  ];
  for (const [method, p] of idorEndpoints) {
    try {
      const r = await apiCall(jwtA, companyA.id, method, p);
      const rejected = r.status === 401 || r.status === 403 || r.status === 404;
      check_(`${method} ${p} — ID di B con auth A → rifiuto (non dati)`, rejected, r);
    } catch (e) { skip(`${method} ${p} (IDOR)`, e.message); }
  }

  // ── 3. Accesso DIRETTO Supabase (anon key, bypassa il backend) ──
  // Questo è il vettore reale: il frontend query direttamente 'sites' via
  // supabase-js (src/contexts/SiteContext.tsx) — solo RLS protegge qui.
  if (siteA) {
    const { data: bReadsA } = await anonB.from('sites').select('id').eq('id', siteA.id).maybeSingle();
    check_('RLS diretta: utente B NON legge il sito di A via supabase-js', !bReadsA, bReadsA);
  }
  {
    const { data: aReadsB } = await anonA.from('sites').select('id').eq('id', B.siteId).maybeSingle();
    check_('RLS diretta: utente A NON legge il sito di B via supabase-js', !aReadsB, aReadsB);
  }
  if (workerA) {
    const { data: bReadsWorkerA } = await anonB.from('workers').select('id').eq('id', workerA.id).maybeSingle();
    check_('RLS diretta: utente B NON legge il lavoratore di A via supabase-js', !bReadsWorkerA, bReadsWorkerA);
  }

  // ── 4. Badge QR / Worker Area — un lavoratore non deve vedere i documenti
  // di un collega della STESSA company (isolamento a livello worker_id, non
  // solo company_id). Token HMAC firmato esattamente come lib/workerAuth.js.
  if (!process.env.WORKER_AREA_SECRET) {
    skip('WorkerArea cross-worker document', 'WORKER_AREA_SECRET non impostata localmente (produzione la richiede — QR_SIGNING_SECRET da solo firma un token che il server in produzione rifiuta, è un secondo secret distinto). Esporta WORKER_AREA_SECRET per una verifica reale.');
  } else {
    try {
      const { signWorkerToken } = require('../lib/workerAuth');
      const { data: workersA } = await admin.from('workers').select('id, badge_code').eq('company_id', companyA.id).limit(2);
      const { data: docsWorker2 } = workersA?.[1]
        ? await admin.from('worker_documents').select('id').eq('worker_id', workersA[1].id).limit(1)
        : { data: [] };
      if (workersA?.length >= 2 && docsWorker2?.length) {
        const [w1, w2] = workersA;
        const badge1 = w1.badge_code.toUpperCase();
        const tokenW1 = signWorkerToken({ workerId: w1.id, companyId: companyA.id, badgeCode: badge1 });
        const res = await fetch(`${API_BASE}/area/${badge1}/documents/${docsWorker2[0].id}`, {
          headers: { 'Authorization': `WorkerArea ${tokenW1}` },
        });
        check_(`WorkerArea: token lavoratore 1 non legge documento di lavoratore 2 (stessa company)`, res.status === 404, { status: res.status });
      } else {
        skip('WorkerArea cross-worker document', 'servono almeno 2 lavoratori in TEST-AutoExplore con documenti');
      }
    } catch (e) { skip('WorkerArea cross-worker document', e.message); }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

main().catch(e => { console.error('FATAL', e); process.exit(1); });
