'use strict';
/**
 * services/chatDocumentAnalysis.js
 * Analisi e archiviazione di un file caricato in chat_uploads — logica
 * condivisa tra i tool agentic di Ladia (read_uploaded_document /
 * archive_document in routes/v1/chat.js) e l'importazione massiva da zip
 * (routes/v1/chatBulkImport.js). Stessa AI, stessa struttura dati, stesso
 * comportamento — un solo posto da mantenere.
 */

const crypto   = require('crypto');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../lib/supabase');
const { logUsage } = require('../lib/ladiaUsageLog');
const { auditLog }  = require('../lib/audit');

const BUCKET = 'site-documents';

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const ANALYSIS_SYSTEM_PROMPT = `Analizza il documento allegato e rispondi SOLO con JSON valido (niente markdown):
{
  "doc_type": "idoneita_medica|attestato_formazione|durc|visura|assicurazione|dvr|pos|psc|capitolato|contratto|busta_paga|f24|iso|soa|permesso|patente|altro",
  "destination": "site_documents|company_documents|worker_documents|worker_certificates",
  "name": "nome breve descrittivo max 80 car",
  "expiry_date": "YYYY-MM-DD oppure null",
  "issue_date": "YYYY-MM-DD oppure null",
  "worker_name": "nome cognome lavoratore oppure null",
  "worker_cf": "codice fiscale maiuscolo oppure null",
  "issuing_body": "ente emittente oppure null",
  "cantiere_hint": "nome cantiere se menzionato oppure null",
  "category": "categoria per la tabella oppure null",
  "summary": "max 2 righe descrizione"
}`;

/**
 * Scarica un chat_upload, lo manda a Claude Vision, restituisce l'analisi
 * strutturata. Non tocca il DB (nessuna scrittura) — sola lettura + AI.
 */
async function analyzeChatUpload({ uploadId, companyId, userId, conversationId = null }) {
  const { data: upload } = await supabase
    .from('chat_uploads')
    .select('id, original_name, mime_type, storage_path, size_bytes')
    .eq('id', uploadId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!upload) return { error: 'File non trovato o accesso negato.' };

  const { data: signed } = await supabase.storage
    .from(BUCKET).createSignedUrl(upload.storage_path, 90);
  if (!signed?.signedUrl) return { error: 'Impossibile accedere al file.' };

  const fileResp = await fetch(signed.signedUrl);
  if (!fileResp.ok) return { error: 'Download file fallito.' };
  const buf   = Buffer.from(await fileResp.arrayBuffer());
  const b64   = buf.toString('base64');
  const isImg = upload.mime_type.startsWith('image/');
  const isPdf = upload.mime_type === 'application/pdf';

  if (!isImg && !isPdf) {
    return {
      upload_id: uploadId,
      nome_file: upload.original_name,
      tipo_mime: upload.mime_type,
      non_analizzabile: true,
      nota: 'Documento Office: non è possibile estrarne il testo automaticamente.',
    };
  }

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: upload.mime_type,      data: b64 } };

  const aiClient   = getClient();
  // NOTA: niente più `betas: ['pdfs-2024-09-25']` — quel flag beta è stato
  // promosso a supporto nativo e l'API ora rifiuta la richiesta se lo riceve
  // ("betas: Extra inputs are not permitted"). Trovato con verifica dal vivo
  // 2026-07-19: il PDF via chat falliva silenziosamente da chissà quanto.
  const createOpts = {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:     ANALYSIS_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: 'Analizza.' }] }],
  };

  const aiResp = await aiClient.messages.create(createOpts);
  logUsage({ companyId, userId, conversationId, model: createOpts.model, callSite: 'read_uploaded_document', usage: aiResp.usage });
  const raw = aiResp.content.find(b => b.type === 'text')?.text || '{}';
  let analysis = {};
  try { const m = raw.match(/\{[\s\S]*\}/); if (m) analysis = JSON.parse(m[0]); } catch { /* risposta parziale/non-JSON */ }

  return { upload_id: uploadId, nome_file: upload.original_name, size_bytes: upload.size_bytes, ...analysis };
}

/**
 * Archivia definitivamente un chat_upload già analizzato (site_id/worker_id
 * già risolti dal chiamante). Sposta il file nel path permanente, crea il
 * record nella tabella di destinazione, marca l'upload come archiviato.
 */
async function archiveChatUpload({
  uploadId, companyId, userId,
  destination, name, siteId, workerId,
  category, expiryDate, issueDate, issuingBody, courseTypeId,
  contentHash = null,
  req = null,
}) {
  const { data: upload } = await supabase
    .from('chat_uploads')
    .select('id, original_name, mime_type, storage_path, size_bytes, archived')
    .eq('id', uploadId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!upload)         return { error: 'File non trovato o accesso negato.' };
  if (upload.archived) return { error: 'Questo file è già stato archiviato.' };

  const validDests = ['site_documents', 'company_documents', 'worker_documents', 'worker_certificates'];
  if (!validDests.includes(destination)) return { error: 'destination non valida: ' + destination };
  if (destination === 'site_documents' && !siteId)
    return { error: 'site_id obbligatorio per site_documents.' };
  if ((destination === 'worker_documents' || destination === 'worker_certificates') && !workerId)
    return { error: 'worker_id obbligatorio per ' + destination + '.' };

  const ext    = path.extname(upload.original_name) || '';
  const safeFn = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) + ext;
  const newId  = crypto.randomUUID();

  const permanentPath =
    destination === 'site_documents'    ? `${companyId}/${siteId}/${newId}-${safeFn}` :
    destination === 'company_documents' ? `${companyId}/company/${newId}-${safeFn}` :
    destination === 'worker_documents'  ? `${companyId}/${workerId}/${newId}-${safeFn}` :
    /* worker_certificates */             `${companyId}/${workerId}/certs/${newId}-${safeFn}`;

  const { data: signedTmp } = await supabase.storage
    .from(BUCKET).createSignedUrl(upload.storage_path, 120);
  if (!signedTmp?.signedUrl) return { error: 'Impossibile accedere al file temporaneo.' };

  const dlResp = await fetch(signedTmp.signedUrl);
  if (!dlResp.ok) return { error: 'Download file temporaneo fallito.' };
  const fileBuf = Buffer.from(await dlResp.arrayBuffer());

  const { error: storErr } = await supabase.storage
    .from(BUCKET)
    .upload(permanentPath, fileBuf, { contentType: upload.mime_type, upsert: false });
  if (storErr) return { error: 'Upload permanente fallito: ' + storErr.message };

  let docId, insertErr;

  if (destination === 'site_documents') {
    const { data: d, error: e } = await supabase.from('site_documents').insert({
      company_id: companyId, site_id: siteId, name,
      category:  category || 'altro',
      file_path: permanentPath, mime_type: upload.mime_type, file_size: upload.size_bytes,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'company_documents') {
    const { data: d, error: e } = await supabase.from('company_documents').insert({
      company_id: companyId, name,
      category:       category || 'altro',
      file_path:      permanentPath, mime_type: upload.mime_type, file_size: upload.size_bytes,
      ai_expiry_date: expiryDate || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'worker_documents') {
    const { data: d, error: e } = await supabase.from('worker_documents').insert({
      company_id: companyId, worker_id: workerId, name,
      doc_type:    category || 'altro',
      file_path:   permanentPath, mime_type: upload.mime_type, file_size: upload.size_bytes,
      expiry_date: expiryDate || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'worker_certificates') {
    const { data: longSgn } = await supabase.storage
      .from(BUCKET).createSignedUrl(permanentPath, 31536000);
    const { data: d, error: e } = await supabase.from('worker_certificates').insert({
      company_id:     companyId, worker_id: workerId,
      pdf_url:        longSgn?.signedUrl || permanentPath,
      expiry_date:    expiryDate  || null,
      issue_date:     issueDate   || null,
      issuing_body:   issuingBody || null,
      course_type_id: courseTypeId || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;
  }

  if (insertErr) {
    supabase.storage.from(BUCKET).remove([permanentPath]).catch(() => {});
    return { error: 'Errore DB: ' + insertErr.message };
  }

  await supabase.from('chat_uploads').update({ archived: true }).eq('id', uploadId);
  supabase.storage.from(BUCKET).remove([upload.storage_path]).catch(() => {});

  await auditLog({ companyId, userId, action: `record.create:${destination}`, targetType: destination, targetId: docId, payload: { name, category, siteId, workerId, expiryDate }, req });

  return {
    success: true, doc_id: docId, destination, name,
    expiry_date: expiryDate || null,
    messaggio: `Documento "${name}" archiviato in ${destination}${expiryDate ? ` — scadenza ${expiryDate}` : ''}.`,
  };
}

module.exports = { analyzeChatUpload, archiveChatUpload };
