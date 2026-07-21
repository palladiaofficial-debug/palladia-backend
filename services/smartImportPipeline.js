'use strict';
/**
 * services/smartImportPipeline.js
 * Orchestrazione dell'Importazione Intelligente. Riusa:
 *  - lib/zipIngest.js         per lo spacchettamento zip (stessa logica del flusso chat)
 *  - services/smartImportAI.js per classificazione + estrazione con confidence
 *  - lib/entityMatch.js       per il matching CF/indirizzo
 *  - services/chatDocumentAnalysis.js:archiveChatUpload per la scrittura finale in produzione
 *
 * Nessuna scrittura in produzione finché l'utente non conferma un item o
 * un'entità proposta — tutto vive in import_batches/import_items/import_staged_entities
 * fino a quel momento.
 */

const crypto = require('crypto');
const path = require('path');
const supabase = require('../lib/supabase');
const { safeName, mimeForName, readZipEntries } = require('../lib/zipIngest');
const { inspectPdf, extractPdfPages } = require('../lib/pdfSplit');
const { classifySegments, extractFields } = require('./smartImportAI');
const { matchWorker, matchSite } = require('../lib/entityMatch');
const { archiveChatUpload } = require('./chatDocumentAnalysis');
const { checkAiBudget } = require('../lib/ladiaUsageLog');
const { auditLog } = require('../lib/audit');

const BUCKET = 'site-documents';
const CONCURRENCY = 3;
const MAX_BATCH_ITEMS = 500;
const PROCESSING_STUCK_MINUTES = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function downloadUploadBuffer(storagePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw new Error(`Storage download error: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function storeStagingFile({ companyId, userId, batchId, filename, mimeType, buffer }) {
  const fileId = crypto.randomUUID();
  const storagePath = `${companyId}/chat-uploads/${fileId}-${safeName(filename)}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`Upload staging fallito: ${error.message}`);

  const { data: row, error: dbErr } = await supabase
    .from('chat_uploads')
    .insert({
      company_id: companyId, user_id: userId, original_name: filename,
      mime_type: mimeType, storage_path: storagePath, size_bytes: buffer.length,
      import_batch_id: batchId, content_hash: sha256(buffer),
    })
    .select('id')
    .single();
  if (dbErr) {
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(`DB insert chat_uploads fallito: ${dbErr.message}`);
  }
  return row.id;
}

// ── Ingestione ───────────────────────────────────────────────────────────────
// Divisa in due fasi: (1) sincrona e veloce — parsing zip/filtri, crea il
// batch con il conteggio già noto, così il chiamante HTTP può rispondere
// subito (feedback visivo entro 2s dal caricamento); (2) in background —
// upload di ogni file su Storage (I/O di rete, può richiedere secondi per
// file su un archivio da centinaia di MB) + avvio dell'elaborazione AI.
// Il chiamante fa polling su GET /smart-import/batches/:id per il progresso.

/**
 * entries: [{ name, buffer, mime }] — già filtrate (tipo supportato, non vuote).
 * Crea SOLO la riga batch con il conteggio finale noto. Non tocca Storage.
 */
async function createBatchRow({ companyId, userId, source, entries }) {
  const usable = entries.slice(0, MAX_BATCH_ITEMS);
  const overflow = entries.slice(MAX_BATCH_ITEMS).map(e => ({ name: e.name, reason: `Limite di ${MAX_BATCH_ITEMS} file per importazione superato — dividi in più batch.` }));
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({ company_id: companyId, user_id: userId, source, status: 'uploading', total_files: usable.length })
    .select('id')
    .single();
  if (batchErr) throw new Error('Creazione batch fallita: ' + batchErr.message);
  return { batchId: batch.id, usable, overflow };
}

/**
 * Fase 2, in background (non awaited dal chiamante HTTP): carica ogni entry
 * su Storage, crea l'import_item in coda, poi avvia processBatch.
 */
async function ingestAndProcess(batchId, companyId, userId, entries) {
  let uploadedCount = 0;
  const skipped = [];

  for (const entry of entries) {
    try {
      const uploadId = await storeStagingFile({
        companyId, userId, batchId, filename: entry.name, mimeType: entry.mime, buffer: entry.buffer,
      });
      const { error: itemErr } = await supabase
        .from('import_items')
        .insert({
          batch_id: batchId, chat_upload_id: uploadId,
          original_name: entry.name, content_hash: sha256(entry.buffer),
          status: 'queued',
        });
      if (itemErr) throw new Error(itemErr.message);
      uploadedCount++;
    } catch (err) {
      console.error('[smartImportPipeline] ingest entry fallita:', entry.name, err.message);
      skipped.push({ name: entry.name, reason: err.message });
    }
  }

  if (skipped.length > 0) {
    await Promise.resolve(supabase.rpc('increment_import_batch_total', { p_batch_id: batchId, p_delta: -skipped.length })).catch(() => {});
  }

  if (uploadedCount === 0) {
    await supabase.from('import_batches').update({ status: 'cancelled' }).eq('id', batchId);
    return;
  }

  await processBatch(batchId);
}

/**
 * Parsing sincrono (veloce: solo TOC + decompressione in memoria, nessuna
 * rete) + creazione batch. L'upload su Storage e l'AI partono in background.
 */
async function createBatchFromZip({ companyId, userId, zipBuffer }) {
  const entries = readZipEntries(zipBuffer); // lancia se corrotto
  const usableEntries = [];
  const skipped = [];
  for (const e of entries) {
    const mime = mimeForName(e.entryName);
    if (!mime) { skipped.push({ name: e.entryName, reason: 'Tipo file non supportato' }); continue; }
    const buffer = e.getData();
    if (buffer.length === 0) { skipped.push({ name: e.entryName, reason: 'File vuoto' }); continue; }
    usableEntries.push({ name: path.basename(e.entryName), buffer, mime });
  }

  if (usableEntries.length === 0) return { batchId: null, total: 0, skipped, empty: true };

  const { batchId, usable, overflow } = await createBatchRow({ companyId, userId, source: 'zip', entries: usableEntries });
  ingestAndProcess(batchId, companyId, userId, usable).catch(err => console.error('[smartImportPipeline] ingest fallito:', batchId, err.message));
  return { batchId, total: usable.length, skipped: [...skipped, ...overflow], empty: false };
}

async function createBatchFromFiles({ companyId, userId, files }) {
  const usableEntries = [];
  const skipped = [];
  for (const f of files) {
    const mime = mimeForName(f.originalname) || (f.mimetype && f.mimetype !== 'application/octet-stream' ? f.mimetype : null);
    if (!mime) { skipped.push({ name: f.originalname, reason: 'Tipo file non supportato' }); continue; }
    if (f.buffer.length === 0) { skipped.push({ name: f.originalname, reason: 'File vuoto' }); continue; }
    usableEntries.push({ name: f.originalname, buffer: f.buffer, mime });
  }

  if (usableEntries.length === 0) return { batchId: null, total: 0, skipped, empty: true };

  const { batchId, usable, overflow } = await createBatchRow({ companyId, userId, source: 'folder', entries: usableEntries });
  ingestAndProcess(batchId, companyId, userId, usable).catch(err => console.error('[smartImportPipeline] ingest fallito:', batchId, err.message));
  return { batchId, total: usable.length, skipped: [...skipped, ...overflow], empty: false };
}

// ── Dedup ────────────────────────────────────────────────────────────────────

const HASH_TABLES = ['site_documents', 'company_documents', 'worker_documents', 'worker_certificates'];

async function findProductionDuplicate(companyId, hash) {
  for (const table of HASH_TABLES) {
    const { data } = await supabase
      .from(table).select('id').eq('company_id', companyId).eq('content_hash', hash).limit(1).maybeSingle();
    if (data) return { table, id: data.id };
  }
  return null;
}

async function findBatchDuplicate(batchId, itemId, hash) {
  const { data } = await supabase
    .from('import_items')
    .select('id')
    .eq('batch_id', batchId)
    .eq('content_hash', hash)
    .neq('id', itemId)
    .in('status', ['pending_review', 'confirmed'])
    .limit(1)
    .maybeSingle();
  return data ? { table: 'import_items', id: data.id } : null;
}

// ── Staged entity dedup/upsert ────────────────────────────────────────────────

function normKey(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function upsertStagedEntity(batchId, entityType, matchKey, extractedData) {
  const { data, error } = await supabase
    .from('import_staged_entities')
    .upsert(
      { batch_id: batchId, entity_type: entityType, match_key: matchKey, extracted_data: extractedData },
      { onConflict: 'batch_id,entity_type,match_key', ignoreDuplicates: false },
    )
    .select('id')
    .single();
  if (error) throw new Error('Staged entity upsert fallito: ' + error.message);
  return data.id;
}

// ── Elaborazione di un singolo item ───────────────────────────────────────────

async function processOneItem(item, ctx) {
  await supabase.from('import_items').update({ status: 'processing' }).eq('id', item.id);

  try {
    const { data: upload } = await supabase
      .from('chat_uploads').select('id, storage_path, mime_type, original_name')
      .eq('id', item.chat_upload_id).maybeSingle();
    if (!upload) throw new Error('File di origine non trovato.');

    const buffer = await downloadUploadBuffer(upload.storage_path);
    const hash = item.content_hash || sha256(buffer);

    const dup = (await findProductionDuplicate(ctx.companyId, hash)) || (await findBatchDuplicate(item.batch_id, item.id, hash));
    if (dup) {
      await supabase.from('import_items').update({
        status: 'duplicate', duplicate_of_table: dup.table, duplicate_of_document_id: dup.id, content_hash: hash,
      }).eq('id', item.id);
      return;
    }

    const isPdf = upload.mime_type === 'application/pdf';
    const isImage = upload.mime_type?.startsWith('image/');
    const isOffice = !isPdf && !isImage;

    if (isOffice) {
      await supabase.from('import_items').update({
        status: 'pending_review', content_hash: hash,
        error_message: 'Documento Office: non è possibile estrarne il testo automaticamente — carica singolarmente in chat, oppure vai su Documenti.',
      }).eq('id', item.id);
      return;
    }

    if (isPdf) {
      const inspection = await inspectPdf(buffer);
      if (!inspection.ok) {
        await supabase.from('import_items').update({
          status: 'error', content_hash: hash, error_message: 'File PDF corrotto o illeggibile.',
        }).eq('id', item.id);
        return;
      }
      if (inspection.encrypted) {
        await supabase.from('import_items').update({
          status: 'error', content_hash: hash,
          error_message: 'PDF protetto da password — rimuovi la protezione e ricarica questo file.',
        }).eq('id', item.id);
        return;
      }
    }

    const { segments } = await classifySegments({ buffer, mimeType: upload.mime_type, companyId: ctx.companyId, userId: ctx.userId });
    const realSegments = isPdf && segments.length > 1 ? segments : [segments[0]];

    if (isPdf && realSegments.length > 1) {
      // PDF con più documenti scansionati insieme: spacchetta in item figli,
      // ognuno rielaborato indipendentemente dal loop principale.
      let added = 0;
      for (const seg of realSegments) {
        try {
          const endPage = seg.end_page || seg.start_page;
          const segBuffer = await extractPdfPages(buffer, seg.start_page, endPage);
          const childName = `${upload.original_name} (pag. ${seg.start_page}-${endPage})`;
          const childUploadId = await storeStagingFile({
            companyId: ctx.companyId, userId: ctx.userId, batchId: item.batch_id, filename: childName,
            mimeType: 'application/pdf', buffer: segBuffer,
          });
          await supabase.from('import_items').insert({
            batch_id: item.batch_id, chat_upload_id: childUploadId, parent_item_id: item.id,
            page_start: seg.start_page, page_end: endPage, original_name: childName,
            content_hash: sha256(segBuffer), doc_type: seg.doc_type, destination: seg.destination,
            status: 'queued',
          });
          added++;
        } catch (segErr) {
          console.error('[smartImportPipeline] split segmento fallito:', segErr.message);
        }
      }
      await supabase.from('import_items').update({ status: 'needs_split', content_hash: hash }).eq('id', item.id);
      if (added > 0) {
        await Promise.resolve(supabase.rpc('increment_import_batch_total', { p_batch_id: item.batch_id, p_delta: added })).catch(async () => {
          // Fallback se la RPC non esiste: letto+scritto (piccola finestra di race, accettabile per un contatore di progress bar)
          const { data: b } = await supabase.from('import_batches').select('total_files').eq('id', item.batch_id).single();
          if (b) await supabase.from('import_batches').update({ total_files: b.total_files + added }).eq('id', item.batch_id);
        });
      }
      return;
    }

    const seg = realSegments[0];
    const docType = seg.doc_type || 'altro';
    const destination = seg.destination || 'company_documents';

    if (docType === 'altro' || seg.confidence < 0.15) {
      await supabase.from('import_items').update({
        status: 'pending_review', content_hash: hash, doc_type: docType, destination,
        overall_confidence: seg.confidence || 0,
        error_message: 'Tipo documento non riconosciuto con certezza.',
      }).eq('id', item.id);
      return;
    }

    const extraction = await extractFields({ buffer, mimeType: upload.mime_type, destination, companyId: ctx.companyId, userId: ctx.userId });
    const fields = extraction?.extractedFields || {};
    // Media solo sui campi che il documento contiene davvero (value non-null) —
    // un campo assente per natura (es. CF non stampato su un attestato) non è
    // "incertezza AI" e non deve trascinare giù la confidenza degli altri campi
    // letti perfettamente. Se sono tutti null, ripiega sulla confidenza di classificazione.
    const confValues = Object.values(fields).filter(f => f.value !== null && f.value !== undefined).map(f => f.confidence).filter(v => typeof v === 'number');
    const overallConfidence = confValues.length ? confValues.reduce((a, b) => a + b, 0) / confValues.length : (seg.confidence || 0);

    let matchedWorkerId = null, matchedSiteId = null, workerScore = null, siteScore = null;
    let stagedWorkerId = null, stagedSiteId = null;

    if (destination === 'worker_documents' || destination === 'worker_certificates') {
      const extractedName = fields.issued_to?.value;
      const extractedCf = fields.fiscal_code?.value;
      const m = matchWorker({ name: extractedName, fiscal_code: extractedCf }, ctx.workerCandidates);
      if (m) { matchedWorkerId = m.id; workerScore = m.score; }
      else if (extractedName || extractedCf) {
        const matchKey = normKey(extractedCf) || normKey(extractedName);
        stagedWorkerId = await upsertStagedEntity(item.batch_id, 'worker', matchKey, {
          full_name: extractedName || null, fiscal_code: extractedCf || null,
        });
      }
    } else if (destination === 'site_documents') {
      const hint = extraction?.siteHint;
      const m = hint ? matchSite({ name: hint, address: hint }, ctx.siteCandidates) : null;
      if (m) { matchedSiteId = m.id; siteScore = m.score; }
      else if (hint) {
        stagedSiteId = await upsertStagedEntity(item.batch_id, 'site', normKey(hint), { name: hint, address: hint });
      }
    }

    await supabase.from('import_items').update({
      status: 'pending_review', content_hash: hash, doc_type: docType, destination,
      extracted_fields: fields, overall_confidence: overallConfidence,
      matched_worker_id: matchedWorkerId, matched_site_id: matchedSiteId,
      worker_match_score: workerScore, site_match_score: siteScore,
      staged_worker_id: stagedWorkerId, staged_site_id: stagedSiteId,
    }).eq('id', item.id);
  } catch (err) {
    console.error('[smartImportPipeline] item fallito:', item.id, err.message);
    await supabase.from('import_items').update({ status: 'error', error_message: err.message }).eq('id', item.id);
  } finally {
    await Promise.resolve(supabase.rpc('increment_import_batch_processed', { p_batch_id: item.batch_id })).catch(async () => {
      const { data: b } = await supabase.from('import_batches').select('processed_files').eq('id', item.batch_id).single();
      if (b) await supabase.from('import_batches').update({ processed_files: b.processed_files + 1 }).eq('id', item.batch_id);
    });
  }
}

// ── Loop principale del batch ─────────────────────────────────────────────────

/**
 * Processa tutti gli import_items in stato 'queued' del batch, a blocchi di
 * CONCURRENCY. Va avanti finché non ne restano più — inclusi quelli creati
 * a runtime dallo split dei PDF multi-documento. Fire-and-forget: chiamata
 * dopo la creazione del batch, e dal recovery job all'avvio del processo.
 */
async function processBatch(batchId) {
  const { data: batch } = await supabase.from('import_batches').select('*').eq('id', batchId).maybeSingle();
  if (!batch || !['uploading', 'queued', 'processing'].includes(batch.status)) return;

  const budget = await checkAiBudget(batch.company_id);
  if (!budget.allowed) {
    await supabase.from('import_batches').update({ status: 'review' }).eq('id', batchId);
    await supabase.from('import_items').update({
      status: 'error', error_message: `Budget AI mensile superato ($${budget.spend?.toFixed(2)} su $${budget.limit}).`,
    }).eq('batch_id', batchId).eq('status', 'queued');
    return;
  }

  await supabase.from('import_batches').update({ status: 'processing' }).eq('id', batchId);

  const [{ data: workers }, { data: sites }] = await Promise.all([
    supabase.from('workers').select('id, full_name, fiscal_code').eq('company_id', batch.company_id).eq('is_active', true),
    supabase.from('sites').select('id, name, address').eq('company_id', batch.company_id).neq('status', 'chiuso'),
  ]);
  const ctx = { companyId: batch.company_id, userId: batch.user_id, workerCandidates: workers || [], siteCandidates: sites || [] };

  // Ciclo finché ci sono item in coda — gestisce anche i figli creati dallo split.
  for (;;) {
    const { data: pending } = await supabase
      .from('import_items').select('*').eq('batch_id', batchId).eq('status', 'queued').limit(CONCURRENCY);
    if (!pending || pending.length === 0) break;
    await Promise.all(pending.map(item => processOneItem(item, ctx)));
  }

  await supabase.from('import_batches').update({ status: 'review' }).eq('id', batchId);
}

// ── Recovery: item rimasti 'processing' per un crash/riavvio ────────────────

async function reclaimStuckItems() {
  const cutoff = new Date(Date.now() - PROCESSING_STUCK_MINUTES * 60000).toISOString();
  const { data: stuck } = await supabase
    .from('import_items').select('id, batch_id').eq('status', 'processing').lt('updated_at', cutoff);
  if (!stuck || stuck.length === 0) return;

  await supabase.from('import_items').update({ status: 'queued' }).in('id', stuck.map(s => s.id));
  const batchIds = [...new Set(stuck.map(s => s.batch_id))];
  for (const id of batchIds) processBatch(id).catch(err => console.error('[smartImportPipeline] recovery fallito:', id, err.message));
}

// ── Conferma / rifiuto item ───────────────────────────────────────────────────

async function confirmStagedEntity(stagedEntityId, companyId, overrides = {}) {
  const { data: staged } = await supabase
    .from('import_staged_entities').select('*, import_batches!inner(company_id)')
    .eq('id', stagedEntityId).maybeSingle();
  if (!staged || staged.import_batches.company_id !== companyId) throw new Error('Entità non trovata.');
  if (staged.status === 'confirmed' && staged.created_entity_id) return staged.created_entity_id;

  const data = { ...staged.extracted_data, ...overrides };

  if (staged.entity_type === 'worker') {
    const fullName = (data.full_name || '').trim();
    const fiscalCode = (data.fiscal_code || '').toUpperCase().trim();
    if (fullName.length < 2) throw new Error('Nome lavoratore mancante o troppo corto.');
    if (!/^[A-Z0-9]{16}$/.test(fiscalCode)) throw new Error('Codice fiscale mancante o non valido — completalo prima di creare il lavoratore.');
    const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
    const { data: worker, error } = await supabase.from('workers').insert({
      company_id: companyId, full_name: fullName, fiscal_code: fiscalCode, badge_code: badgeCode,
    }).select('id').single();
    if (error) throw new Error('Creazione lavoratore fallita: ' + error.message);
    await supabase.from('import_staged_entities').update({ status: 'confirmed', created_entity_id: worker.id }).eq('id', stagedEntityId);
    return worker.id;
  }

  if (staged.entity_type === 'site') {
    const name = (data.name || '').trim();
    const address = (data.address || data.name || '').trim();
    if (name.length < 2) throw new Error('Nome cantiere mancante o troppo corto.');
    const { data: site, error } = await supabase.from('sites').insert({
      company_id: companyId, name, address, status: 'attivo',
    }).select('id').single();
    if (error) throw new Error('Creazione cantiere fallita: ' + error.message);
    await supabase.from('import_staged_entities').update({ status: 'confirmed', created_entity_id: site.id }).eq('id', stagedEntityId);
    return site.id;
  }

  throw new Error('Tipo entità sconosciuto: ' + staged.entity_type);
}

async function confirmItem(itemId, companyId, userId, req = null) {
  const { data: item } = await supabase
    .from('import_items').select('*, import_batches!inner(company_id)')
    .eq('id', itemId).maybeSingle();
  if (!item || item.import_batches.company_id !== companyId) throw new Error('Documento non trovato.');
  if (item.status !== 'pending_review') throw new Error('Questo documento non è in stato revisionabile.');

  let workerId = item.matched_worker_id;
  let siteId = item.matched_site_id;
  if (!workerId && item.staged_worker_id) workerId = await confirmStagedEntity(item.staged_worker_id, companyId);
  if (!siteId && item.staged_site_id) siteId = await confirmStagedEntity(item.staged_site_id, companyId);

  const fields = item.extracted_fields || {};
  const name = fields.issued_to?.value || fields.doc_type_detected?.value || item.doc_type || item.original_name;
  const expiryDate = fields.expiry_date?.value || null;
  const issuingBody = fields.issued_by?.value || null;
  const issueDate = fields.issue_date?.value || null;

  // worker_certificates.issue_date è NOT NULL — se non siamo riusciti a
  // calcolarla (nessuna scadenza o nessun periodo di rinnovo noto), l'unica
  // scrittura sicura è nella tabella generica worker_documents (issued_date
  // nullable), invece di far fallire la conferma con un errore SQL grezzo.
  const destination = (item.destination === 'worker_certificates' && !issueDate) ? 'worker_documents' : item.destination;

  const result = await archiveChatUpload({
    uploadId: item.chat_upload_id, companyId, userId,
    destination, name, siteId, workerId,
    category: sanitizeCategory(destination, item.doc_type), expiryDate, issueDate, issuingBody,
    contentHash: item.content_hash, req,
  });
  if (result?.error) throw new Error(result.error);

  await supabase.from('import_items').update({ status: 'confirmed' }).eq('id', itemId);
  return result;
}

async function rejectItem(itemId, companyId) {
  const { data: item } = await supabase
    .from('import_items').select('id, import_batches!inner(company_id)')
    .eq('id', itemId).maybeSingle();
  if (!item || item.import_batches.company_id !== companyId) throw new Error('Documento non trovato.');
  await supabase.from('import_items').update({ status: 'rejected' }).eq('id', itemId);
}

// CHECK constraint reali (verificate sul DB) — più stretti dell'enum doc_type
// della classificazione (che include anche tipi lavoratore come idoneita_medica,
// attestato_formazione, patente, ecc). Se il tipo rilevato non è ammesso per
// quella tabella, ripiega su 'altro' invece di far fallire l'insert con un
// errore SQL grezzo in faccia all'utente in fase di conferma.
const CATEGORY_ALLOWLIST = {
  site_documents:    new Set(['pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'altro']),
  company_documents: new Set(['rspp', 'rls', 'medico_competente', 'visite_mediche', 'primo_soccorso', 'emergenze', 'preposto', 'dvr', 'duvri', 'formazione', 'durc', 'visura', 'iso', 'soa', 'assicurazione', 'polizza', 'f24', 'altro']),
};

function sanitizeCategory(destination, docType) {
  const allowed = CATEGORY_ALLOWLIST[destination];
  if (!allowed) return docType || 'altro'; // worker_documents/worker_certificates: doc_type libero, nessun CHECK
  return allowed.has(docType) ? docType : 'altro';
}

const GREEN_THRESHOLD = 0.85;

async function confirmAllGreen(batchId, companyId, userId, req = null) {
  const { data: items } = await supabase
    .from('import_items')
    .select('id, overall_confidence, import_batches!inner(company_id)')
    .eq('batch_id', batchId).eq('status', 'pending_review').gte('overall_confidence', GREEN_THRESHOLD);
  const confirmed = [];
  const failed = [];
  for (const it of (items || [])) {
    if (it.import_batches.company_id !== companyId) continue;
    try { await confirmItem(it.id, companyId, userId, req); confirmed.push(it.id); }
    catch (err) { failed.push({ id: it.id, error: err.message }); }
  }
  return { confirmed, failed };
}

// ── Chiusura del batch — momento wow ──────────────────────────────────────────

async function finishBatch(batchId, companyId) {
  const { data: batch } = await supabase.from('import_batches').select('*').eq('id', batchId).maybeSingle();
  if (!batch || batch.company_id !== companyId) throw new Error('Batch non trovato.');

  const { data: confirmedItems } = await supabase
    .from('import_items').select('destination, matched_worker_id, matched_site_id, staged_worker_id, staged_site_id')
    .eq('batch_id', batchId).eq('status', 'confirmed');

  const { data: workersCreated } = await supabase
    .from('import_staged_entities').select('id').eq('batch_id', batchId).eq('entity_type', 'worker').eq('status', 'confirmed');
  const { data: sitesCreated } = await supabase
    .from('import_staged_entities').select('id').eq('batch_id', batchId).eq('entity_type', 'site').eq('status', 'confirmed');

  const in60Days = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  // site_documents/company_documents non hanno una colonna "expiry_date" —
  // solo "ai_expiry_date" (popolata dall'analisi AI, vedi services/documentAI.js).
  // worker_documents/worker_certificates usano invece "expiry_date" diretta.
  const EXPIRY_COLUMN_BY_TABLE = {
    worker_documents: 'expiry_date', worker_certificates: 'expiry_date',
    site_documents: 'ai_expiry_date', company_documents: 'ai_expiry_date',
  };
  let expiringCount = 0;
  for (const [table, col] of Object.entries(EXPIRY_COLUMN_BY_TABLE)) {
    const { count, error } = await supabase
      .from(table).select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).gte(col, today).lte(col, in60Days);
    if (error) { console.error('[smartImportPipeline] conteggio scadenze fallito:', table, error.message); continue; }
    expiringCount += count || 0;
  }

  const summary = {
    documents_imported: (confirmedItems || []).length,
    workers_created: (workersCreated || []).length,
    sites_created: (sitesCreated || []).length,
    expiring_60d: expiringCount,
    finished_at: new Date().toISOString(),
  };

  await supabase.from('import_batches').update({ status: 'confirmed', summary }).eq('id', batchId);
  await auditLog({ companyId, action: 'import_batch.confirm', targetType: 'import_batches', targetId: batchId, payload: summary });
  return summary;
}

module.exports = {
  createBatchFromZip, createBatchFromFiles, processBatch, reclaimStuckItems,
  confirmItem, rejectItem, confirmAllGreen, confirmStagedEntity, finishBatch,
  MAX_BATCH_ITEMS,
};
