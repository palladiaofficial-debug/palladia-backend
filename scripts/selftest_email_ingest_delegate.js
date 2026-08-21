#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_delegate.js
 *
 * Regressione per la delega a terzi del canale fatture via email
 * (services/emailIngestConfig.js → sendDelegateInstructions, lib/emailIngestProviders.js).
 * Non manda email reali: sendDelegateInstructions tocca solo il DB — l'invio vero
 * e proprio (services/email.js → sendEmailIngestDelegateInstructions) è chiamato a
 * parte dalla rotta, fuori da questa funzione, apposta per poter testare la logica
 * di stato senza dipendere da Resend a ogni run di `npm test`.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { sendDelegateInstructions, getStatus } = require('../services/emailIngestConfig');
const { EMAIL_PROVIDERS, getProvider } = require('../lib/emailIngestProviders');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== selftest_email_ingest_delegate ===\n');

  // ── Dati statici: ogni provider deve avere passi utilizzabili sia dal wizard
  // sia dall'email di delega — un provider senza passi o senza nota di conferma
  // romperebbe silenziosamente una delle due superfici.
  check('5 provider definiti', EMAIL_PROVIDERS.length === 5, EMAIL_PROVIDERS.map((p) => p.key));
  check('Ogni provider ha almeno un passo con testo', EMAIL_PROVIDERS.every((p) => p.steps.length > 0 && p.steps.every((s) => typeof s.text === 'string' && s.text.length > 0)));
  check('Ogni provider ha una nota di conferma', EMAIL_PROVIDERS.every((p) => typeof p.confirmNote === 'string' && p.confirmNote.length > 0));
  check('getProvider risolve una chiave nota', getProvider('aruba')?.label === 'Aruba PEC');
  check('getProvider ritorna null per una chiave sconosciuta', getProvider('non-esiste') === null);

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Email-Ingest-Delegate-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    // ── Canale non ancora collegato: la delega deve rifiutarsi esplicitamente,
    // non creare uno stato a metà (delegate_email salvato senza un canale attivo
    // dietro sarebbe un indirizzo dedicato che non esiste ancora). ──
    let threwForMissingChannel = false;
    try {
      await sendDelegateInstructions(companyId, 'delegato@example.com', 'aruba');
    } catch { threwForMissingChannel = true; }
    check('Rifiuta la delega se il canale non è collegato', threwForMissingChannel);

    await supabase.from('email_ingest_configurations').insert({
      company_id: companyId, inbound_token: `delegate-test-${companyId}`, status: 'active',
    });

    // ── Provider inesistente: mai passare al livello email un provider senza
    // passi — l'email risulterebbe vuota o con testo indefinito. ──
    let threwForBadProvider = false;
    try {
      await sendDelegateInstructions(companyId, 'delegato@example.com', 'provider-inventato');
    } catch { threwForBadProvider = true; }
    check('Rifiuta un provider_key non riconosciuto', threwForBadProvider);

    // ── Percorso reale: delega su un provider valido, canale attivo. ──
    const result = await sendDelegateInstructions(companyId, 'delegato@example.com', 'legalmail');
    check('Ritorna l\'indirizzo dedicato', result.address?.endsWith('@palladia.net'), result.address);
    check('Ritorna i dati del provider scelto', result.provider?.key === 'legalmail', result.provider);
    check('Ritorna un timestamp di invio', !!result.sentAt, result.sentAt);

    const status = await getStatus(companyId);
    check('Lo stato riflette l\'indirizzo delegato', status.delegate_email === 'delegato@example.com', status.delegate_email);
    check('Lo stato riflette il provider delegato', status.delegate_provider === 'legalmail', status.delegate_provider);
    check('Lo stato riflette la data di invio', !!status.delegate_instructions_sent_at, status.delegate_instructions_sent_at);

    // ── Rideleghe successive sovrascrivono, non accumulano — al titolare serve
    // sapere l'ULTIMO stato, non uno storico. ──
    const result2 = await sendDelegateInstructions(companyId, 'altro@example.com', 'gmail');
    check('Una seconda delega sovrascrive indirizzo e provider', result2.provider.key === 'gmail');
    const status2 = await getStatus(companyId);
    check('Lo stato mostra solo l\'ultima delega (indirizzo aggiornato)', status2.delegate_email === 'altro@example.com', status2.delegate_email);
    check('Lo stato mostra solo l\'ultima delega (provider aggiornato)', status2.delegate_provider === 'gmail', status2.delegate_provider);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su email_ingest_configurations
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
