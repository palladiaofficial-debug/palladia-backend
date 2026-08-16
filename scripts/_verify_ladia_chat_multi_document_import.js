#!/usr/bin/env node
// Verifica dal vivo end-to-end (F-051, AUDIT.md): l'utente trascina in chat
// il file REALE con le buste paga (lo stesso di F-050) e chiede a Ladia di
// archiviarle sui rispettivi lavoratori — scenario esatto riportato
// dall'utente, che prima di questo fix riceveva un rifiuto falso
// ("Palladia non supporta..."). Nessun mock: upload reale via
// /api/v1/chat/upload, conversazione reale via /api/v1/chat/stream,
// Railway+Supabase+Anthropic reali. Ripulisce tutto a fine test.
'use strict';
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.argv[2] || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE         = process.argv[3] || 'https://palladia-backend-production.up.railway.app';
const FILE_PATH    = 'C:/Users/ricka/Downloads/CI10119@01@AZIENDA.PDF';

if (!ANON_KEY) { console.error('Manca la anon key'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMessage(jwt, companyId, message, conversationId, uploadIds) {
  const res = await fetch(`${BASE}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    body: JSON.stringify({ message, conversation_id: conversationId || undefined, context_type: 'azienda', upload_ids: uploadIds || [] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', convId = conversationId, fullText = '';
  const events = [];
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
        events.push(evt);
        if (evt.type === 'text' && evt.delta) fullText += evt.delta;
        if (evt.type === 'init' && evt.conversation_id) convId = evt.conversation_id;
      } catch { /* riga non-json */ }
    }
  }
  return { fullText, events, convId };
}

async function main() {
  console.log('\n\x1b[1mVerifica dal vivo — Ladia in chat gestisce un file con più buste paga (F-051)\x1b[0m\n');

  if (!fs.existsSync(FILE_PATH)) { console.error('File non trovato:', FILE_PATH); process.exit(1); }
  const pdfBuffer = fs.readFileSync(FILE_PATH);
  ok(`file reale letto (${(pdfBuffer.length / 1024).toFixed(0)}KB)`);

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

  let uploadId = null, convId = null, batchId = null;
  const cleanupStoragePaths = [];

  try {
    // ── Upload reale via l'endpoint della CHAT (non smart-import) ──────────
    const form = new FormData();
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'CI10119@01@AZIENDA.PDF');
    const uploadRes = await fetch(`${BASE}/api/v1/chat/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId }, body: form,
    });
    const uploadBody = await uploadRes.json().catch(() => null);
    check('upload reale via /api/v1/chat/upload riuscito', uploadRes.status === 200 && !!uploadBody?.upload_id, { status: uploadRes.status, body: uploadBody });
    uploadId = uploadBody?.upload_id;
    if (!uploadId) return report();

    // ── Turno 1 — esattamente la richiesta reale dell'utente ────────────────
    console.log('  ... invio messaggio (può richiedere fino a un minuto: classificazione Sonnet su 44 pagine)');
    const t1 = await sendMessage(jwt, companyId,
      'Ecco le bustepaga. Caricale nei rispettivi posti, così i lavoratori possono vederle direttamente dai badge',
      null, [uploadId]);
    convId = t1.convId;

    const toolNamesTurn1 = t1.events.filter(e => e.type === 'tool_start').flatMap(e => e.names || []);
    const eventTypesTurn1 = [...new Set(t1.events.map(e => e.type))];
    console.log(`  ... tipi di evento nel turno 1: ${eventTypesTurn1.join(', ')}`);
    console.log(`  ... tool chiamati nel turno 1: ${toolNamesTurn1.join(', ') || '(nessuno)'}`);
    const errorEventsT1 = t1.events.filter(e => e.type === 'error' || e.error);
    if (errorEventsT1.length) console.log('  ... EVENTI ERRORE turno 1: ' + JSON.stringify(errorEventsT1).slice(0, 1500));
    check('Ladia ha chiamato import_multi_document_batch (non un rifiuto)', toolNamesTurn1.includes('import_multi_document_batch'), toolNamesTurn1);
    check('Ladia NON ha detto che l\'operazione non è supportata', !/non\s+supporta|non\s+è\s+supportat/i.test(t1.fullText), t1.fullText.slice(0, 300));
    // Il messaggio contiene già un'istruzione esplicita di caricamento ("caricale") —
    // per la regola "niente conferma per singolo file" (stessa di archive_document),
    // Ladia deve confermare nello STESSO turno, senza fermarsi a chiedere "procedo?".
    check('Ladia ha confermato/scritto subito, senza fermarsi a chiedere permesso già dato', toolNamesTurn1.includes('confirm_multi_document_batch'), toolNamesTurn1);
    console.log('  ... risposta turno 1 (per diagnosi):\n' + t1.fullText.slice(0, 1200).split('\n').map(l => '      ' + l).join('\n'));

    // batch_id letto direttamente dal DB (più affidabile del parsing testo)
    await sleep(2000);
    const { data: batches } = await admin.from('import_batches')
      .select('id, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(1);
    batchId = batches?.[0]?.id;
    check('un import_batch reale è stato creato', !!batchId, batches);
    if (!batchId) return report();

    let { data: items } = await admin.from('import_items').select('status, destination, matched_worker_id, staged_worker_id').eq('batch_id', batchId);
    let confirmedPayslips = (items || []).filter(i => i.status === 'confirmed' && i.destination === 'payslips');

    // Caso limite reale osservato: se ci sono lavoratori con match ambiguo
    // (es. record duplicati), Ladia può fermarsi e chiedere come procedere
    // invece di scrivere tutto subito — un secondo turno di conferma è
    // legittimo in quel caso, non un fallimento. Copre anche quello.
    if (confirmedPayslips.length === 0) {
      console.log('  ... nessuna busta paga confermata nel turno 1, provo un turno di conferma esplicita');
      const t2 = await sendMessage(jwt, companyId, 'Sì, procedi.', convId, []);
      console.log('  ... risposta turno 2 (per diagnosi):\n' + t2.fullText.slice(0, 800).split('\n').map(l => '      ' + l).join('\n'));
      await sleep(2000);
      ({ data: items } = await admin.from('import_items').select('status, destination, matched_worker_id, staged_worker_id').eq('batch_id', batchId));
      confirmedPayslips = (items || []).filter(i => i.status === 'confirmed' && i.destination === 'payslips');
    }
    check('almeno una busta paga è stata scritta davvero in produzione (status=confirmed)', confirmedPayslips.length > 0, { total: items?.length, confirmed: confirmedPayslips.length });

    const { data: payslipRows } = await admin.from('payslips').select('id, worker_id, status, file_path').gte('created_at', new Date(Date.now() - 10 * 60000).toISOString());
    check('righe reali create nella tabella payslips negli ultimi 10 minuti', (payslipRows || []).length > 0, { count: payslipRows?.length });
    check('tutte in stato draft (mai auto-condivise col lavoratore)', (payslipRows || []).every(r => r.status === 'draft'), payslipRows);
    for (const r of (payslipRows || [])) if (r.file_path) cleanupStoragePaths.push(r.file_path);

  } finally {
    // ── Pulizia ────────────────────────────────────────────────────────────
    if (batchId) {
      const { data: batchItems } = await admin.from('import_items').select('id, chat_upload_id').eq('batch_id', batchId);
      for (const it of (batchItems || [])) {
        if (it.chat_upload_id) {
          const { data: up } = await admin.from('chat_uploads').select('storage_path').eq('id', it.chat_upload_id).maybeSingle();
          if (up?.storage_path) await admin.storage.from('site-documents').remove([up.storage_path]).catch(() => {});
        }
      }
      await admin.from('import_items').delete().eq('batch_id', batchId);
      await admin.from('import_staged_entities').delete().eq('batch_id', batchId);
      await admin.from('import_batches').delete().eq('id', batchId);
    }
    for (const p of cleanupStoragePaths) await admin.storage.from('site-documents').remove([p]).catch(() => {});
    // Cedolini scritti da questa verifica: individuati per data di creazione recente
    // (nessun altro processo scrive in payslips su questa company di test in parallelo).
    const { data: leftoverPayslips } = await admin.from('payslips').select('id').gte('created_at', new Date(Date.now() - 15 * 60000).toISOString());
    if (leftoverPayslips?.length) await admin.from('payslips').delete().in('id', leftoverPayslips.map(r => r.id));
    if (uploadId) {
      const { data: up } = await admin.from('chat_uploads').select('storage_path').eq('id', uploadId).maybeSingle();
      if (up?.storage_path) await admin.storage.from('site-documents').remove([up.storage_path]).catch(() => {});
      await admin.from('chat_uploads').delete().eq('id', uploadId);
    }
    if (convId) {
      try { await admin.from('chat_messages').delete().eq('conversation_id', convId); } catch { /* best-effort */ }
      try { await admin.from('conversations').delete().eq('id', convId); } catch { /* best-effort */ }
    }
    console.log('  (pulizia dati di test completata)');
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exit(1); });
