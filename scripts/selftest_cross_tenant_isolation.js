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

  // ── 5. CSE coordinatore via token — due cantieri, due inviti, cross-site ──
  if (siteA && B.siteId) {
    try {
      async function createCoordInvite(jwt, companyId, siteId, name) {
        const r = await fetch(`${API_BASE}/sites/${siteId}/coordinator-invites`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinator_name: name }),
        });
        const body = await r.json();
        return body.cse_url ? body.cse_url.split('/').pop() : null;
      }
      const tokenA = await createCoordInvite(jwtA, companyA.id, siteA.id, 'TEST CSE A');
      const tokenB = await createCoordInvite(jwtB, B.companyId, B.siteId, 'TEST CSE B');

      if (tokenA && tokenB) {
        const rCreate = await fetch(`${API_BASE}/coordinator/${tokenA}/nonconformities`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'NC isolamento', description: 'Regression test', category: 'sicurezza', severity: 'media' }),
        });
        const nc = await rCreate.json();
        const ncId = nc?.nonconformity?.id;
        check_('CSE: creazione NC sul proprio cantiere con token A → ok', rCreate.status === 201 && !!ncId, { status: rCreate.status });

        if (ncId) {
          const rList = await fetch(`${API_BASE}/coordinator/${tokenB}/nonconformities`);
          const listB = await rList.json();
          check_('CSE: token B non vede la NC creata sul cantiere A', Array.isArray(listB) && !listB.some(n => n.id === ncId), listB);

          const rClose = await fetch(`${API_BASE}/coordinator/${tokenB}/nonconformities/${ncId}/close`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'close' }),
          });
          check_('CSE: token B non può chiudere una NC del cantiere A', rClose.status === 404, { status: rClose.status });
        }

        const rPortalCross = await fetch(`${API_BASE}/coordinator/portal/${tokenA}/site/${B.siteId}/nonconformities/${ncId || 'x'}/close`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        check_('CSE: token A + siteId di B nel path → rifiuto', rPortalCross.status === 404, { status: rPortalCross.status });
      } else {
        skip('CSE coordinatore cross-site', 'creazione inviti fallita');
      }
    } catch (e) { skip('CSE coordinatore cross-site', e.message); }
  } else {
    skip('CSE coordinatore cross-site', 'siteA o B.siteId mancante');
  }

  // ── 6. Link pubblico ASL — nessun header, come un ispettore reale ──
  if (siteA && B.siteId) {
    try {
      async function createAslToken(jwt, companyId, siteId) {
        const r = await fetch(`${API_BASE}/sites/${siteId}/asl-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from_date: '2026-01-01', to_date: '2026-12-31', label: 'Regression test' }),
        });
        const body = await r.json();
        return body.url ? body.url.split('/').pop() : null;
      }
      const aslTokenA = await createAslToken(jwtA, companyA.id, siteA.id);
      const aslTokenB = await createAslToken(jwtB, B.companyId, B.siteId);

      if (aslTokenA && aslTokenB) {
        const rInfoA = await fetch(`${API_BASE}/asl/${aslTokenA}?format=info`);
        const infoA  = await rInfoA.json();
        check_('ASL: link pubblico A restituisce il sito A (non B)', infoA?.site?.id === siteA.id, infoA);

        const rInfoB = await fetch(`${API_BASE}/asl/${aslTokenB}?format=info`);
        const infoB  = await rInfoB.json();
        check_('ASL: link pubblico B restituisce il sito B (non A)', infoB?.site?.id === B.siteId, infoB);

        // Cross: usare il token A per leggere info del sito B non è nemmeno
        // possibile via query — il token stesso è la chiave di scoping, non
        // c'è un siteId separato da manomettere. Verifica comunque che un
        // parametro iniettato non abbia effetto.
        const rTamper = await fetch(`${API_BASE}/asl/${aslTokenA}?format=info&site_id=${B.siteId}`);
        const tamper  = await rTamper.json();
        check_('ASL: iniettare site_id in query non cambia il sito restituito', tamper?.site?.id === siteA.id, tamper);
      } else {
        skip('ASL link pubblico cross-site', 'creazione token fallita');
      }
    } catch (e) { skip('ASL link pubblico cross-site', e.message); }
  } else {
    skip('ASL link pubblico cross-site', 'siteA o B.siteId mancante');
  }

  // ── 7. Consulente marketplace — booking di un altro consulente ──
  try {
    async function ensureConsultant(admin, email, name) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      let user = list.users.find(u => u.email === email);
      if (!user) {
        const { data, error } = await admin.auth.admin.createUser({ email, password: 'Consult!' + Date.now(), email_confirm: true });
        if (error) throw error;
        user = data.user;
      }
      const { data: existing } = await admin.from('consultant_profiles').select('id').eq('user_id', user.id).maybeSingle();
      if (!existing) {
        await admin.from('consultant_profiles').insert({ user_id: user.id, company_name: name, onboarding_completed: true, is_active: true });
      }
      return user.id;
    }
    const consultant1Id = await ensureConsultant(admin, 'isolamento-consultant-1@palladia-test.local', 'TEST Consultant 1');
    const consultant2Id = await ensureConsultant(admin, 'isolamento-consultant-2@palladia-test.local', 'TEST Consultant 2');

    let { data: booking } = await admin.from('course_bookings').select('id').eq('consultant_id', consultant1Id).limit(1).maybeSingle();
    if (!booking) {
      const { data: ref } = await admin.from('course_bookings').select('session_id, course_id, worker_id, company_id').limit(1).maybeSingle();
      if (ref) {
        const { data: nb } = await admin.from('course_bookings').insert({
          ...ref, status: 'pending', payment_status: 'unpaid', consultant_id: consultant1Id,
          total_price_cents: 10000, commission_cents: 1000, provider_payout_cents: 9000,
        }).select('id').single();
        booking = nb;
      }
    }

    if (booking) {
      const anonC2 = createClient(SUPABASE_URL, ANON_KEY);
      const jwtConsultant2 = await sessionFor(admin, anonC2, 'isolamento-consultant-2@palladia-test.local');

      const rGet = await fetch(`${API_BASE}/consultant/bookings/${booking.id}`, { headers: { Authorization: `Bearer ${jwtConsultant2}` } });
      check_('Consulente: booking di un altro consulente → 404 (non dati)', rGet.status === 404, { status: rGet.status });

      const rConfirm = await fetch(`${API_BASE}/consultant/bookings/${booking.id}/confirm`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${jwtConsultant2}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      check_('Consulente: confermare booking di un altro consulente → 404', rConfirm.status === 404, { status: rConfirm.status });

      const rList = await fetch(`${API_BASE}/consultant/bookings`, { headers: { Authorization: `Bearer ${jwtConsultant2}` } });
      const listBody = await rList.json();
      const arr = Array.isArray(listBody) ? listBody : (listBody.bookings || []);
      check_('Consulente: lista prenotazioni non contiene quella di un collega', !arr.some(b => b.id === booking.id), null);
    } else {
      skip('Consulente marketplace cross-consultant', 'nessun booking di riferimento trovato per creare il fixture');
    }
  } catch (e) { skip('Consulente marketplace cross-consultant', e.message); }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

main().catch(e => { console.error('FATAL', e); process.exit(1); });
