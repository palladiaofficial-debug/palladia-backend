#!/usr/bin/env node
/**
 * scripts/selftest_onboarding_trappola.js — F-348 (AUDIT.md del frontend).
 *
 * Due colleghi del titolare sono finiti in aziende vuote create da loro senza
 * volerlo: Francesco è entrato con "Accedi con Google" usando il gmail
 * ("MSCedilizia", vuota) invece di chiantia@mscedilizia.it; un altro ha creato
 * "MSC edilizia srl". Qui POST /onboarding/setup:
 *   - con un invito aperto per la sua email → 409 INVITO_APERTO, nessuna azienda;
 *   - con il nome di un'azienda che esiste già (anche scritto diverso: "MSC
 *     edilizia srl" = "MSCedilizia S.r.l.") → 409 AZIENDA_ESISTENTE;
 *   - confermando "è un'altra impresa" → creata;
 *   - nome nuovo → creata come prima.
 *   GET /onboarding/controllo → gli inviti aperti per la sua email.
 */
'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F348-${Date.now()}`;

async function sessione(email, password) {
  const cfg = await (await fetch('https://palladia-backend-production.up.railway.app/api/config')).json();
  const anon = createClient(process.env.SUPABASE_URL, cfg.supabase_anon_key, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session.access_token;
}

async function main() {
  console.log('\n\x1b[1mF-348 — niente seconda azienda per chi è stato invitato\x1b[0m');
  const { normalizzaNome } = (() => { try { return require('../lib/onboardingGuard'); } catch { return {}; } })();
  check('nome: "MSC edilizia srl" = "MSCedilizia S.r.l." = "MSCedilizia"', !!normalizzaNome && normalizzaNome('MSC edilizia srl') === normalizzaNome('MSCedilizia S.r.l.') && normalizzaNome('MSCedilizia') === normalizzaNome('MSCedilizia S.r.l.'));
  check('nome: "Edilizia Rossi S.p.A." ≠ "Edilizia Rossetti"', !!normalizzaNome && normalizzaNome('Edilizia Rossi S.p.A.') !== normalizzaNome('Edilizia Rossetti'));

  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/onboarding'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const utenti = [], aziende = [];
  const nuovoUtente = async (n) => {
    const email = `${T.toLowerCase()}-${n}@palladia-test.it`, password = `${crypto.randomBytes(8).toString('hex')}Aa1!`;
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    utenti.push(data.user.id);
    return { id: data.user.id, email, jwt: await sessione(email, password) };
  };
  const setup = async (u, body) => {
    const r = await fetch(`${base}/onboarding/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.jwt}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (j.company_id) aziende.push(j.company_id);
    return { status: r.status, body: j };
  };
  try {
    // Azienda "vera" con un nome riconoscibile
    const vera = (await supabase.from('companies').insert({ name: `Ediltrappola ${T.slice(-6)} S.r.l.` }).select().single()).data;
    aziende.push(vera.id);

    // 1. Invitato che entra con la stessa email ma senza passare dal link
    const inv = await nuovoUtente('invitato');
    const token = crypto.randomBytes(32).toString('hex');
    const ie = await supabase.from('company_invites').insert({ company_id: vera.id, email: inv.email.toUpperCase(), role: 'tech', token, invited_by: inv.id, expires_at: new Date(Date.now() + 48 * 3600e3).toISOString() });
    if (ie.error) throw new Error('invito di prova: ' + ie.error.message);
    const c = await fetch(`${base}/onboarding/controllo`, { headers: { Authorization: `Bearer ${inv.jwt}` } });
    const cb = await c.json().catch(() => ({}));
    check('controllo: l\'invito aperto per la sua email (maiuscole comprese)', c.status === 200 && cb.inviti?.length === 1 && cb.inviti[0].token === token && cb.inviti[0].azienda === vera.name && cb.inviti[0].ruolo === 'tech', cb);
    const s1 = await setup(inv, { company_name: 'Una nuova impresa qualsiasi' });
    check('con un invito aperto non crea un\'azienda: 409 INVITO_APERTO', s1.status === 409 && s1.body.error === 'INVITO_APERTO' && s1.body.inviti?.[0]?.token === token, s1);
    const { data: m1 } = await supabase.from('company_users').select('company_id').eq('user_id', inv.id);
    check('...e nessuna azienda nel DB', (m1 || []).length === 0, m1);

    // 2. Collega senza invito (es. Google con l'email personale) che scrive il nome dell'azienda vera
    const g = await nuovoUtente('google');
    const nomeDiverso = `EDILTRAPPOLA ${T.slice(-6)} srl`;
    const s2 = await setup(g, { company_name: nomeDiverso });
    check('nome di un\'azienda già su Palladia (scritto diverso): 409 AZIENDA_ESISTENTE', s2.status === 409 && s2.body.error === 'AZIENDA_ESISTENTE' && s2.body.nome === vera.name, s2);
    const s3 = await setup(g, { company_name: nomeDiverso, conferma_nome_simile: true });
    check('"è un\'altra impresa": confermando si crea', s3.status === 201 && !!s3.body.company_id, s3);

    // 3. Nome nuovo: come sempre
    const n = await nuovoUtente('nuovo');
    const s4 = await setup(n, { company_name: `Impresa Nuovissima ${T.slice(-6)}` });
    check('nome nuovo, nessun invito: creata come prima', s4.status === 201 && !!s4.body.company_id, s4);

    // 4. Un invito scaduto o già usato non blocca
    const sc = await nuovoUtente('scaduto');
    const se = await supabase.from('company_invites').insert({ company_id: vera.id, email: sc.email, role: 'tech', token: crypto.randomBytes(32).toString('hex'), invited_by: sc.id, expires_at: new Date(Date.now() - 3600e3).toISOString() });
    if (se.error) throw new Error('invito scaduto di prova: ' + se.error.message);
    const s5 = await setup(sc, { company_name: `Altra Impresa ${T.slice(-6)}` });
    check('invito scaduto: non blocca', s5.status === 201, s5);
  } finally {
    server.close();
    await supabase.from('company_invites').delete().like('email', `%${T.toLowerCase()}%`);
    await supabase.from('company_invites').delete().like('email', `%${T.toUpperCase()}%`);
    for (const id of aziende) { await supabase.from('company_users').delete().eq('company_id', id); await supabase.from('companies').delete().eq('id', id); }
    for (const id of utenti) await supabase.auth.admin.deleteUser(id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
