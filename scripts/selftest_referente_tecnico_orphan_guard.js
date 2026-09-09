#!/usr/bin/env node
/**
 * scripts/selftest_referente_tecnico_orphan_guard.js
 *
 * Regressione per F-157 (AUDIT.md): impostare il "referente tecnico" di un
 * cantiere su un membro il cui utente Supabase Auth non esiste più (riga
 * company_users "orfana" — capita quando un account viene cancellato senza
 * pulire la membership) veniva accettato con 200: PATCH /api/v1/sites/:id
 * scriveva referente_tecnico_id ma calcolava referente_tecnico_name = null
 * (fallback silenzioso su `authData?.user` undefined). Il frontend
 * (SiteSettingsPanel.tsx) decide se mostrare "referente assegnato" guardando
 * SOLO referente_tecnico_name — quindi l'utente vedeva sempre "Nessun
 * referente assegnato", indistinguibile da un salvataggio mai avvenuto,
 * anche cliccando più volte (find live nella company reale MSCedilizia:
 * 22/134 righe company_users nel DB sono orfane in questo modo — non un
 * caso di laboratorio).
 *
 * Riproduzione manuale: Impostazioni cantiere → Referente tecnico → scegli
 * un membro del team la cui email risulta "—" nella lista → il pannello
 * continua a mostrare "Nessun referente assegnato" a ogni tentativo.
 *
 * Verifica dal vivo: crea una riga company_users orfana reale (user_id
 * random, mai esistito in auth.users) sulla company MSCedilizia via service
 * role, PATCHa un cantiere reale passando quell'id tramite l'API live
 * (TEST_BASE_URL), controlla sia la risposta HTTP sia lo stato reale in DB
 * dopo la chiamata — non solo lo status code.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — Referente tecnico su membro orfano (F-157)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('referente tecnico — membro orfano', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('referente tecnico — membro orfano', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
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

  const { data: sites } = await admin.from('sites').select('id, name, referente_tecnico_id, referente_tecnico_name')
    .eq('company_id', companyId).neq('status', 'eliminato').limit(1);
  check('Un cantiere reale trovato nella company di test', !!sites?.length, sites);
  const site = sites?.[0];

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tempPassword });
  check('Login ci-test riuscito', !loginErr && !!session?.session, loginErr);
  const jwt = session?.session?.access_token;

  // Riga company_users orfana: un user_id che non è mai esistito in auth.users.
  const orphanId = crypto.randomUUID();
  const { error: insertErr } = await admin.from('company_users').insert({ company_id: companyId, user_id: orphanId, role: 'tech' });
  check('Riga company_users orfana creata per il test', !insertErr, insertErr);

  try {
    // 1) L'orfano non deve nemmeno comparire come opzione selezionabile.
    const teamRes = await fetch(`${BASE}/api/v1/team-members`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    });
    const team = await teamRes.json();
    check('GET /team-members esclude il membro orfano dalla lista selezionabile', Array.isArray(team) && !team.some(m => m.user_id === orphanId), team);

    // 2) Anche forzando l'id via API diretta (bypass del dropdown), il PATCH
    // non deve accettare silenziosamente un referente "fantasma".
    const patchRes = await fetch(`${BASE}/api/v1/sites/${site.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: JSON.stringify({ referente_tecnico_id: orphanId }),
    });
    const patchBody = await patchRes.json().catch(() => ({}));
    check('PATCH con referente orfano viene rifiutato (400), non accettato con nome null', patchRes.status === 400, { status: patchRes.status, body: patchBody });

    const { data: dbAfter, error: dbErr } = await admin.from('sites')
      .select('referente_tecnico_id, referente_tecnico_name').eq('id', site.id).single();
    check('Query diretta DB, non solo status HTTP', !dbErr, dbErr);
    check('Il cantiere NON è stato modificato in DB (nessun referente fantasma scritto)',
      dbAfter?.referente_tecnico_id === site.referente_tecnico_id && dbAfter?.referente_tecnico_name === site.referente_tecnico_name,
      dbAfter);
  } finally {
    await admin.from('company_users').delete().eq('company_id', companyId).eq('user_id', orphanId);
    await admin.from('sites').update({
      referente_tecnico_id: site?.referente_tecnico_id ?? null,
      referente_tecnico_name: site?.referente_tecnico_name ?? null,
    }).eq('id', site.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
