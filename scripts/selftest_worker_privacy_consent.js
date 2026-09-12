#!/usr/bin/env node
/**
 * scripts/selftest_worker_privacy_consent.js
 *
 * Test di regressione per F-178 (AUDIT.md, 2026-09-12): l'unico "consenso
 * privacy" esistente prima di questo fix era un flag `localStorage`
 * cosmetico (public/scan.html) — mai verificato server-side, mai controllato
 * prima di registrare una timbratura. Verificato dal vivo PRIMA del fix
 * (scripts/_check_f178_red_state.js): un worker fixture senza alcun consenso
 * timbrava comunque con successo.
 *
 * Verifica dal vivo (chiamate HTTP reali contro produzione, stesso pattern
 * già in uso in questo repo per i test badge — TEST_BASE_URL default Railway):
 *  1. punch-context riporta requires_privacy_consent:true per un worker nuovo
 *  2. /badge/:code/punch è rifiutato con PRIVACY_CONSENT_REQUIRED
 *  3. /badge/:code/consent registra il consenso (verificato anche su admin_audit_log)
 *  4. dopo il consenso, punch-context torna false e /punch riesce
 *  5. /badge/capocantiere-punch su un SECONDO worker senza consenso è rifiutato
 *     con WORKER_PRIVACY_CONSENT_PENDING, e riesce solo dopo che quel worker
 *     ha accettato personalmente (via /scan/identify + /scan/consent, il
 *     percorso "proprio dispositivo" diverso dal badge personale)
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const COMPANY_ID = 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }

function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }
function newFiscalCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'F178';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.slice(0, 16);
}

async function jsonFetch(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log('\n\x1b[1mConsenso privacy/GPS obbligatorio — F-178\x1b[0m');

  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-F178-SITE', status: 'attivo', address: 'Via Test 1',
  }).select('id, name').single();
  if (siteErr) { fail('setup cantiere fixture', siteErr.message); return report(); }

  const badgeA = newBadgeCode();
  const { data: workerA, error: wAErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-F178-WORKER-A', is_active: true, badge_code: badgeA,
  }).select('id').single();
  if (wAErr) { fail('setup worker A fixture', wAErr.message); return report(); }

  const badgeB = newBadgeCode();
  const fcB = newFiscalCode();
  const { data: workerB, error: wBErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-F178-WORKER-B', is_active: true, badge_code: badgeB, fiscal_code: fcB,
  }).select('id').single();
  if (wBErr) { fail('setup worker B fixture', wBErr.message); return report(); }

  try {
    // 1. punch-context richiede consenso
    const ctx1 = await jsonFetch('GET', `/api/v1/badge/${badgeA}/punch-context`);
    if (ctx1.status === 200 && ctx1.data.requires_privacy_consent === true) {
      ok('punch-context: requires_privacy_consent=true per un worker nuovo');
    } else {
      fail('punch-context: requires_privacy_consent=true per un worker nuovo', ctx1);
    }

    // 2. punch rifiutato
    const punch1 = await jsonFetch('POST', `/api/v1/badge/${badgeA}/punch`, {
      site_id: site.id, latitude: 41.9, longitude: 12.5, gps_accuracy_m: 20,
    });
    if (punch1.status === 403 && punch1.data.error === 'PRIVACY_CONSENT_REQUIRED') {
      ok('/badge/:code/punch rifiutato con PRIVACY_CONSENT_REQUIRED prima del consenso');
    } else {
      fail('/badge/:code/punch rifiutato con PRIVACY_CONSENT_REQUIRED prima del consenso', punch1);
    }

    // 3. accetta consenso
    const consent1 = await jsonFetch('POST', `/api/v1/badge/${badgeA}/consent`);
    if (consent1.status === 200 && consent1.data.ok === true) {
      ok('/badge/:code/consent registra il consenso');
    } else {
      fail('/badge/:code/consent registra il consenso', consent1);
    }

    await new Promise(r => setTimeout(r, 500));
    const { data: auditRows } = await supabase.from('admin_audit_log')
      .select('id, action, target_id, payload')
      .eq('company_id', COMPANY_ID).eq('target_id', workerA.id).eq('action', 'worker.privacy_consent_accepted');
    if (auditRows && auditRows.length > 0) {
      ok('registro durevole: riga scritta in admin_audit_log (worker.privacy_consent_accepted)');
    } else {
      fail('registro durevole: riga scritta in admin_audit_log (worker.privacy_consent_accepted)', auditRows);
    }

    // 4. dopo il consenso, punch-context torna false e il punch riesce
    const ctx2 = await jsonFetch('GET', `/api/v1/badge/${badgeA}/punch-context`);
    if (ctx2.status === 200 && ctx2.data.requires_privacy_consent === false) {
      ok('punch-context: requires_privacy_consent=false dopo il consenso');
    } else {
      fail('punch-context: requires_privacy_consent=false dopo il consenso', ctx2);
    }

    const punch2 = await jsonFetch('POST', `/api/v1/badge/${badgeA}/punch`, {
      site_id: site.id, latitude: 41.9, longitude: 12.5, gps_accuracy_m: 20,
    });
    if (punch2.status === 200) {
      ok('/badge/:code/punch riesce dopo il consenso');
    } else {
      fail('/badge/:code/punch riesce dopo il consenso', punch2);
    }

    // 5a. capocantiere-punch bloccato su worker B (nessun consenso personale)
    const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({ type: 'magiclink', email: 'e2e-suite@palladia.internal' });
    if (linkErr) throw linkErr;
    const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (verErr) throw verErr;
    const jwt = verified.session.access_token;

    async function capocantierePunch() {
      const res = await fetch(`${BASE}/api/v1/badge/capocantiere-punch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
        body: JSON.stringify({ badge_code: badgeB, site_id: site.id }),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    }

    const cap1 = await capocantierePunch();
    if (cap1.status === 403 && cap1.data.error === 'WORKER_PRIVACY_CONSENT_PENDING') {
      ok('capocantiere-punch bloccato su un worker senza consenso personale (WORKER_PRIVACY_CONSENT_PENDING)');
    } else {
      fail('capocantiere-punch bloccato su un worker senza consenso personale (WORKER_PRIVACY_CONSENT_PENDING)', cap1);
    }

    // 5b. worker B accetta personalmente da un "proprio dispositivo" diverso
    // dal badge — via QR-cantiere (/scan/identify + /scan/consent) — poi
    // capocantiere-punch deve riuscire.
    let scanPathVerified = false;
    try {
      const { signQrToken } = require('../routes/v1/qr');
      const exp = Math.floor(Date.now() / 1000) + 300;
      const t = signQrToken(site.id, exp);

      const idf = await jsonFetch('POST', '/api/v1/scan/identify', {
        worksite_id: site.id, fiscal_code: fcB, t, exp,
      });
      if (idf.status === 200 && idf.data.requires_privacy_consent === true && idf.data.session_token) {
        ok('/scan/identify: requires_privacy_consent=true per worker B (percorso QR-cantiere)');
        const sc = await jsonFetch('POST', '/api/v1/scan/consent', { session_token: idf.data.session_token });
        if (sc.status === 200 && sc.data.ok === true) {
          ok('/scan/consent registra il consenso personale di worker B');
          scanPathVerified = true;
        } else {
          fail('/scan/consent registra il consenso personale di worker B', sc);
        }
      } else {
        fail('/scan/identify: requires_privacy_consent=true per worker B (percorso QR-cantiere) — QR_SIGNING_SECRET locale potrebbe non combaciare con produzione', idf);
      }
    } catch (e) {
      fail('percorso /scan/* per worker B (setup QR signing)', e.message);
    }

    if (scanPathVerified) {
      const cap2 = await capocantierePunch();
      if (cap2.status === 200) {
        ok('capocantiere-punch riesce dopo che worker B ha accettato personalmente (percorso QR-cantiere)');
      } else {
        fail('capocantiere-punch riesce dopo che worker B ha accettato personalmente (percorso QR-cantiere)', cap2);
      }
    } else {
      console.log('  \x1b[33mSKIP\x1b[0m capocantiere-punch dopo consenso — percorso /scan/* non verificato sopra');
    }
  } finally {
    await supabase.from('presence_logs').delete().in('worker_id', [workerA.id, workerB.id]);
    await supabase.from('worksite_workers').delete().in('worker_id', [workerA.id, workerB.id]);
    await supabase.from('worker_device_sessions').delete().eq('worker_id', workerB.id);
    await supabase.from('admin_audit_log').delete().eq('target_id', workerA.id).eq('action', 'worker.privacy_consent_accepted');
    await supabase.from('workers').delete().in('id', [workerA.id, workerB.id]);
    await supabase.from('sites').delete().eq('id', site.id);
    console.log('\nFixture ripulite.');
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error('ERRORE selftest_worker_privacy_consent:', e); process.exit(1); });
