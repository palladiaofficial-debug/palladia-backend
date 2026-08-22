#!/usr/bin/env node
/**
 * scripts/selftest_invoice_channels.js
 *
 * Regressione per la vista unica sui tre canali fatture fornitore vivi (email,
 * delega Cassetto Fiscale A-Cube, importazione massiva storico) —
 * services/invoiceChannels.js, censimento del 2026-08-22 (AUDIT.md F-063).
 *
 * Copre anche il canale "Codice Destinatario diretto" rimosso nella stessa
 * modifica: deve restare rimosso (nessun file, nessuna funzione morta
 * riesumabile per errore, nessuna riga sopravvissuta a company_expenses).
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');
const { getInvoiceChannelsStatus } = require('../services/invoiceChannels');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function byType(result, type) {
  return result.channels.find((c) => c.channel_type === type);
}

async function main() {
  console.log('\n=== selftest_invoice_channels ===\n');

  // ── Il canale diretto rimosso il 2026-08-22 (F-063) non deve poter tornare
  // in vita in silenzio: né come file, né come funzione ancora esportata dal
  // motore condiviso. ──
  check(
    'routes/v1/sdiInvoices.js non esiste più',
    !fs.existsSync(path.join(__dirname, '../routes/v1/sdiInvoices.js')),
  );
  check(
    'lib/schemas/sdiInvoices.js non esiste più',
    !fs.existsSync(path.join(__dirname, '../lib/schemas/sdiInvoices.js')),
  );
  const sdiInvoicesExports = require('../services/sdiInvoices');
  check(
    'services/sdiInvoices.js non esporta più le funzioni del canale diretto',
    !sdiInvoicesExports.connectCompany
      && !sdiInvoicesExports.getConnectionStatus
      && !sdiInvoicesExports.disconnectCompany
      && !sdiInvoicesExports.mapInvoiceResponseToExpense
      && !sdiInvoicesExports.ingestSupplierInvoice
      && !sdiInvoicesExports.confirmLegalStorage,
    Object.keys(sdiInvoicesExports),
  );
  check(
    'services/sdiInvoices.js esporta ancora il motore condiviso',
    typeof sdiInvoicesExports.ingestMappedExpense === 'function',
  );

  const { error: tableError } = await supabase.from('sdi_configurations').select('id').limit(1);
  check("Tabella sdi_configurations rimossa dal DB (migrazione 176)", !!tableError, tableError);

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Invoice-Channels-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    // ── Nessun canale collegato: forma sempre coerente, mai un campo mancante. ──
    const empty = await getInvoiceChannelsStatus(companyId);
    check('3 canali sempre presenti nella risposta, anche a zero configurazioni', empty.channels.length === 3, empty.channels.map((c) => c.channel_type));
    check('email: non connesso di default', byType(empty, 'email').connected === false);
    check('acube_consultation: non connesso di default', byType(empty, 'acube_consultation').connected === false);
    check('massive_import: nessun batch di default', Array.isArray(byType(empty, 'massive_import').recent_batches) && byType(empty, 'massive_import').recent_batches.length === 0);

    // ── Distinzione esplicita persistente/one-shot richiesta dall'utente. ──
    check('email è "persistent"', byType(empty, 'email').kind === 'persistent');
    check('acube_consultation è "persistent"', byType(empty, 'acube_consultation').kind === 'persistent');
    check('massive_import è "one_shot"', byType(empty, 'massive_import').kind === 'one_shot');
    check('solo i canali persistenti espongono "connected"', typeof byType(empty, 'massive_import').connected === 'undefined');

    // ── Canale email attivo: connected true, indirizzo esposto. ──
    await supabase.from('email_ingest_configurations').insert({
      company_id: companyId, inbound_token: `invoice-channels-test-${companyId}`, status: 'active',
      last_invoice_received_at: '2026-08-20T10:00:00Z',
    });
    const withEmail = await getInvoiceChannelsStatus(companyId);
    check('email: connected true dopo l\'attivazione', byType(withEmail, 'email').connected === true);
    check('email: indirizzo presente', typeof byType(withEmail, 'email').address === 'string' && byType(withEmail, 'email').address.length > 0, byType(withEmail, 'email').address);
    check('email: last_invoice_received_at riportato', byType(withEmail, 'email').last_invoice_received_at === '2026-08-20T10:00:00+00:00' || !!byType(withEmail, 'email').last_invoice_received_at);

    // ── Delega Cassetto Fiscale attiva: connected true. ──
    await supabase.from('sdi_consultation_configurations').insert({
      company_id: companyId, fiscal_id: 'IT00000000000', status: 'active', last_poll_at: '2026-08-21T08:00:00Z',
    });
    const withConsultation = await getInvoiceChannelsStatus(companyId);
    check('acube_consultation: connected true dopo l\'attivazione', byType(withConsultation, 'acube_consultation').connected === true);
    check('acube_consultation: last_poll_at riportato', !!byType(withConsultation, 'acube_consultation').last_poll_at);
    check('email resta connesso (nessuna interferenza tra canali)', byType(withConsultation, 'email').connected === true);

    // ── Importazione massiva: cronologia batch, più recente per primo, tetto a 3. ──
    for (const [offsetMinutes, total] of [[30, 1], [20, 2], [10, 3], [0, 4]]) {
      await supabase.from('sdi_massive_import_batches').insert({
        company_id: companyId,
        total_candidates: total,
        status: 'done',
        created_at: new Date(Date.now() - offsetMinutes * 60000).toISOString(),
      });
    }
    const withBatches = await getInvoiceChannelsStatus(companyId);
    const massive = byType(withBatches, 'massive_import');
    check('massive_import: al massimo 3 batch restituiti (4 creati)', massive.recent_batches.length === 3, massive.recent_batches.length);
    check('massive_import: ordinati dal più recente', massive.recent_batches[0].total_candidates === 4, massive.recent_batches.map((b) => b.total_candidates));
    check('massive_import: last_batch_at coincide col batch più recente', massive.last_batch_at === massive.recent_batches[0].created_at);
    check('massive_import: nessun campo "connected" fuorviante', typeof massive.connected === 'undefined');

    // ── Nessuna riga company_expenses sopravvissuta al canale diretto rimosso. ──
    const { data: sdiAutoRows } = await supabase.from('company_expenses').select('id').eq('source', 'sdi_auto').limit(1);
    check('Nessuna spesa con source=sdi_auto nel DB', !sdiAutoRows || sdiAutoRows.length === 0, sdiAutoRows);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su tutte le tabelle canale
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
