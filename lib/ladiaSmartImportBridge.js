'use strict';
/**
 * lib/ladiaSmartImportBridge.js
 * Ponte tra la chat di Ladia e la pipeline di Importazione Intelligente
 * (services/smartImportPipeline.js) — usato dai tool import_multi_document_batch
 * e confirm_multi_document_batch in routes/v1/chat.js. chat.js è congelato
 * (vedi CLAUDE.md): la logica vive tutta qui, chat.js si limita a chiamarla.
 *
 * Caso reale che ha reso necessario questo modulo: un utente trascina in
 * chat un unico PDF con più documenti uniti (es. le buste paga di 16
 * lavoratori come arrivano ogni mese dal consulente del lavoro) — prima
 * d'ora Ladia in chat aveva solo archive_document, pensato per UN documento
 * alla volta, e rispondeva (a ragione, dato il suo strumentario) che
 * l'operazione "non è supportata" — falso: lo è, tramite Importazione
 * Intelligente (services/smartImportPipeline.js, F-050 in AUDIT.md), solo
 * mai raggiungibile dalla chat. Questo modulo chiude quel divario.
 */

const supabase = require('./supabase');
const pipeline = require('../services/smartImportPipeline');

const BUCKET = 'site-documents';
const POLL_INTERVAL_MS = 3000;
// Stesso ordine di grandezza osservato dal vivo per un file lungo instradato
// a Sonnet (F-050, AUDIT.md — un file reale di 44 pagine/16 buste paga ha
// impiegato ~110s a fine-a-fine per completare TUTTI gli item figli, non
// solo la classificazione iniziale — vedi F-053, motivo per cui questo tetto
// è più alto di quello usato solo per riferire lo stato in startImportFromChatUpload).
const MAX_POLL_MS = 150000;

function sleep(ms) { return new Promise(r => { setTimeout(r, ms); }); }

async function batchItemsSnapshot(batchId, companyId) {
  const { data: batch } = await supabase.from('import_batches').select('id').eq('id', batchId).eq('company_id', companyId).maybeSingle();
  if (!batch) return null;
  const { data: items } = await supabase.from('import_items').select('status, destination, doc_type, overall_confidence').eq('batch_id', batchId);
  return items || [];
}

function summarize(items) {
  // needs_split è il genitore già spacchettato in item figli — non un
  // documento finale, escluso dal conteggio per non contare due volte.
  const leafItems = items.filter(i => i.status !== 'needs_split');
  const byDestination = {};
  for (const it of leafItems) byDestination[it.destination || 'sconosciuto'] = (byDestination[it.destination || 'sconosciuto'] || 0) + 1;
  const stillProcessing = leafItems.some(i => ['pending', 'processing', 'needs_split', 'queued'].includes(i.status));
  const greenCount = leafItems.filter(i => (i.overall_confidence || 0) >= 0.85 && i.status === 'pending_review').length;
  return { total: leafItems.length, byDestination, stillProcessing, greenCount };
}

// Aspetta (con un tetto massimo) che il batch smetta di elaborare item in
// background — usata sia per riferire lo stato (startImportFromChatUpload)
// sia, con un tetto più alto, prima di confermare (confirmHighConfidenceBatch):
// senza aspettare la fine reale, confermare "quello che è pronto adesso" perde
// per sempre i documenti che finiscono di elaborare un attimo dopo — trovato
// dal vivo (F-053, AUDIT.md): 7 buste paga su 17, tutte con confidence 1.0,
// mai confermate perché diventate pronte dopo l'istantanea presa da
// confirmAllGreen, e nessuno è mai tornato a riprenderle.
async function waitForBatchSettled(batchId, companyId, maxMs) {
  const deadline = Date.now() + maxMs;
  let items = (await batchItemsSnapshot(batchId, companyId)) || [];
  while (Date.now() < deadline) {
    const sum = summarize(items);
    if (!sum.stillProcessing && items.length > 0) break;
    await sleep(POLL_INTERVAL_MS);
    items = (await batchItemsSnapshot(batchId, companyId)) || [];
  }
  return items;
}

/**
 * Avvia l'Importazione Intelligente su un file già caricato in chat (invece
 * di archive_document, che gestisce un solo documento alla volta). Aspetta
 * (con un tetto massimo) che la classificazione finisca, così Ladia può
 * riferire subito cosa contiene davvero il file invece di rispondere "ho
 * iniziato" senza saperlo — nessuna scrittura in produzione qui: solo
 * classificazione, la scrittura resta un passo separato ed esplicito
 * (confirm_multi_document_batch), mai automatica.
 */
async function startImportFromChatUpload({ uploadId, companyId, userId }) {
  const { data: upload } = await supabase
    .from('chat_uploads')
    .select('id, original_name, mime_type, storage_path, size_bytes, archived')
    .eq('id', uploadId).eq('company_id', companyId).maybeSingle();
  if (!upload) return { error: 'File non trovato o accesso negato.' };
  if (upload.archived) return { error: 'Questo file è già stato archiviato.' };

  const { data: fileBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(upload.storage_path);
  if (dlErr || !fileBlob) return { error: 'Download del file fallito: ' + (dlErr?.message || 'sconosciuto') };
  const buffer = Buffer.from(await fileBlob.arrayBuffer());

  const result = await pipeline.createBatchFromFiles({
    companyId, userId,
    files: [{ originalname: upload.original_name, buffer, mimetype: upload.mime_type }],
  });
  if (result.empty || !result.batchId) return { error: 'Impossibile analizzare questo file.', skipped: result.skipped };

  const items = await waitForBatchSettled(result.batchId, companyId, MAX_POLL_MS);
  const sum = summarize(items);
  return {
    batch_id: result.batchId,
    documenti_totali: sum.total,
    per_destinazione: sum.byDestination,
    ancora_in_elaborazione: sum.stillProcessing,
    pronti_per_conferma_rapida: sum.greenCount,
    nota: sum.stillProcessing
      ? 'Alcuni documenti sono ancora in elaborazione — puoi comunque procedere: il resto si completa in background e resta visibile su Importazione Intelligente.'
      : null,
  };
}

/**
 * Conferma (scrittura reale in produzione) SOLO i documenti con confidenza
 * alta (>=0.85, stessa soglia di "Conferma tutti i verdi" nell'interfaccia
 * di Importazione Intelligente) — mai l'intero batch alla cieca. I documenti
 * sotto soglia restano in coda di revisione manuale, mai scritti in automatico.
 */
async function confirmHighConfidenceBatch({ batchId, companyId, userId, req = null }) {
  const { data: batch } = await supabase.from('import_batches').select('id').eq('id', batchId).eq('company_id', companyId).maybeSingle();
  if (!batch) return { error: 'Batch non trovato o accesso negato.' };

  // Aspetta che il batch finisca di elaborare in background PRIMA di
  // confermare — altrimenti confirmAllGreen prende un'istantanea di "quello
  // che è pronto adesso" e i documenti che finiscono di elaborare un attimo
  // dopo restano orfani per sempre (F-053, AUDIT.md).
  await waitForBatchSettled(batchId, companyId, MAX_POLL_MS);

  const first = await pipeline.confirmAllGreen(batchId, companyId, userId, req);

  // Rete di sicurezza: anche con l'attesa sopra, un documento potrebbe
  // diventare pronto proprio durante il ciclo di conferma (che è sequenziale
  // e richiede alcuni secondi per molti documenti) — un secondo giro breve
  // recupera eventuali ritardatari invece di lasciarli persi in silenzio.
  const straggler = await batchItemsSnapshot(batchId, companyId) || [];
  const stragglerSum = summarize(straggler);
  if (stragglerSum.greenCount > 0) {
    const second = await pipeline.confirmAllGreen(batchId, companyId, userId, req);
    return { confirmed: [...first.confirmed, ...second.confirmed], failed: [...first.failed, ...second.failed] };
  }
  return first;
}

module.exports = { startImportFromChatUpload, confirmHighConfidenceBatch };
