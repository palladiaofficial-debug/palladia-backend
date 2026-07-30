#!/usr/bin/env node
// Verifica dal vivo (server reale, non un test unitario) che dopo un update
// della scadenza formazione di un lavoratore Ladia riporti il verdetto reale
// calcolato da lib/compliance.js invece di una sua stima. Usa un magic link
// (generateLink + verifyOtp) per ottenere una sessione senza toccare la
// password reale dell'utente — stesso pattern già usato per verifiche live.
require('dotenv').config();
require('dotenv').config({ path: 'C:/Users/ricka/palladia/.env' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY;
const BACKEND_URL  = 'https://palladia-backend-production.up.railway.app';
const COMPANY_ID   = '309e9018-1bcc-4876-9430-99cb89e043dd';
const WORKER_ID    = 'aa99432c-b377-4dd2-8ced-3e4ec803038e'; // Marco Test — entrambe le scadenze null

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon  = createClient(SUPABASE_URL, ANON_KEY,   { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email: 'carpio@mscedilizia.it',
  });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');

  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  const accessToken = verified.session.access_token;

  const res = await fetch(`${BACKEND_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-Company-Id': COMPANY_ID },
    body: JSON.stringify({
      message: `Aggiorna la scadenza della formazione sicurezza di Marco Test (id ${WORKER_ID}) al 2027-01-01. Procedi direttamente, ho già confermato.`,
      context_type: 'azienda',
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';
  let pendingActionId = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'text' && evt.delta) full += evt.delta;
        if (evt.type === 'tool_start') console.log('[tool_start]', evt.names);
        if (evt.type === 'pending_action') { pendingActionId = evt.pending_action_id; console.log('[pending_action]', evt); }
      } catch {}
    }
  }
  console.log('\n=== Risposta completa di Ladia (proposta) ===\n');
  console.log(full);

  if (!pendingActionId) throw new Error('Nessuna pending_action_id catturata — impossibile confermare');

  // Simula il click "Conferma" sulla card — stesso endpoint del frontend
  const confirmRes = await fetch(`${BACKEND_URL}/api/v1/chat/confirm-action/${pendingActionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-Company-Id': COMPANY_ID },
    body: JSON.stringify({ decision: 'approve' }),
  });
  const confirmBody = await confirmRes.json();
  console.log('\n=== Risultato reale di /chat/confirm-action (quello che il "compilatore" restituisce) ===\n');
  console.log(JSON.stringify(confirmBody, null, 2));

  const { data: w } = await admin.from('workers').select('safety_training_expiry, health_fitness_expiry').eq('id', WORKER_ID).single();
  console.log('\n=== Stato reale DB dopo la scrittura ===\n', w);

  // cleanup — rimette il worker di test come prima (entrambe null)
  await admin.from('workers').update({ safety_training_expiry: null, health_fitness_expiry: null }).eq('id', WORKER_ID);
  console.log('\n(worker di test ripristinato a null/null)');
}

main().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
