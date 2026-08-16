#!/usr/bin/env node
/**
 * scripts/selftest_chat_cache_breakpoint.js
 *
 * Test di regressione per F-055 (AUDIT.md): il loop agentico di Ladia in chat
 * (sia lo streaming reale in routes/v1/chat.js che il ramo legacy runChatLoop)
 * ricostruisce `messages` a ogni iterazione senza mai marcare un breakpoint di
 * cache — ogni giro dello stesso turno ripagava a prezzo pieno tutto il
 * contenuto già mandato al modello nei giri precedenti (osservato sui log
 * reali: da 1523 a 7650 token non in cache in soli 5 giri, a fronte di un
 * cache_read fisso che dimostra che SOLO system+tools erano in cache).
 *
 * Questo test verifica `withCacheBreakpoint` in isolamento (nessuna chiamata
 * Anthropic, zero costo): marca sempre l'ultimo blocco dell'ultimo messaggio
 * con cache_control, gestisce sia content stringa che content array (immagini
 * o tool_result), e NON muta l'array originale (che deve restare pulito per
 * il salvataggio su chat_messages e per l'append del giro successivo).
 */
'use strict';
require('dotenv').config();
const { withCacheBreakpoint } = require('../routes/v1/chat');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\n=== selftest_chat_cache_breakpoint (F-055) ===\n');

// Array vuoto: non deve esplodere
check('array vuoto → ritorna invariato', JSON.stringify(withCacheBreakpoint([])) === '[]');

// content stringa (messaggio utente semplice, senza immagini)
{
  const msgs = [{ role: 'user', content: 'Ciao Ladia' }];
  const out = withCacheBreakpoint(msgs);
  const lastBlock = out[out.length - 1].content[out[out.length - 1].content.length - 1];
  check('content stringa → convertito in blocco text con cache_control',
    lastBlock?.type === 'text' && lastBlock.text === 'Ciao Ladia' && lastBlock.cache_control?.type === 'ephemeral',
    lastBlock);
  check('content stringa → NON muta il messaggio originale', typeof msgs[0].content === 'string', msgs[0].content);
}

// content array con più blocchi (es. tool_result multipli, come nel loop agentico) —
// solo l'ULTIMO blocco deve avere cache_control, non tutti.
{
  const msgs = [
    { role: 'user', content: 'primo turno' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' },
      { type: 'tool_result', tool_use_id: 't2', content: '{"ok":true}' },
    ] },
  ];
  const originalLastContentRef = msgs[2].content;
  const out = withCacheBreakpoint(msgs);
  const outLastMsg = out[out.length - 1];
  check('array con più blocchi → lunghezza invariata', outLastMsg.content.length === 2, outLastMsg.content);
  check('array con più blocchi → SOLO l\'ultimo ha cache_control', !outLastMsg.content[0].cache_control && outLastMsg.content[1].cache_control?.type === 'ephemeral', outLastMsg.content);
  check('array con più blocchi → NON muta l\'array messages originale', msgs[2].content === originalLastContentRef && !originalLastContentRef[1].cache_control, originalLastContentRef);
  check('messaggi precedenti (non l\'ultimo) restano intoccati', out[0].content === 'primo turno' && !Array.isArray(out[1].content[0].cache_control), out);
}

// ttl esplicito richiesto dal beta header extended-cache-ttl (coerente con
// buildCachedSystem/TOOLS_CACHED — un TTL diverso qui romperebbe il pattern
// "stesso prefisso, stesso TTL" su cui si basa il riuso della cache.
{
  const msgs = [{ role: 'user', content: 'x' }];
  const out = withCacheBreakpoint(msgs);
  const block = out[0].content[0];
  check('usa ttl 1h come system/tools', block.cache_control?.ttl === '1h', block.cache_control);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exit(failed > 0 ? 1 : 0);
