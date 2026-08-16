#!/usr/bin/env node
// Verifica dal vivo (F-055, AUDIT.md): con withCacheBreakpoint applicato,
// un secondo turno nella STESSA conversazione deve ritrovare in cache_read
// il contenuto del primo turno (prima del fix, quel contenuto ricompariva
// ogni volta come input_tokens a prezzo pieno). Conversazione reale minima,
// 2 messaggi brevi senza tool/upload — costo trascurabile (Haiku, poche
// centinaia di token). Chiamata reale a /api/v1/chat/stream sul backend
// Railway, lettura reale di ladia_usage_log — non un ragionamento sul diff.
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.argv[2] || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE         = process.argv[3] || 'https://palladia-backend-production.up.railway.app';

if (!ANON_KEY) { console.error('Manca la anon key'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function sendMessage(jwt, companyId, message, conversationId) {
  const res = await fetch(`${BASE}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    body: JSON.stringify({ message, conversation_id: conversationId || undefined, context_type: 'azienda' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', convId = conversationId, fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'text' && evt.delta) fullText += evt.delta;
        if (evt.type === 'init' && evt.conversation_id) convId = evt.conversation_id;
      } catch { /* riga non-json */ }
    }
  }
  return { fullText, convId };
}

async function main() {
  console.log('\n\x1b[1mVerifica dal vivo — cache incrementale sui messages del turno chat (F-055)\x1b[0m\n');

  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const user = existingUsers?.users?.find(u => u.email === TEST_EMAIL);
  if (!user) { console.error('Utente ci-test non trovato'); process.exit(1); }
  const tmpPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tmpPassword });
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tmpPassword });
  if (signInErr) { console.error('login fallito:', signInErr.message); process.exit(1); }
  const jwt = session.session.access_token;

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map(m => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const mscedilizia = (companies || []).find(c => c.name === 'MSCedilizia');
  if (!mscedilizia) { console.error('MSCedilizia non trovata'); process.exit(1); }
  const companyId = mscedilizia.id;
  ok(`sessione reale ottenuta su ${mscedilizia.name}`);

  let convId = null;
  try {
    const t0 = Date.now();
    const t1 = await sendMessage(jwt, companyId, 'Ciao Ladia, dimmi in una frase cos\'è un DPI.', null);
    convId = t1.convId;
    check('turno 1 completato, conversazione creata', !!convId, t1);

    const t2 = await sendMessage(jwt, companyId, 'Grazie. Dimmi ora in una frase cos\'è il DVR.', convId);
    check('turno 2 completato nella stessa conversazione', t2.convId === convId, t2.convId);

    // ladia_usage_log scritto in modo asincrono (fire-and-forget) da logUsage —
    // piccola attesa per essere sicuri che le righe siano committate.
    await new Promise(r => setTimeout(r, 3000));

    const { data: rows } = await admin
      .from('ladia_usage_log')
      .select('created_at, input_tokens, cache_creation_tokens, cache_read_tokens')
      .eq('call_site', 'chat_stream')
      .gte('created_at', new Date(t0 - 5000).toISOString())
      .order('created_at', { ascending: true });

    console.log('  ... righe usage log trovate:', JSON.stringify(rows));
    check('almeno 2 righe chat_stream registrate (turno 1 + turno 2)', (rows || []).length >= 2, rows);
    if ((rows || []).length >= 2) {
      const [row1, row2] = rows;
      // Prima del fix: row2.cache_read_tokens sarebbe rimasto uguale a row1
      // (solo system+tools), e il contenuto del turno 1 (messaggio utente +
      // risposta assistant) sarebbe ricomparso per intero in row2.input_tokens.
      // Dopo il fix: row2.cache_read_tokens include anche quel contenuto.
      check('turno 2 → cache_read_tokens è cresciuto rispetto al turno 1 (il turno 1 è stato ritrovato in cache, non ripagato)',
        row2.cache_read_tokens > row1.cache_read_tokens,
        { turno1_cache_read: row1.cache_read_tokens, turno2_cache_read: row2.cache_read_tokens });
      check('turno 2 → input_tokens NON esplode (il contenuto del turno 1 non è stato ripagato a prezzo pieno)',
        row2.input_tokens < 500,
        { turno2_input_tokens: row2.input_tokens });
    }
  } finally {
    if (convId) {
      try { await admin.from('chat_messages').delete().eq('conversation_id', convId); } catch { /* best-effort */ }
      try { await admin.from('conversations').delete().eq('id', convId); } catch { /* best-effort */ }
    }
    console.log('  (pulizia dati di test completata)');
  }

  console.log(`\n${passed} passati, ${failed} falliti.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exit(1); });
