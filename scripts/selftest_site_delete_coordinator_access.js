#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_site_delete_coordinator_access.js
 *
 * Test di regressione permanente per F-092 (AUDIT.md) — la cancellazione di
 * un cantiere (soft delete, sites.status='eliminato') non revocava l'accesso
 * di un token CSE/Pro esterno già emesso: un coordinatore poteva continuare a
 * leggere/scrivere sul cantiere "eliminato" indefinitamente. Trovato dal vivo
 * con una chiamata reale a produzione (BLOCCO cancellazione cantiere, 2026-08-27),
 * non da lettura di codice.
 *
 * Copre anche il resto del percorso di cancellazione cantiere dell'inventario
 * BLOCCO 3 (mai colpito con una chiamata reale prima d'ora):
 *  - ruolo 'viewer' bloccato lato server sulla DELETE reale (non solo letto nel codice)
 *  - utente di un'altra company bloccato (cross-tenant)
 *  - la cancellazione è sempre soft delete: presenze, documenti, spese, SAL e
 *    l'invito coordinatore restano intatti e collegati, nulla va in cascata/orfano
 *  - il cantiere sparisce dalla lista attiva e compare nel cestino
 *  - il ripristino riporta tutto visibile
 *
 * Richiede: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * scripts/_isolamento_seed.json (per il probe cross-tenant, opzionale).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function apiCall(jwt, companyId, method, urlPath, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let respBody = null;
  try { respBody = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: respBody };
}

async function main() {
  console.log('\nPalladia — F-092: cancellazione cantiere + accesso coordinatore (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('suite', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

  const { data: companyAUsers } = await admin.from('company_users').select('user_id, role').eq('company_id', companyA.id).limit(20);
  const ownerRow = companyAUsers.find(u => u.role === 'owner') || companyAUsers.find(u => u.role !== 'viewer') || companyAUsers[0];
  const { data: ownerAuth } = await admin.auth.admin.getUserById(ownerRow.user_id);
  const emailOwner = ownerAuth.user.email;

  let viewerRow = companyAUsers.find(u => u.role === 'viewer');
  if (!viewerRow) {
    const email = `test-viewer-sitedelete-${Date.now()}@palladia-test.local`;
    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr) { fail('creazione utente viewer sintetico', createErr.message); }
    else {
      await admin.from('company_users').insert({ company_id: companyA.id, user_id: newUser.user.id, role: 'viewer' });
      viewerRow = { user_id: newUser.user.id };
    }
  }
  const { data: viewerAuth } = await admin.auth.admin.getUserById(viewerRow.user_id);
  const emailViewer = viewerAuth.user.email;

  const anonOwner  = createClient(SUPABASE_URL, ANON_KEY);
  const anonViewer = createClient(SUPABASE_URL, ANON_KEY);
  const jwtOwner  = await sessionFor(admin, anonOwner, emailOwner);
  const jwtViewer = await sessionFor(admin, anonViewer, emailViewer);
  ok('Sessioni JWT ottenute (owner + viewer, via OTP)');

  // ── Cantiere sintetico con storico completo ─────────────────────────────
  const { data: site, error: siteErr } = await admin.from('sites').insert({
    company_id: companyA.id, name: `TEST-F092-CancellazioneCantiere-${Date.now()}`, address: 'Via Prova Cancellazione 1', status: 'attivo',
  }).select('id').single();
  if (siteErr) { fail('creazione cantiere sintetico', siteErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const { data: worker } = await admin.from('workers').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();
  if (worker) {
    await admin.from('presence_logs').insert({
      company_id: companyA.id, site_id: site.id, worker_id: worker.id,
      event_type: 'ENTRY', timestamp_server: new Date().toISOString(), method: 'personal_phone',
    });
  }
  await admin.from('site_documents').insert({
    company_id: companyA.id, site_id: site.id, name: 'Verbale-test.pdf', category: 'altro', file_path: `test/verbale-f092-${Date.now()}.pdf`,
  });
  await admin.from('company_expenses').insert({
    company_id: companyA.id, site_id: site.id, amount: 1234.56, description: 'Spesa test F-092', expense_date: new Date().toISOString().slice(0, 10),
  });
  await admin.from('site_sal_history').insert({
    company_id: companyA.id, site_id: site.id, sal_number: 1, sal_percentuale: 30, data_emissione: new Date().toISOString().slice(0, 10),
    totale_contratto: 100000, importo_maturato: 30000,
  });
  const rInvite = await apiCall(jwtOwner, companyA.id, 'POST', `/sites/${site.id}/coordinator-invites`, { coordinator_name: 'CSE Test F-092' });
  const rawCoordToken = (rInvite.body?.cse_url || '').split('/').pop();
  check_('Invito CSE creato con token reale', rInvite.status === 201 && !!rawCoordToken, rInvite.body);

  // ── Tentativi non autorizzati ────────────────────────────────────────────
  const rViewer = await apiCall(jwtViewer, companyA.id, 'DELETE', `/sites/${site.id}`);
  check_('DELETE come viewer → rifiuto server-side reale (403)', rViewer.status === 403, rViewer.body);

  const seedPath = path.join(__dirname, '_isolamento_seed.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const anonB = createClient(SUPABASE_URL, ANON_KEY);
    const jwtB = await sessionFor(admin, anonB, seed.userEmail);
    const rCross = await apiCall(jwtB, seed.companyId, 'DELETE', `/sites/${site.id}`);
    check_('DELETE come company B (ID di A) → rifiuto (404)', rCross.status === 404, rCross.body);
  } else {
    skip('DELETE cross-tenant', '_isolamento_seed.json mancante');
  }

  const { data: stillThere } = await admin.from('sites').select('status').eq('id', site.id).single();
  check_('Nessuno dei due tentativi ha modificato il cantiere', stillThere.status === 'attivo', stillThere);

  // ── Cancellazione reale, autorizzata ─────────────────────────────────────
  const rDelete = await apiCall(jwtOwner, companyA.id, 'DELETE', `/sites/${site.id}`);
  check_('DELETE come owner autorizzato → 200 soft_delete', rDelete.status === 200 && rDelete.body?.method === 'soft_delete', rDelete.body);

  const { data: presAfter }   = await admin.from('presence_logs').select('id').eq('site_id', site.id);
  const { data: sdocAfter }   = await admin.from('site_documents').select('id').eq('site_id', site.id);
  const { data: expAfter }    = await admin.from('company_expenses').select('id').eq('site_id', site.id);
  const { data: salAfter }    = await admin.from('site_sal_history').select('id').eq('site_id', site.id);
  const { data: inviteAfter } = await admin.from('site_coordinator_invites').select('id, is_active').eq('site_id', site.id);
  check_('Soft delete: presenze non cancellate/orfane', !worker || presAfter.length > 0, presAfter);
  check_('Soft delete: documenti non cancellati/orfani', sdocAfter.length > 0, sdocAfter);
  check_('Soft delete: spese non cancellate/orfane', expAfter.length > 0, expAfter);
  check_('Soft delete: SAL non cancellati/orfani', salAfter.length > 0, salAfter);
  check_('Soft delete: invito coordinatore non toccato (is_active resta true)', inviteAfter.length > 0 && inviteAfter[0].is_active === true, inviteAfter);

  const rList = await apiCall(jwtOwner, companyA.id, 'GET', '/sites');
  check_('Cantiere sparisce dalla lista attiva', !(rList.body || []).some(s => s.id === site.id), null);
  const rDeletedList = await apiCall(jwtOwner, companyA.id, 'GET', '/sites/deleted');
  check_('Cantiere compare nel cestino', (rDeletedList.body || []).some(s => s.id === site.id), null);

  // ── F-092: il token CSE non deve funzionare su un cantiere eliminato ────
  if (rawCoordToken) {
    const portalRes = await fetch(`${API_BASE}/coordinator/portal/${rawCoordToken}/site/${site.id}`);
    check_('F-092: link CSE pubblico NON funziona più su cantiere eliminato', portalRes.status === 404, portalRes.status);
  } else {
    skip('probe portale CSE su cantiere eliminato', 'token CSE non ottenuto');
  }

  // ── Ripristino ────────────────────────────────────────────────────────────
  const rRestore = await apiCall(jwtOwner, companyA.id, 'POST', `/sites/${site.id}/restore`);
  check_('Ripristino → 200', rRestore.status === 200, rRestore.body);
  const { data: siteAfterRestore } = await admin.from('sites').select('status').eq('id', site.id).single();
  check_('Dopo ripristino: cantiere torna visibile (status != eliminato)', siteAfterRestore.status !== 'eliminato', siteAfterRestore);

  if (rawCoordToken) {
    const portalResAfterRestore = await fetch(`${API_BASE}/coordinator/portal/${rawCoordToken}/site/${site.id}`);
    check_('Dopo ripristino: link CSE torna a funzionare', portalResAfterRestore.status === 200, portalResAfterRestore.status);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
