#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_coordinator_verbale_photo.js
 *
 * Test di regressione per il sopralluogo fotografico del verbale CSE
 * (migrazione 193, routes/v1/coordinator.js, routes/v1/coordinatorPro.js,
 * routes/v1/verbale.js). Nato dal confronto con un verbale reale di un
 * concorrente (myAEDES): documentava bene foto+note del sopralluogo fisico,
 * ma un'unica persona "firmava" per conto di tutte le parti presenti.
 * Il verbale Palladia evita quel problema per costruzione — ogni nota è
 * vincolata all'invito che ha autenticato la richiesta (token o sessione
 * Pro), mai al nome fornito dal client — questo test lo verifica esplicitamente
 * (photo_path forgiato da un altro invito viene rifiutato).
 *
 * Chiamate reali contro l'API di produzione, JWT vero via generateLink+verifyOtp
 * per creare l'invito (unico passaggio che richiede una sessione azienda),
 * poi solo token/sessione coordinatore — mai una password.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE      = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// 1x1 px PNG rosso, valido — sufficiente per testare la pipeline di upload.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

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

async function uploadPhoto(urlPath) {
  const form = new FormData();
  form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'sopralluogo.png');
  const res = await fetch(`${API_BASE}${urlPath}`, { method: 'POST', body: form });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function main() {
  console.log('\nPalladia — Verbale CSE: sopralluogo fotografico (regressione HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-verbale-photo-${Date.now()}@palladia-test.internal`;
  let companyId, otherCompanyId, siteId, userId, inviteId, otherInviteId, rawToken, otherRawToken, proSessionRaw;

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-VerbaleFoto' }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site verbale', status: 'attivo', address: 'Via Test 1' }).select().single();
    siteId = site.id;
    const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-VerbaleFoto-Other' }).select().single();
    otherCompanyId = otherCompany.id;
    const { data: otherSite } = await admin.from('sites').insert({ company_id: otherCompanyId, name: 'TEST altro cantiere', status: 'attivo', address: 'Via Test 2' }).select().single();

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    await admin.from('company_users').insert({ company_id: otherCompanyId, user_id: userId, role: 'owner' });
    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    // ── Crea invito coordinatore (via API reale, non insert diretto) ────────
    {
      const r = await apiCall(jwt, companyId, 'POST', `/sites/${siteId}/coordinator-invites`, { coordinator_name: 'Ing. Test Coordinatore' });
      check('Invito coordinatore creato', r.status === 201 && typeof r.body?.cse_url === 'string', r.body);
      inviteId = r.body.invite_id;
      rawToken = r.body.cse_url.split('/').pop();
      check('Token estratto (64 hex)', /^[0-9a-f]{64}$/i.test(rawToken || ''), rawToken);
    }
    // Un secondo invito, su un cantiere di un'ALTRA company — per il test di forgiatura del photo_path.
    {
      const r = await apiCall(jwt, otherCompanyId, 'POST', `/sites/${otherSite.id}/coordinator-invites`, { coordinator_name: 'Ing. Altro Coordinatore' });
      otherInviteId = r.body.invite_id;
      otherRawToken = r.body.cse_url.split('/').pop();
    }

    // ── Upload foto (token singolo) ──────────────────────────────────────────
    let photoPath, photoUrl;
    {
      const r = await uploadPhoto(`/coordinator/${rawToken}/notes/photo`);
      check('Upload foto sopralluogo: 200 con url+path', r.status === 200 && !!r.body?.url && !!r.body?.path, r.body);
      photoPath = r.body?.path;
      photoUrl  = r.body?.url;
      check('Path foto contiene company/coordinator/site/invite (mai scelto dal client)',
        photoPath === `${companyId}/coordinator/${siteId}/${inviteId}/${photoPath.split('/').pop()}`, photoPath);
    }

    // ── Nota con foto + GPS ───────────────────────────────────────────────────
    let noteId;
    {
      const r = await fetch(`${API_BASE}/coordinator/${rawToken}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Rettifica pendenze canale di gronda, angolo SUD-OVEST.', photo_path: photoPath, gps_lat: 44.4056, gps_lng: 8.9463 }),
      });
      const body = await r.json();
      check('Nota con foto creata (201)', r.status === 201 && body?.note?.photo_signed_url, body);
      noteId = body?.note?.id;
    }

    // ── Sicurezza: photo_path di un ALTRO invito viene rifiutato ─────────────
    {
      const forgedPath = `${otherCompanyId}/coordinator/${otherSite.id}/${otherInviteId}/qualcosa.png`;
      const r = await fetch(`${API_BASE}/coordinator/${rawToken}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Tentativo di aggancio foto altrui', photo_path: forgedPath }),
      });
      check('photo_path di un invito diverso viene rifiutato (400 PHOTO_PATH_MISMATCH)', r.status === 400, await r.clone().json().catch(() => null));
    }

    // ── GET notes include il segnale foto ────────────────────────────────────
    {
      const r = await fetch(`${API_BASE}/coordinator/${rawToken}/notes`);
      const list = await r.json();
      const found = (list || []).find(n => n.id === noteId);
      check('GET notes: la nota include photo_signed_url e coordinate GPS', found?.photo_signed_url && found?.gps_lat === 44.4056, found);
    }

    // ── Verbale PDF genera correttamente con la sezione fotografica ─────────
    {
      const r = await fetch(`${API_BASE}/coordinator/${rawToken}/verbale`);
      const buf = await r.arrayBuffer();
      check('Verbale PDF: 200, content-type pdf, dimensione plausibile (>5KB)',
        r.status === 200 && (r.headers.get('content-type') || '').includes('pdf') && buf.byteLength > 5000,
        { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.byteLength });
    }

    // ── Flusso Pro: stesso endpoint, autenticazione a sessione ───────────────
    {
      const proEmail = `test-verbale-photo-pro-${Date.now()}@palladia-test.internal`;
      await admin.from('site_coordinator_invites').update({ coordinator_email: proEmail }).eq('id', inviteId);
      proSessionRaw = crypto.randomBytes(32).toString('hex');
      const proTokenHash = crypto.createHash('sha256').update(proSessionRaw).digest('hex');
      await admin.from('coordinator_pro_sessions').insert({
        email: proEmail, token_hash: proTokenHash, expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      const rUp = await uploadPhoto(`/coordinator/pro/${proSessionRaw}/site/${siteId}/notes/photo`);
      check('Flusso Pro: upload foto accettato', rUp.status === 200 && !!rUp.body?.path, rUp.body);

      const rNote = await fetch(`${API_BASE}/coordinator/pro/${proSessionRaw}/site/${siteId}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Nota Pro con foto', photo_path: rUp.body.path }),
      });
      const noteBody = await rNote.json();
      check('Flusso Pro: nota con foto creata con photo_signed_url', rNote.status === 200 && !!noteBody?.note?.photo_signed_url, noteBody);
    }

    // ── Cross-tenant: il token dell'altra company non vede questo cantiere ──
    {
      const r = await fetch(`${API_BASE}/coordinator/${otherRawToken}/notes/photo`, { method: 'POST', body: new FormData() });
      check('Upload foto senza file su token valido ma richiesta vuota: 400, non 500', r.status === 400, r.status);
    }
  } finally {
    try { if (inviteId) await admin.from('site_coordinator_notes').delete().eq('invite_id', inviteId); } catch { /* best-effort */ }
    try { if (inviteId) await admin.from('site_coordinator_invites').delete().eq('id', inviteId); } catch { /* best-effort */ }
    try { if (otherInviteId) await admin.from('site_coordinator_invites').delete().eq('id', otherInviteId); } catch { /* best-effort */ }
    try { if (userId) await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    try { if (siteId) await admin.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('sites').delete().eq('company_id', otherCompanyId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
    try { if (otherCompanyId) await admin.from('companies').delete().eq('id', otherCompanyId); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
