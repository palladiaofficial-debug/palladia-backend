#!/usr/bin/env node
/**
 * scripts/ladia_cost_probe.js — misura del costo reale di Ladia (F-245).
 *
 * Fa a Ladia, sul backend indicato, un insieme fisso di domande di SOLA
 * LETTURA con l'utente di prova E2E, poi legge da ladia_usage_log quante
 * chiamate al modello ha fatto ogni domanda e quanto è costata. Serve a
 * confrontare prima/dopo una modifica con numeri veri, non stime.
 *
 * Env: E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID, SUPABASE_URL,
 *      SUPABASE_ANON_KEY (o VITE_SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY
 * Uso: node scripts/ladia_cost_probe.js [etichetta] [api_base]
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const LABEL = process.argv[2] || 'misura';
const API = process.argv[3] || 'https://palladia-backend-production.up.railway.app/api/v1';
const QUESTIONS = [
  'Chi è presente oggi in cantiere?',
  'Quali lavoratori hanno documenti scaduti o in scadenza?',
  'Come siamo messi in generale?',
  'Quali cantieri sono attivi?',
  'Ci sono scadenze questa settimana?',
  'Quante buste paga ho caricato questo mese?',
];

async function ask(jwt, companyId, question) {
  const headers = { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' };
  const conv = await (await fetch(`${API}/chat/conversations`, { method: 'POST', headers, body: JSON.stringify({ title: `[probe ${LABEL}] ${question}` }) })).json();
  const conversationId = conv.id || conv.conversation?.id;
  const t0 = Date.now();
  const res = await fetch(`${API}/chat/stream`, { method: 'POST', headers, body: JSON.stringify({ message: question, conversation_id: conversationId, history: [] }) });
  const text = await res.text(); // consuma tutto lo stream SSE
  const answer = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
    .filter(Boolean).map(e => e.text || e.delta || '').join('');
  return { conversationId, ms: Date.now() - t0, status: res.status, answer };
}

(async () => {
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const sb = createClient(process.env.SUPABASE_URL, anonKey);
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await sb.auth.signInWithPassword({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD });
  if (error) throw new Error('login: ' + error.message);
  const jwt = data.session.access_token;
  const companyId = process.env.E2E_COMPANY_ID;

  const results = [];
  for (const q of QUESTIONS) {
    const r = await ask(jwt, companyId, q);
    await new Promise(ok => setTimeout(ok, 2500)); // lascia scrivere il log d'uso
    const { data: rows } = await admin.from('ladia_usage_log')
      .select('model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd')
      .eq('conversation_id', r.conversationId).eq('call_site', 'chat_stream');
    const calls = rows?.length || 0;
    const cost = (rows || []).reduce((a, x) => a + Number(x.estimated_cost_usd || 0), 0);
    const read = (rows || []).reduce((a, x) => a + (x.cache_read_tokens || 0), 0);
    results.push({ q, calls, cost, read, model: rows?.[0]?.model, ms: r.ms, status: r.status, answer: r.answer.replace(/\s+/g, ' ').slice(0, 160) });
    console.log(`${String(calls).padStart(2)} chiamate  $${cost.toFixed(4)}  ${Math.round(read / 1000)}k letti  ${r.ms}ms  ${rows?.[0]?.model?.includes('haiku') ? 'haiku ' : 'sonnet'}  ${q}`);
  }
  const tot = results.reduce((a, r) => a + r.cost, 0);
  const calls = results.reduce((a, r) => a + r.calls, 0);
  console.log(`\n[${LABEL}] totale $${tot.toFixed(4)} · media $${(tot / results.length).toFixed(4)} a domanda · ${(calls / results.length).toFixed(1)} chiamate a domanda`);
  console.log('\nRisposte (prime righe):');
  for (const r of results) console.log(`- ${r.q}\n  ${r.answer}`);
})().catch(e => { console.error(e.message); process.exit(1); });
