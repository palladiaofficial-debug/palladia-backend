'use strict';

/**
 * services/sdiMassiveImport.js
 * Importazione massiva dello storico fatture — soluzione per i cantieri aperti da
 * mesi o anni che il canale email (F-060/F-061, solo da oggi in poi) e la delega
 * Cassetto Fiscale (services/sdiConsultation.js, mai verificata con un account
 * reale) non possono coprire.
 *
 * Il titolare scarica dal portale AdE "Fatture e Corrispettivi" (Consultazione →
 * Fatturazione Elettronica e altri dati IVA → Vai a consultazioni e download
 * massivi → Richieste → Fatture Elettroniche) uno ZIP con tutte le fatture
 * ricevute nel periodo scelto, e lo carica qui.
 *
 * Riusa l'intero motore già verificato per il canale email — stesso estrattore
 * (lib/fatturaPaEnvelopeParser.js), stesso mapping (lib/fatturaCandidateMapper.js),
 * stesso ingest condiviso (services/sdiInvoices.js::ingestMappedExpense) — cambia
 * solo l'origine del file (un caricamento diretto invece di un allegato email) e
 * il fatto che qui servono centinaia di fatture per una company sola invece di
 * una alla volta: elaborazione in background con avanzamento tracciato in
 * sdi_massive_import_batches (migrazione 171), a piccoli lotti come
 * services/smartImportPipeline.js, con lo stesso guardrail di budget AI.
 */

const supabase = require('../lib/supabase');
const { extractInvoiceCandidates } = require('../lib/fatturaPaEnvelopeParser');
const { mapCandidateToExpenseRow, toInvoiceShapeForAi, checkOcrOverlap } = require('../lib/fatturaCandidateMapper');
const { ingestMappedExpense } = require('./sdiInvoices');
const { checkAiBudget } = require('../lib/ladiaUsageLog');

// Ogni candidato è un parsing XML economico (nessuna chiamata di rete) — il tetto
// esiste solo per evitare un singolo caricamento fuori scala, non per un vincolo di
// costo come in Smart Import (AI vision per file). Un'azienda con un backlog più
// grande divide per periodo direttamente dal portale AdE (la richiesta guidata lo
// permette), suggerito nella procedura guidata quando questo tetto scatta.
const MAX_CANDIDATES_PER_BATCH = 1500;
const CONCURRENCY = 4;

const MASSIVE_IMPORT_NOTES = "Importata dallo storico fatture (download massivo dal portale Fatture e Corrispettivi dell'Agenzia delle Entrate).";

/**
 * Fase sincrona e veloce: apre lo zip, classifica le entry, crea la riga batch col
 * conteggio già noto. L'elaborazione vera (dedup, attribuzione cantiere, scrittura
 * in company_expenses) parte in background subito dopo.
 */
async function createMassiveImportBatch({ companyId, userId, zipBuffer }) {
  let allResults;
  try {
    allResults = extractInvoiceCandidates('storico-fatture.zip', zipBuffer);
  } catch (err) {
    throw new Error(`Archivio non apribile: ${err.message}`);
  }

  const invoiceCandidates = allResults.filter((r) => r.xml);
  // I PDF di cortesia isolati qui non hanno un'email "gemella" da cui il chiamante
  // possa correlarli (a differenza del canale email, dove PDF e XML arrivano nello
  // stesso messaggio) — su un backlog di centinaia di file non ha senso lanciare
  // un'estrazione OCR per ciascuno: contati come non-fattura, non elaborati.
  const notInvoiceCount = allResults.length - invoiceCandidates.length;

  if (invoiceCandidates.length === 0) {
    return { batchId: null, total: 0, notInvoiceCount, overflowCount: 0, empty: true };
  }

  const usable = invoiceCandidates.slice(0, MAX_CANDIDATES_PER_BATCH);
  const overflow = invoiceCandidates.slice(MAX_CANDIDATES_PER_BATCH);

  const { data: batch, error } = await supabase
    .from('sdi_massive_import_batches')
    .insert({
      company_id: companyId,
      created_by: userId || null,
      total_candidates: usable.length,
      skipped_not_invoice_count: notInvoiceCount,
      overflow_count: overflow.length,
    })
    .select('id')
    .single();
  if (error) throw new Error('Creazione batch fallita: ' + error.message);

  processMassiveImportBatch(batch.id, companyId, usable).catch((err) => {
    console.error('[sdiMassiveImport] elaborazione fallita:', batch.id, err.message);
    supabase.from('sdi_massive_import_batches')
      .update({ status: 'error', error_message: err.message, finished_at: new Date().toISOString() })
      .eq('id', batch.id)
      .then(null, () => {});
  });

  return { batchId: batch.id, total: usable.length, notInvoiceCount, overflowCount: overflow.length, empty: false };
}

async function processMassiveImportBatch(batchId, companyId, candidates) {
  const budget = await checkAiBudget(companyId);
  if (!budget.allowed) {
    await supabase.from('sdi_massive_import_batches').update({
      status: 'error',
      error_message: `Budget AI mensile superato ($${budget.spend?.toFixed(2)} su $${budget.limit}) — riprova più avanti o carica un periodo più corto.`,
      finished_at: new Date().toISOString(),
    }).eq('id', batchId);
    return;
  }

  const counters = { imported: 0, duplicate: 0, pendingReview: 0, error: 0 };

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (candidate) => {
      try {
        const expenseRow = mapCandidateToExpenseRow(companyId, candidate, {
          source: 'sdi_massive', notes: MASSIVE_IMPORT_NOTES,
        });

        // Stessa guardia del canale email: un'azienda che usa già Palladia da un po'
        // potrebbe aver inserito a mano alcune delle fatture che ora ricarica in
        // blocco — non duplicarle in silenzio, segnalale per la revisione.
        const overlap = await checkOcrOverlap(companyId, candidate.parsed).catch(() => null);
        if (overlap) {
          expenseRow.pending_review = true;
          expenseRow.pending_review_reason = `sembra già presente come spesa caricata il ${overlap.expense_date} (${overlap.supplier}, ${overlap.amount}€) — verifica prima di tenerle entrambe`;
        }

        const result = await ingestMappedExpense(
          companyId, expenseRow, toInvoiceShapeForAi(candidate.parsed),
          { configTable: null, dedupExtra: true, silent: true },
        );

        if (result.skipped) counters.duplicate++;
        else if (expenseRow.pending_review) counters.pendingReview++;
        else counters.imported++;
      } catch (err) {
        console.error('[sdiMassiveImport] errore su una fattura:', err.message);
        counters.error++;
      }
    }));

    await supabase.from('sdi_massive_import_batches').update({
      processed_count:      Math.min(i + chunk.length, candidates.length),
      imported_count:       counters.imported,
      duplicate_count:      counters.duplicate,
      pending_review_count: counters.pendingReview,
      error_count:          counters.error,
    }).eq('id', batchId);
  }

  await supabase.from('sdi_massive_import_batches')
    .update({ status: 'done', finished_at: new Date().toISOString() })
    .eq('id', batchId);
}

async function getMassiveImportBatchStatus(batchId, companyId) {
  const { data, error } = await supabase
    .from('sdi_massive_import_batches')
    .select('*')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Canale one-shot: non ha uno stato "connesso/attivo" come gli altri, solo una
// cronologia di caricamenti — usata dalla vista unica (services/invoiceChannels.js)
// per mostrare l'ultimo batch invece di un singolo stato persistente.
async function listRecentBatches(companyId, limit = 3) {
  const { data, error } = await supabase
    .from('sdi_massive_import_batches')
    .select('id, status, total_candidates, processed_count, imported_count, duplicate_count, pending_review_count, error_count, error_message, created_at, finished_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  createMassiveImportBatch,
  getMassiveImportBatchStatus,
  listRecentBatches,
  MAX_CANDIDATES_PER_BATCH,
};
