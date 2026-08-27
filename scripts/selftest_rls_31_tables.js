#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_rls_31_tables.js
 *
 * Test di regressione permanente per F-090 (AUDIT.md) — le 31 tabelle con
 * RLS attiva ma zero policy trovate dal vivo il 2026-08-27 (rls_audit(),
 * migrazione 177). Fallisce PRIMA della migrazione 179 (deny-all silenzioso
 * su tutte e 31), verde dopo — verifica dal vivo, non lettura di codice
 * ([[feedback_verify_rls_live_not_grep]]).
 *
 * Due livelli:
 *  1. rls_audit(): ognuna delle 31 ha almeno 1 policy reale (non più un
 *     "buco" indistinguibile da una dimenticanza).
 *  2. Probe dal vivo con anon-key + JWT reale (via magic-link, mai
 *     password reset) per un caso rappresentativo di ogni gruppo:
 *     company-scoped, deny-all esplicito, catalogo pubblico.
 *
 * Richiede: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

const THIRTY_ONE = [
  '_migrations', 'ai_spend_alerts', 'app_migrations', 'attendance', 'booking_certificates',
  'consultant_clients', 'consultant_payouts', 'consultant_profiles', 'coordinator_pro_sessions',
  'coordinator_profiles', 'coordinator_verifications', 'course_bookings', 'course_quote_requests',
  'course_reviews', 'course_sessions', 'course_types', 'document_extra_homes', 'document_sync_failures',
  'expiry_notifications', 'marketplace_courses', 'provider_reviews', 'site_equipment',
  'site_note_reminders', 'site_subcontractors', 'site_suspension_days', 'site_weather_alert_sent',
  'studio_durc_alert_log', 'telegram_coordinator_link_codes', 'telegram_coordinator_links',
  'training_provider_sessions', 'training_providers',
];

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function main() {
  console.log('\nPalladia — F-090: 31 tabelle RLS senza policy (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── 1. Ognuna delle 31 ha almeno una policy reale ──────────────────────
  const { data: audit, error: auditErr } = await admin.rpc('rls_audit');
  if (auditErr) {
    fail('rls_audit() RPC disponibile', auditErr.message);
  } else {
    ok('rls_audit() RPC disponibile');
    const byName = Object.fromEntries(audit.map(t => [t.table_name, t]));
    for (const t of THIRTY_ONE) {
      const row = byName[t];
      check_(`${t} — RLS attiva`, !!row?.rls_enabled, row);
      check_(`${t} — almeno 1 policy reale (non più deny-all silenzioso)`, (row?.policy_count ?? 0) > 0, row);
    }
    // Nessuna nuova tabella RLS-enabled-zero-policy sfuggita all'elenco
    const stillGap = audit.filter(t => t.rls_enabled && t.policy_count === 0);
    check_('Nessuna tabella RLS-enabled/zero-policy oltre le 31 note', stillGap.length === 0, stillGap.map(t => t.table_name));
  }

  // ── 2. Probe dal vivo: company-scoped (site_equipment) ─────────────────
  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) {
    skip('probe dal vivo', 'TEST-AutoExplore non trovata');
  } else {
    const { data: companyAUsers } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1);
    const { data: userAAuth } = await admin.auth.admin.getUserById(companyAUsers[0].user_id);
    const emailA = userAAuth.user.email;
    const anonA = createClient(SUPABASE_URL, ANON_KEY);

    let jwtA;
    try {
      jwtA = await sessionFor(admin, anonA, emailA);
      ok('Sessione JWT ottenuta per company A (via OTP, non password reset)');
    } catch (e) {
      fail('Ottenere sessione JWT company A', e.message);
    }

    if (jwtA) {
      // 2a. site_equipment — company-scoped: A deve vedere la propria riga
      const { data: siteA } = await admin.from('sites').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();
      const { data: eqA } = await admin.from('equipment').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();
      if (siteA && eqA) {
        await admin.from('site_equipment')
          .upsert({ company_id: companyA.id, site_id: siteA.id, equipment_id: eqA.id }, { onConflict: 'site_id,equipment_id' })
          .then(null, () => {});
        const { data: seRows, error: seErr } = await anonA.from('site_equipment').select('id').eq('company_id', companyA.id);
        check_('site_equipment — company A legge la propria riga via anon-key+JWT', !seErr && seRows && seRows.length > 0, seErr || seRows);

        // 2a-bis. Cross-tenant: company B (seed isolamento) NON deve vedere la riga di A.
        const seedPath = path.join(__dirname, '_isolamento_seed.json');
        if (fs.existsSync(seedPath)) {
          const B = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
          const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: B.userEmail });
          if (!linkErr) {
            const anonB = createClient(SUPABASE_URL, ANON_KEY);
            const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
            const { error: verErr } = await anonB.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
            if (!verErr) {
              const { data: bReadsA, error: bErr } = await anonB.from('site_equipment').select('id').eq('company_id', companyA.id);
              check_('site_equipment — company B NON legge la riga di A via anon-key+JWT', !bErr && (!bReadsA || bReadsA.length === 0), bErr || bReadsA);
            } else {
              skip('site_equipment cross-tenant probe', verErr.message);
            }
          } else {
            skip('site_equipment cross-tenant probe', linkErr.message);
          }
        } else {
          skip('site_equipment cross-tenant probe', '_isolamento_seed.json mancante');
        }
      } else {
        skip('site_equipment probe', 'manca site o equipment reale per TEST-AutoExplore');
      }

      // 2b. deny-all esplicito — document_extra_homes: A NON deve vedere nulla
      // anche se esiste una riga reale creata via service-role.
      const { data: docA } = await admin.from('documents').select('id').eq('company_id', companyA.id).limit(1).maybeSingle();
      if (docA) {
        const { data: dehRow } = await admin.from('document_extra_homes')
          .upsert({ document_id: docA.id, folder_type: 'category', folder_key: 'rls-selftest' }, { onConflict: 'document_id,folder_type,folder_key' })
          .select('id').maybeSingle();
        const { data: dehRead, error: dehErr } = await anonA.from('document_extra_homes').select('id').eq('document_id', docA.id);
        check_('document_extra_homes — deny-all reale: company A NON legge nulla via anon-key+JWT', !dehErr && (!dehRead || dehRead.length === 0), dehErr || dehRead);
        void dehRow;
      } else {
        skip('document_extra_homes probe', 'nessun documento reale per TEST-AutoExplore');
      }

      // 2c. catalogo pubblico — course_types: A deve vedere righe (non più deny-all)
      const { data: ctRows, error: ctErr } = await anonA.from('course_types').select('id').limit(5);
      check_('course_types — catalogo leggibile da qualunque utente autenticato', !ctErr && ctRows && ctRows.length > 0, ctErr || ctRows);

      // 2d. catalogo pubblico filtrato — marketplace_courses: A deve vedere solo attivi/non-draft
      const { data: mcRows, error: mcErr } = await anonA.from('marketplace_courses').select('id, is_active, is_draft').limit(20);
      const allPublishable = !mcErr && Array.isArray(mcRows) && mcRows.every(r => r.is_active && !r.is_draft);
      check_('marketplace_courses — autenticato vede solo corsi attivi e pubblicati', allPublishable, mcErr || mcRows);
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
