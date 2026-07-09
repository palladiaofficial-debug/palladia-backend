#!/usr/bin/env node
/**
 * scripts/eval-model-routing.js
 *
 * Confronta Haiku vs Sonnet sulle STESSE richieste di scrittura reali (stesso
 * SYSTEM_PROMPT, stessi 68 tool, stesso contesto cantiere) per decidere quali
 * scritture possono scendere a un modello più economico senza perdere
 * affidabilità nel tool-calling. Non tocca il DB — nessun tool viene
 * eseguito, si osserva solo la chiamata che il modello sceglie di fare.
 *
 * Uso: node scripts/eval-model-routing.js
 */
'use strict';
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const chat = require('../routes/v1/chat.js');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
});

// Contesto minimo realistico — stesso pattern del contesto dinamico che il
// backend appende dopo il blocco cacheable in produzione.
const SITE_ID   = '97b8444c-ad57-49b0-9161-f0626a98cb94'; // Via Fereggiano 175
const SITE_NAME = 'Via Fereggiano 175';
const dynamicContext = `\n\n[CONTESTO CANTIERE ATTIVO]\nL'utente sta guardando il cantiere "${SITE_NAME}" (id: ${SITE_ID}). Se la richiesta riguarda un'azione di scrittura senza specificare un cantiere diverso, usa questo.`;
const systemBlocks = chat.buildCachedSystem(chat.SYSTEM_PROMPT + dynamicContext);

const CASES = [
  {
    label: 'Nota diario semplice',
    tier: 'semplice',
    message: 'Aggiungi una nota al diario: oggi completata la posa del cappotto termico sul lato nord.',
    expectTool: 'create_diary_note',
  },
  {
    label: 'Chiudi cantiere',
    tier: 'semplice',
    message: 'Segna questo cantiere come chiuso.',
    expectTool: 'update_record', // o create_record/status update — verificare a mano
  },
  {
    label: 'Spesa semplice',
    tier: 'semplice',
    message: 'Registra una spesa di 350 euro, fattura del fornitore Edilcolor per pittura.',
    expectTool: 'create_record', // site_costs
  },
  {
    label: 'Promemoria semplice',
    tier: 'semplice',
    message: 'Aggiungi un promemoria: chiamare il fornitore ponteggi domani mattina.',
    expectTool: 'create_site_note',
  },
  {
    label: 'NC urgente sicurezza',
    tier: 'sicurezza',
    message: 'Crea una non conformità urgente: il ponteggio al secondo piano non ha i parapetti, rischio caduta grave.',
    expectTool: 'create_site_note',
  },
  {
    label: 'Incidente da documentare',
    tier: 'sicurezza',
    message: 'Segnala un incidente: un operaio è scivolato dalla scala questa mattina, nessun ferito grave ma va documentato.',
    expectTool: 'create_site_note',
  },
  {
    label: 'Diario integrato multi-tool',
    tier: 'complesso',
    message: 'Registra il diario di oggi integrando le presenze e il meteo di oggi.',
    expectTool: 'get_presence_today', // primo passo atteso, poi get_weather_log, poi create_record
  },
  {
    label: 'Assegnazione con più campi',
    tier: 'complesso',
    message: 'Assegna il lavoratore Marco Rossi a questo cantiere con qualifica capocantiere e segna la sua idoneità medica in scadenza il 15 marzo 2027.',
    expectTool: 'update_record', // worksite_workers + workers, 2 step attesi
  },
];

function summarizeToolCalls(resp) {
  const calls = resp.content.filter(b => b.type === 'tool_use');
  if (calls.length === 0) return { tools: [], text: (resp.content.find(b=>b.type==='text')?.text || '').slice(0,200) };
  return { tools: calls.map(c => ({ name: c.name, input: c.input })), text: null };
}

async function runOne(model, message) {
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemBlocks,
    tools: chat.TOOLS_CACHED,
    messages: [{ role: 'user', content: message }],
  });
  return { usage: resp.usage, ...summarizeToolCalls(resp) };
}

(async () => {
  for (const c of CASES) {
    console.log(`\n${'='.repeat(70)}\n[${c.tier.toUpperCase()}] ${c.label}\n"${c.message}"\n${'='.repeat(70)}`);

    const [haiku, sonnet] = await Promise.all([
      runOne(chat.MODEL_HAIKU, c.message).catch(e => ({ error: e.message })),
      runOne(chat.MODEL_SONNET, c.message).catch(e => ({ error: e.message })),
    ]);

    console.log('\n--- HAIKU ---');
    console.log(JSON.stringify(haiku, null, 2).slice(0, 1500));
    console.log('\n--- SONNET ---');
    console.log(JSON.stringify(sonnet, null, 2).slice(0, 1500));
  }
})();
