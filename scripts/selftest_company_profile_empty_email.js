#!/usr/bin/env node
/**
 * scripts/selftest_company_profile_empty_email.js
 *
 * Regressione per F-042 (AUDIT.md, repo frontend): il form "Profilo Azienda"
 * (src/pages/Account.tsx) invia sempre tutti e 6 i campi in un unico PATCH
 * /api/v1/company, incluso contact_email. Se "Email di contatto" non è mai
 * stata compilata, il payload contiene contact_email: "" — lo schema Zod
 * (lib/schemas/company.js) accettava solo un'email valida, null o l'assenza
 * del campo, mai una stringa vuota, quindi la validazione falliva con 400 e
 * bloccava il salvataggio dell'INTERO form, incluso il telefono che l'utente
 * stava effettivamente cambiando.
 *
 * Verifica dal vivo con una chiamata HTTP reale, JWT reale, e una query DB
 * diretta dopo il PATCH — non solo lo status HTTP della risposta.
 *
 * Sessione ottenuta con lo stesso pattern già in uso in questo repo (vedi
 * memoria ci_test_fixtures_2026_07_18): utente ci-test@palladia.internal,
 * password rigenerata via service role ad ogni run, company MSCedilizia
 * (quella giusta, non "la prima" restituita da Supabase — l'utente ha più
 * membership). Nessuna credenziale esterna richiesta oltre a quelle già
 * in .env.
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
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — Profilo Azienda: salvataggio con Email di contatto vuota (F-042)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('profilo azienda — email vuota', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('profilo azienda — email vuota', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
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

  const { data: before, error: beforeErr } = await admin
    .from('companies')
    .select('name, piva, address, phone, contact_email, safety_manager')
    .eq('id', companyId)
    .single();
  check('Riga company MSCedilizia letta prima del test', !beforeErr && !!before, beforeErr);

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tempPassword });
  check('Login ci-test riuscito', !loginErr && !!session?.session, loginErr);
  const jwt = session?.session?.access_token;

  const newPhone = `010${Math.floor(1000000 + Math.random() * 8999999)}`;

  try {
    // Stesso payload che src/pages/Account.tsx invia sempre: tutti e 6 i
    // campi insieme, contact_email vuota se il campo non è mai stato
    // compilato — questo è esattamente il caso dello screenshot originale.
    const res = await fetch(`${BASE}/api/v1/company`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: before?.name || '',
        piva: before?.piva || '',
        address: before?.address || '',
        phone: newPhone,
        contact_email: '',
        safety_manager: before?.safety_manager || '',
      }),
    });
    const body = await res.json().catch(() => ({}));
    check('PATCH con contact_email vuota va a buon fine (200), non 400 VALIDATION_ERROR', res.status === 200, { status: res.status, body });

    const { data: after, error: afterErr } = await admin
      .from('companies')
      .select('phone, contact_email')
      .eq('id', companyId)
      .single();
    check('Query diretta DB, non solo status HTTP', !afterErr && !!after, afterErr);
    check('Il telefono è stato scritto davvero in DB', after?.phone === newPhone, after);
    check('contact_email è stata normalizzata a null, non salvata come stringa vuota', after?.contact_email === null, after);
  } finally {
    // Ripristina la riga com'era prima del test, qualunque cosa sia successo.
    await admin.from('companies').update({
      name: before?.name, piva: before?.piva, address: before?.address,
      phone: before?.phone, contact_email: before?.contact_email, safety_manager: before?.safety_manager,
    }).eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
