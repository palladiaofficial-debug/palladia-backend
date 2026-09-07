#!/usr/bin/env node
/**
 * scripts/selftest_marketplace_fake_providers_hidden.js
 *
 * Regressione per F-142 (AUDIT.md, repo frontend): il marketplace Formazione
 * (src/pages/FormazioneMarketplace.tsx), raggiungibile in un click dal
 * pulsante "Prenota →" sugli avvisi di scadenza reali (src/pages/Scadenze.tsx),
 * mostrava 21+ enti formatori interamente inventati (seed della migrazione
 * 045_formazione.sql — es. "Formedil Milano", email "info@formedilmilano.it"
 * inesistente) come se fossero partner reali, con un pulsante "Prenota"
 * pienamente funzionante: routes/v1/bookings.js crea una vera Stripe
 * Checkout Session con la chiave live di produzione (sk_live_..., verificato
 * su Railway). L'11 luglio 2026 questo ha già prodotto un checkout Stripe
 * live reale (cs_live_...) sull'azienda di produzione vera MSCedilizia,
 * rimasto per fortuna "cancelled/unpaid". Quando un corso non ha sessioni
 * (il caso comune oggi), la pagina di dettaglio indirizza l'utente a
 * "contattare direttamente l'ente formatore" — un ente che non esiste.
 *
 * Fix: i provider fittizi/seed/test sono stati disattivati (is_active=false)
 * in training_providers, così i loro corsi spariscono da ogni endpoint
 * marketplace pubblico o autenticato. Questo test verifica dal vivo (chiamata
 * HTTP reale con JWT reale, non solo lettura del codice) che nessun corso
 * legato a un provider terzo compaia più nel marketplace, mentre un corso
 * reale di un consulente (persona vera, non un ente inventato) resta visibile.
 *
 * Env: TEST_BASE_URL (default http://localhost:3001), SUPABASE_URL,
 * SUPABASE_KEY (anon/publishable), SUPABASE_SERVICE_ROLE_KEY. Se mancano o
 * l'utente/company di test non esistono, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — Marketplace Formazione: enti formatori fittizi nascosti (F-142)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('marketplace — enti fittizi nascosti', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('marketplace — enti fittizi nascosti', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map((m) => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const company = (companies || []).find((c) => c.name === 'MSCedilizia');
  check('Company di test MSCedilizia trovata', !!company, companies);
  const companyId = company?.id;

  // Verifica diretta in DB: nessun provider terzo (non-consulente) è ancora attivo.
  const { data: activeProviders, error: provErr } = await admin
    .from('training_providers')
    .select('id, name, email')
    .eq('is_active', true);
  check('Query diretta DB sui training_providers riuscita', !provErr, provErr);
  check(
    'Nessun ente formatore (provider) è ancora is_active=true — tutti erano dati seed/test inventati',
    (activeProviders || []).length === 0,
    activeProviders
  );

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tempPassword });
  check('Login ci-test riuscito', !loginErr && !!session?.session, loginErr);
  const jwt = session?.session?.access_token;

  // Chiamata reale, stesso JWT/company-id che userebbe l'app, alla lista
  // marketplace senza filtri — esattamente quello che carica
  // FormazioneMarketplace.tsx aprendo "Corsi disponibili".
  const res = await fetch(`${BASE}/api/v1/marketplace/courses?limit=100`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId ?? '' },
  });
  const body = await res.json().catch(() => ({}));
  check('GET /api/v1/marketplace/courses risponde 200', res.status === 200, { status: res.status, body });

  const courses = body.courses || [];
  const providerBacked = courses.filter(c => c.training_providers && !c.consultant_id);
  check(
    'Nessun corso di un ente formatore terzo compare più nella lista reale del marketplace',
    providerBacked.length === 0,
    providerBacked.map(c => ({ id: c.id, title: c.title, provider: c.training_providers?.name }))
  );

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
