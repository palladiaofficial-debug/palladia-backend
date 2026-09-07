#!/usr/bin/env node
/**
 * scripts/selftest_presence_close_reopen_role_gate.js
 *
 * Regressione per F-147 (AUDIT.md): POST /api/v1/reports/presence/close e
 * DELETE /api/v1/reports/presence/close/:closureId (chiusura/riapertura di
 * una giornata presenze per il payroll) non avevano alcun controllo di
 * ruolo — a differenza di POST /presence/admin-correction
 * (routes/v1/presenceCorrections.js), che richiede owner/admin. Un utente
 * con ruolo 'tech' poteva chiudere E riaprire una giornata "bloccata", e la
 * riapertura (un DELETE che cancella la riga di lock) non scriveva nulla in
 * admin_audit_log — nessuna traccia di chi/quando/perché.
 *
 * Verifica dal vivo: sessione reale (magiclink+verifyOtp, mai password) per
 * un utente 'tech' sintetico → deve ricevere 403 su entrambi gli endpoint,
 * e la riga di chiusura deve restare intatta in DB dopo il tentativo. Poi,
 * con un utente 'owner' autorizzato, la riapertura riesce davvero e scrive
 * una riga in admin_audit_log.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (o SUPABASE_KEY), SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
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

async function main() {
  console.log('\nPalladia regression — chiusura/riapertura giornata presenze richiede owner/admin (F-147)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('presence close/reopen role gate', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonTech  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonOwner = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F147-CloseReopenRoleGate' }]).select('id').single();
  const companyId = company.id;
  const { data: site } = await admin.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere-F147', address: 'Via Test', status: 'attivo',
  }]).select('id').single();

  const techEmail   = `test-f147-tech-${Date.now()}@palladia-test.local`;
  const ownerEmail  = `test-f147-owner-${Date.now()}@palladia-test.local`;
  const { data: techUser }  = await admin.auth.admin.createUser({ email: techEmail,  email_confirm: true });
  const { data: ownerUser } = await admin.auth.admin.createUser({ email: ownerEmail, email_confirm: true });
  await admin.from('company_users').insert([
    { company_id: companyId, user_id: techUser.user.id,  role: 'tech'  },
    { company_id: companyId, user_id: ownerUser.user.id, role: 'owner' },
  ]);

  const techJwt  = await sessionFor(admin, anonTech, techEmail);
  const ownerJwt = await sessionFor(admin, anonOwner, ownerEmail);

  // Chiusura seminata direttamente in DB (bypassa il flusso di verifica
  // anomalie di POST /close, non l'oggetto di questo test).
  const { data: closure } = await admin.from('presence_day_closures').insert({
    company_id: companyId, site_id: site.id, closure_date: '2026-06-20',
    closed_by: ownerUser.user.id, worker_count: 1, total_hours: 8,
  }).select().single();

  try {
    // ── Tech: chiudere una giornata deve essere negato (403) ──
    const closeRes = await fetch(`${BASE}/api/v1/reports/presence/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${techJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: site.id, closure_date: '2026-06-21' }),
    });
    check('ruolo tech: POST /presence/close negato con 403', closeRes.status === 403, { status: closeRes.status, body: await closeRes.json().catch(() => null) });

    // ── Tech: riaprire una giornata deve essere negato (403), riga intatta ──
    const reopenTechRes = await fetch(`${BASE}/api/v1/reports/presence/close/${closure.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${techJwt}`, 'X-Company-Id': companyId },
    });
    check('ruolo tech: DELETE /presence/close/:id negato con 403', reopenTechRes.status === 403, { status: reopenTechRes.status });

    const { data: stillClosed } = await admin.from('presence_day_closures').select('id').eq('id', closure.id).maybeSingle();
    check('la riga di chiusura resta intatta dopo il tentativo negato', !!stillClosed, stillClosed);

    // ── Owner: riaprire riesce davvero e lascia traccia in admin_audit_log ──
    const reopenOwnerRes = await fetch(`${BASE}/api/v1/reports/presence/close/${closure.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId },
    });
    check('ruolo owner: DELETE /presence/close/:id riesce (200)', reopenOwnerRes.status === 200, { status: reopenOwnerRes.status });

    const { data: nowDeleted } = await admin.from('presence_day_closures').select('id').eq('id', closure.id).maybeSingle();
    check('la riga di chiusura è stata davvero rimossa', !nowDeleted);

    await new Promise(r => setTimeout(r, 800)); // l'insert di audit log è fire-and-forget
    const { data: auditRows } = await admin.from('admin_audit_log')
      .select('action, user_role, payload')
      .eq('company_id', companyId).eq('action', 'presence.day_reopened').eq('target_id', closure.id);
    check('la riapertura lascia una traccia in admin_audit_log (chi/quando/cosa)', (auditRows || []).length === 1, auditRows);
    check('la traccia riporta il ruolo owner e la data della giornata riaperta', auditRows?.[0]?.user_role === 'owner' && auditRows?.[0]?.payload?.closure_date === '2026-06-20', auditRows?.[0]);
  } finally {
    await admin.from('admin_audit_log').delete().eq('company_id', companyId);
    await admin.from('presence_day_closures').delete().eq('company_id', companyId);
    await admin.from('company_users').delete().eq('company_id', companyId);
    await admin.auth.admin.deleteUser(techUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(ownerUser.user.id).catch(() => {});
    await admin.from('sites').delete().eq('id', site.id);
    await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
