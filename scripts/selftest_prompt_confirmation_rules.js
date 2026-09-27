#!/usr/bin/env node
/**
 * scripts/selftest_prompt_confirmation_rules.js — F-247 (AUDIT.md)
 *
 * Il prompt di Ladia conteneva insieme "esegui senza chiedere conferma" e tre
 * regole di conferma incondizionata ("prima di QUALSIASI tool di scrittura
 * chiedi 'Confermo?'", "prima di salvare [un'immagine] chiedi sempre
 * conferma", "conferma SEMPRE i dati prima" nei tool generici). Ha vinto la
 * conferma: il DURC di AYAT allegato con "ecco il durc aggiornato" è rimasto
 * un "Confermo?" senza seguito. Qui si controlla il testo reale inviato al
 * modello (prompt + descrizioni dei tool attivi): una sola regola, e il caso
 * "file + intenzione di salvarlo" esplicitamente senza conferma.
 */
'use strict';
require('dotenv').config();
const chat = require('../routes/v1/chat');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
}

console.log('\n\x1b[1mF-247 — una sola regola di conferma nel prompt di Ladia\x1b[0m');
const P = chat.SYSTEM_PROMPT;
check('SYSTEM_PROMPT esportato', typeof P === 'string' && P.length > 10000);
check('niente "prima di QUALSIASI tool di scrittura … Confermo?"', !/Prima di chiamare QUALSIASI tool di scrittura/.test(P) && !/Chiedi: "Confermo\?"/.test(P));
check('niente "prima di salvare mostra sempre il riepilogo e chiedi conferma"', !/Prima di salvare mostra sempre il riepilogo/.test(P));
check('regola unica presente', /QUANDO CHIEDERE CONFERMA \(regola unica/.test(P));
check('file allegato + "ecco il … aggiornato" = istruzione già data', /FILE ALLEGATO \+ intenzione di salvarlo o aggiornare = istruzione GIÀ DATA/.test(P) && /ecco il DURC aggiornato/.test(P));
check('documenti di un subappaltatore → subcontractor_documents, mai company_documents', /destination="subcontractor_documents"/.test(P));

const tools = chat.TOOLS_CACHED || [];
check('schema dei tool letto', tools.length > 20, tools.length);
const desc = t => JSON.stringify(t);
const generic = tools.filter(t => ['create_record', 'update_record'].includes(t.name));
check('create_record/update_record senza "conferma SEMPRE i dati prima"', generic.length === 0 || generic.every(t => !/conferma SEMPRE i dati prima/.test(desc(t))), generic.map(t => t.name));
const archive = tools.find(t => t.name === 'archive_document');
check('archive_document accetta subcontractor_documents + subcontractor_name', !archive || (archive.input_schema.properties.destination.enum.includes('subcontractor_documents') && !!archive.input_schema.properties.subcontractor_name), archive?.input_schema?.properties?.destination);

console.log(`\n${passed} passati, ${failed} falliti.\n`);
process.exit(failed ? 1 : 0);
