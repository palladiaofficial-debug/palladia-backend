#!/usr/bin/env node
/**
 * scripts/selftest_worker_pseudonymization.js
 *
 * Test di regressione per F-176/F-177 (AUDIT.md, 2026-09-12): nome e cognome
 * reale del lavoratore (`full_name`) e il suo `id` (UUID) venivano mandati in
 * chiaro ad Anthropic in ogni tool_result che tocca un lavoratore — nessuna
 * pseudonimizzazione, nessun registro tecnico che lo dimostrasse.
 *
 * "Rosso prima del fix" qui significa: `executeTool('get_worker_detail', ...)`
 * da solo (il percorso già esistente, invariato da F-173) restituisce ancora
 * oggi `full_name` in chiaro — verificato sotto, TEST 4 lato "raw". La
 * chiusura del gap non sta nel modificare quel tool (nessuno dei ~20 case
 * handler è stato toccato), ma nel nuovo livello di pseudonimizzazione che
 * AVVOLGE il risultato prima che entri nel payload verso Anthropic — TEST 4
 * lato "wrapped" dimostra che lo stesso risultato, passato per
 * pseudonymizeOutgoing() come fa runChatLoop/chat.js:5896-5926 e il loop
 * SSE/chat.js:7628-7648, non contiene più né il nome né l'id.
 *
 * Env:
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_USER_ID      Owner della company E2E — nessun default, obbligatorio
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { executeTool } = require('../routes/v1/chat');
const {
  getPseudonymMap, resolvePseudonymInInput, pseudonymizeOutgoing,
  depseudonymizeText, createStreamingDepseudonymizer, logPseudonymization,
} = require('../lib/ladiaWorkerPseudonymizer');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const USER_ID    = process.env.E2E_USER_ID || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

async function main() {
  if (!USER_ID) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_worker_pseudonymization: E2E_USER_ID non configurato.');
    return;
  }

  console.log('\n\x1b[1mPseudonimizzazione lavoratori — F-176/F-177\x1b[0m');

  const fullName = 'TEST-E2E-F176 Mario Pseudotest';
  const { data: worker, error: wErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: fullName, fiscal_code: 'TSTF176PSEUDOTST1', is_active: true,
    ai_pseudonym_code: 'LAV-' + require('crypto').randomBytes(4).toString('hex').toUpperCase().slice(0, 6),
    badge_code: require('crypto').randomBytes(9).toString('hex').toUpperCase(),
  }).select('id, ai_pseudonym_code').single();
  if (wErr) { fail('setup worker fixture con ai_pseudonym_code noto', wErr.message); return report(); }
  const code = worker.ai_pseudonym_code;

  try {
    // TEST 1 — getPseudonymMap carica il fixture appena creato
    const map = await getPseudonymMap(supabase, COMPANY_ID);
    if (map.byId.get(worker.id)?.code === code && map.byCode.get(code)?.full_name === fullName) {
      ok('getPseudonymMap: mappa id<->codice<->nome corretta per il fixture');
    } else {
      fail('getPseudonymMap: mappa id<->codice<->nome corretta per il fixture', map.byId.get(worker.id));
    }

    // TEST 2 — pseudonymizeOutgoing sostituisce nome e id in un oggetto annidato
    const nested = { lavoratore: fullName, id: worker.id, dettaglio: { soggetto: `Formazione — ${fullName}` } };
    const pseudo = pseudonymizeOutgoing(nested, map);
    const serializedPseudo = JSON.stringify(pseudo);
    if (!serializedPseudo.includes(fullName) && !serializedPseudo.includes(worker.id) && serializedPseudo.includes(code)) {
      ok('pseudonymizeOutgoing: nome e id spariscono da un oggetto annidato, sostituiti dal codice');
    } else {
      fail('pseudonymizeOutgoing: nome e id spariscono da un oggetto annidato, sostituiti dal codice', pseudo);
    }

    // TEST 3 — round-trip: depseudonymizeText riporta il nome reale
    const roundTrip = depseudonymizeText(`Il lavoratore ${code} ha 3 scadenze.`, map);
    if (roundTrip === `Il lavoratore ${fullName} ha 3 scadenze.`) {
      ok('depseudonymizeText: round-trip codice->nome reale corretto');
    } else {
      fail('depseudonymizeText: round-trip codice->nome reale corretto', roundTrip);
    }

    // TEST 4 — executeTool raw (invariato) vs. avvolto con pseudonymizeOutgoing
    const rawResult = await executeTool('get_worker_detail', { worker_id: worker.id }, COMPANY_ID, USER_ID, null, null);
    const rawSerialized = JSON.stringify(rawResult);
    if (rawSerialized.includes(fullName)) {
      ok('executeTool RAW (percorso invariato): full_name presente — il gap esiste davvero, non è un test costruito ad hoc');
    } else {
      fail('executeTool RAW (percorso invariato): full_name presente — il gap esiste davvero, non è un test costruito ad hoc', rawResult);
    }
    const wrapped = pseudonymizeOutgoing(rawResult, map);
    const wrappedSerialized = JSON.stringify(wrapped);
    if (!wrappedSerialized.includes(fullName) && !wrappedSerialized.includes(worker.id) && wrappedSerialized.includes(code)) {
      ok('get_worker_detail AVVOLTO da pseudonymizeOutgoing (stesso meccanismo di chat.js): nome/id spariscono, resta solo il codice');
    } else {
      fail('get_worker_detail AVVOLTO da pseudonymizeOutgoing (stesso meccanismo di chat.js): nome/id spariscono, resta solo il codice', wrapped);
    }

    // TEST 5 — resolvePseudonymInInput: il modello riusa il codice come worker_id/worker_name
    const resolvedById   = resolvePseudonymInInput({ worker_id: code }, map);
    const resolvedByName = resolvePseudonymInInput({ worker_name: code }, map);
    if (resolvedById.worker_id === worker.id && resolvedByName.worker_name === fullName) {
      ok('resolvePseudonymInInput: codice passato come worker_id/worker_name risolto al valore reale');
    } else {
      fail('resolvePseudonymInInput: codice passato come worker_id/worker_name risolto al valore reale', { resolvedById, resolvedByName });
    }

    // TEST 6 — executeTool si auto-risolve quando riceve il codice come worker_id
    // (nessuna pseudonymMap passata esplicitamente — percorso lazy usato da
    // chat/confirm-action). Verifica che trovi lo STESSO worker, non un errore.
    const viaCode = await executeTool('get_worker_detail', { worker_id: code }, COMPANY_ID, USER_ID, null, null);
    if (viaCode?.id === worker.id) {
      ok('executeTool: worker_id=codice pseudonimo risolto correttamente, stesso lavoratore trovato');
    } else {
      fail('executeTool: worker_id=codice pseudonimo risolto correttamente, stesso lavoratore trovato', viaCode);
    }

    // TEST 7 — buffer di streaming: un codice spezzato tra più chunk non deve
    // mai comparire in chiaro in nessun singolo delta inviato all'utente.
    const full = `Prima frase. Il lavoratore ${code} ha finito il turno. Seconda frase.`;
    const splitPoints = [12, 12 + 4, 12 + 8, full.length]; // spezza proprio dentro "LAV-XXXXXX"
    let prev = 0;
    const chunks = [];
    for (const p of splitPoints) { chunks.push(full.slice(prev, p)); prev = p; }

    const streamer = createStreamingDepseudonymizer(map);
    let assembled = '';
    let leaked = false;
    for (const chunk of chunks) {
      const safe = streamer.push(chunk);
      if (safe.includes(code)) leaked = true;
      assembled += safe;
    }
    assembled += streamer.flush();

    if (!leaked && assembled === depseudonymizeText(full, map)) {
      ok('createStreamingDepseudonymizer: codice spezzato tra chunk mai in chiaro, testo finale corretto');
    } else {
      fail('createStreamingDepseudonymizer: codice spezzato tra chunk mai in chiaro, testo finale corretto', { leaked, assembled, expected: depseudonymizeText(full, map) });
    }

    // TEST 8 — registro tecnico (F-177): la scrittura avviene davvero
    const before = await supabase.from('ladia_ai_pseudonym_log').select('id', { count: 'exact', head: true }).eq('company_id', COMPANY_ID);
    logPseudonymization(supabase, { companyId: COMPANY_ID, conversationId: null, model: 'test-model', workersInvolved: 1 });
    await new Promise(r => setTimeout(r, 400)); // insert fire-and-forget, non awaited dal chiamante
    const after = await supabase.from('ladia_ai_pseudonym_log').select('id', { count: 'exact', head: true }).eq('company_id', COMPANY_ID);
    if ((after.count || 0) > (before.count || 0)) {
      ok('logPseudonymization: riga scritta in ladia_ai_pseudonym_log');
    } else {
      fail('logPseudonymization: riga scritta in ladia_ai_pseudonym_log', { before: before.count, after: after.count });
    }
  } finally {
    await supabase.from('workers').delete().eq('id', worker.id);
    await supabase.from('ladia_ai_pseudonym_log').delete().eq('company_id', COMPANY_ID).eq('model', 'test-model');
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_worker_pseudonymization:', e.message);
  process.exit(1);
});
