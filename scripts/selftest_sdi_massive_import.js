#!/usr/bin/env node
/**
 * scripts/selftest_sdi_massive_import.js
 *
 * Regressione per l'importazione massiva dello storico fatture (download AdE,
 * portale Fatture e Corrispettivi) — services/sdiMassiveImport.js. Copre esattamente
 * il gap trovato prima di costruire questa funzione: l'Importazione Intelligente
 * generica NON sapeva leggere XML FatturaPA né scrivere in company_expenses — questo
 * è il percorso dedicato che lo fa, riusando extractInvoiceCandidates/ingestMappedExpense
 * già verificati dal canale email.
 */
'use strict';
require('dotenv').config();
const AdmZip = require('adm-zip');
const supabase = require('../lib/supabase');
const { createMassiveImportBatch, getMassiveImportBatchStatus, MAX_CANDIDATES_PER_BATCH } = require('../services/sdiMassiveImport');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function invoiceXml({ numero, partitaIva = '01234567890', importo = '150.00', supplier = 'Fornitore Storico SRL', data = '2024-05-10' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${partitaIva}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${supplier}</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Numero>${numero}</Numero>
        <Data>${data}</Data>
        <ImportoTotaleDocumento>${importo}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi><DettaglioLinee><Descrizione>Materiali edili storico</Descrizione></DettaglioLinee></DatiBeniServizi>
    <DatiPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento></DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

function sdiNotificationXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<RicevutaConsegna versione="1.0">
  <IdentificativoSdI>12345678</IdentificativoSdI>
  <NomeFile>IT01234567890_00001.xml</NomeFile>
  <DataOraRicezione>2024-05-10T10:00:00</DataOraRicezione>
</RicevutaConsegna>`;
}

async function waitForBatch(batchId, companyId, { timeoutMs = 20000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const batch = await getMassiveImportBatchStatus(batchId, companyId);
    if (batch && (batch.status === 'done' || batch.status === 'error')) return batch;
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout in attesa del batch');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  console.log('\n=== selftest_sdi_massive_import ===\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Sdi-Massive-Import-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    // ── Zip stile download massivo AdE: 5 fatture reali + 1 notifica SdI (da
    // scartare) + 1 file spazzatura non riconoscibile — mai una sola fattura persa
    // in silenzio, ogni entry deve finire in una categoria esplicita. ──
    const zip = new AdmZip();
    for (let i = 1; i <= 5; i++) {
      zip.addFile(`IT01234567890_${String(i).padStart(5, '0')}.xml`, Buffer.from(invoiceXml({ numero: `MASSIVE-${i}`, importo: (100 + i).toFixed(2) }), 'utf8'));
    }
    zip.addFile('IT01234567890_ricevuta.xml', Buffer.from(sdiNotificationXml(), 'utf8'));
    zip.addFile('leggimi.txt', Buffer.from('non è una fattura', 'utf8'));

    const result = await createMassiveImportBatch({ companyId, userId: null, zipBuffer: zip.toBuffer() });
    check('5 fatture riconosciute nello zip', result.total === 5, result);
    check('2 entry non-fattura contate (notifica SdI + file spazzatura)', result.notInvoiceCount === 2, result);
    check('Nessun overflow su un batch piccolo', result.overflowCount === 0, result);
    check('Batch creato', !!result.batchId);

    const done = await waitForBatch(result.batchId, companyId);
    check('Batch arriva a "done"', done.status === 'done', done);
    check('5 fatture elaborate', done.processed_count === 5, done);
    check('5 fatture importate', done.imported_count === 5, done);
    check('Nessun duplicato al primo giro', done.duplicate_count === 0, done);
    check('Nessun errore', done.error_count === 0, done);

    const { data: expenses } = await supabase.from('company_expenses').select('id, invoice_number, source, notes').eq('company_id', companyId).eq('source', 'sdi_massive');
    check('5 righe company_expenses create con source=sdi_massive', (expenses || []).length === 5, expenses);
    check('Nota distingue lo storico AdE da un\'email inoltrata', (expenses || []).every((e) => /Agenzia delle Entrate/.test(e.notes)), expenses?.[0]?.notes);

    // ── Reinvio dello stesso zip: dedup, nessuna riga in più ──
    const result2 = await createMassiveImportBatch({ companyId, userId: null, zipBuffer: zip.toBuffer() });
    const done2 = await waitForBatch(result2.batchId, companyId);
    check('Reinvio: tutte e 5 risultano duplicate', done2.duplicate_count === 5, done2);
    check('Reinvio: zero nuove importazioni', done2.imported_count === 0, done2);
    const { data: expensesAfter } = await supabase.from('company_expenses').select('id').eq('company_id', companyId).eq('source', 'sdi_massive');
    check('Nessuna riga duplicata creata davvero nel DB', (expensesAfter || []).length === 5, expensesAfter);

    // ── Nessuna notifica in-app per singola fattura (silent:true) — un backlog di
    // centinaia non deve riempire il centro notifiche. ──
    const { count: notifCount } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('entity_type', 'company_expense');
    check('Nessuna notifica in-app creata per l\'importazione massiva', notifCount === 0, notifCount);

    // ── Sovrapposizione con una spesa già inserita a mano: deve finire in
    // pending_review, non silenziosamente duplicata o duplicata due volte. ──
    await supabase.from('company_expenses').insert({
      company_id: companyId, amount: 200, description: 'Manuale preesistente', category: 'materiali',
      payment_method: 'bonifico', is_deductible: true, source: 'manual',
      supplier: 'Fornitore Overlap SRL', expense_date: '2024-06-01',
    });
    const zipOverlap = new AdmZip();
    zipOverlap.addFile('overlap.xml', Buffer.from(invoiceXml({ numero: 'OVERLAP-1', importo: '200.00', supplier: 'Fornitore Overlap SRL', data: '2024-06-01' }), 'utf8'));
    const resultOverlap = await createMassiveImportBatch({ companyId, userId: null, zipBuffer: zipOverlap.toBuffer() });
    const doneOverlap = await waitForBatch(resultOverlap.batchId, companyId);
    check('Sovrapposizione con spesa manuale → pending_review, non importata silenziosamente', doneOverlap.pending_review_count === 1 && doneOverlap.imported_count === 0, doneOverlap);

    // ── Zip senza nessuna fattura dentro → gestito esplicitamente, nessun batch fantasma ──
    const zipEmpty = new AdmZip();
    zipEmpty.addFile('solo_ricevuta.xml', Buffer.from(sdiNotificationXml(), 'utf8'));
    const resultEmpty = await createMassiveImportBatch({ companyId, userId: null, zipBuffer: zipEmpty.toBuffer() });
    check('Zip senza fatture → empty:true, nessun batch creato', resultEmpty.empty === true && resultEmpty.batchId === null, resultEmpty);

    // ── Byte spazzatura al posto di uno zip → extractInvoiceCandidates lo gestisce
    // già internamente (stesso comportamento del canale email, mai un crash): 0
    // candidati, nessun batch fantasma, nessuna eccezione che risalga fin qui. ──
    const resultCorrupt = await createMassiveImportBatch({ companyId, userId: null, zipBuffer: Buffer.from('non è uno zip valido') });
    check('Byte spazzatura → nessuna fattura trovata, gestito senza crash', resultCorrupt.empty === true && resultCorrupt.batchId === null, resultCorrupt);

    check('MAX_CANDIDATES_PER_BATCH è un tetto ragionevole (> 500, headroom su un backlog pluriennale)', MAX_CANDIDATES_PER_BATCH > 500, MAX_CANDIDATES_PER_BATCH);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su company_expenses/sdi_massive_import_batches/notifications
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
