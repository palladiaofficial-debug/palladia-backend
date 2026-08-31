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
const { logAction } = require('../lib/ladiaActionLog');
const { matchSite, matchEquipment } = require('../lib/entityMatch');
const { sanitizeCategory } = require('../lib/documentCategory');
const { syncWorkerExpiry } = require('../lib/workerDocSync');
const { syncToFormazione } = require('./documentAI');

const BUCKET = 'site-documents';
const EQUIPMENT_BUCKET = 'equipment-docs';

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const ANALYSIS_SYSTEM_PROMPT = `Analizza il documento allegato e rispondi SOLO con JSON valido (niente markdown):
{
  "doc_type": "idoneita_medica|attestato_formazione|durc|visura|assicurazione|dvr|pos|psc|capitolato|contratto|busta_paga|f24|iso|soa|permesso|patente|libretto_circolazione|assicurazione_mezzo|revisione_mezzo|altro",
  "destination": "site_documents|company_documents|worker_documents|worker_certificates|equipment_documents",
  "name": "nome breve descrittivo max 80 car",
  "expiry_date": "YYYY-MM-DD oppure null",
  "issue_date": "YYYY-MM-DD oppure null",
  "worker_name": "nome cognome lavoratore oppure null",
  "worker_cf": "codice fiscale maiuscolo oppure null",
  "issuing_body": "ente emittente oppure null",
  "cantiere_hint": "nome cantiere se menzionato oppure null",
  "vehicle_plate": "targa o numero di telaio/matricola del mezzo, se il documento riguarda un veicolo/mezzo — altrimenti null",
  "vehicle_hint": "marca/modello o nome del mezzo se la targa non è leggibile — altrimenti null",
  "category": "categoria per la tabella oppure null",
  "summary": "max 2 righe descrizione"
}
Un libretto di circolazione, un'assicurazione o una revisione di un veicolo/mezzo (non un lavoratore) vanno SEMPRE con destination="equipment_documents", mai company_documents.`;

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
  destination, name, siteId, workerId, equipmentId,
  category, expiryDate, issueDate, issuingBody, courseTypeId,
  periodYear = null, periodMonth = null,
  contentHash = null,
  siteHint = null,
  equipmentHint = null,
  req = null,
  conversationId = null,
}) {
  const { data: upload } = await supabase
    .from('chat_uploads')
    .select('id, original_name, mime_type, storage_path, size_bytes, archived')
    .eq('id', uploadId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!upload)         return { error: 'File non trovato o accesso negato.' };
  if (upload.archived) return { error: 'Questo file è già stato archiviato.' };

  const validDests = ['site_documents', 'company_documents', 'worker_documents', 'worker_certificates', 'payslips', 'equipment_documents'];
  if (!validDests.includes(destination)) return { error: 'destination non valida: ' + destination };
  if (destination === 'site_documents' && !siteId)
    return { error: 'site_id obbligatorio per site_documents.' };
  if ((destination === 'worker_documents' || destination === 'worker_certificates' || destination === 'payslips') && !workerId)
    return { error: 'worker_id obbligatorio per ' + destination + '.' };
  if (destination === 'payslips' && (!periodYear || !periodMonth))
    return { error: 'period_year e period_month obbligatori per payslips.' };

  // equipment_documents: risolvi il mezzo per id diretto o per targa/nome
  // (stesso pattern di matchSite sopra) — a differenza del cantiere "extra",
  // qui il mezzo è la destinazione primaria: senza un match non si scrive.
  let resolvedEquipmentId = null;
  if (destination === 'equipment_documents') {
    if (equipmentId) {
      const { data: eqRow } = await supabase.from('equipment').select('id').eq('id', equipmentId).eq('company_id', companyId).maybeSingle();
      resolvedEquipmentId = eqRow?.id || null;
    } else if (equipmentHint) {
      const { data: candidates } = await supabase.from('equipment').select('id, name, type, model, plate_or_serial').eq('company_id', companyId).eq('is_active', true);
      const match = matchEquipment({ plate: equipmentHint, name: equipmentHint }, candidates || []);
      resolvedEquipmentId = match?.id || null;
    }
    if (!resolvedEquipmentId) return { error: 'Mezzo non trovato — indica equipment_id o una targa/nome che corrisponda a un mezzo in Risorse.' };
  }

  // Cartelle Intelligenti (vedi AUDIT.md): oltre alla destinazione primaria,
  // un documento può avere un cantiere "extra" — un attestato di un lavoratore
  // che vive anche nel fascicolo del cantiere dove lavora, un DURC aziendale
  // che serve anche lì. Per site_documents il cantiere È già la destinazione
  // primaria, quindi non c'è nulla da risolvere.
  let extraSiteId = null;
  if (destination !== 'site_documents' && (siteId || siteHint)) {
    if (siteId) {
      const { data: siteRow } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
      if (siteRow) extraSiteId = siteRow.id;
    } else {
      const { data: candidates } = await supabase.from('sites').select('id, name, address').eq('company_id', companyId);
      const match = matchSite({ name: siteHint, address: siteHint }, candidates || []);
      if (match) extraSiteId = match.id;
    }
  }

  const ext    = path.extname(upload.original_name) || '';
  const safeFn = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) + ext;
  const newId  = crypto.randomUUID();
  const safeMo = String(periodMonth).padStart(2, '0');

  const permanentPath =
    destination === 'site_documents'    ? `${companyId}/${siteId}/${newId}-${safeFn}` :
    destination === 'company_documents' ? `${companyId}/company/${newId}-${safeFn}` :
    destination === 'worker_documents'  ? `${companyId}/${workerId}/${newId}-${safeFn}` :
    destination === 'worker_certificates' ? `${companyId}/${workerId}/certs/${newId}-${safeFn}` :
    destination === 'equipment_documents' ? `${companyId}/${resolvedEquipmentId}/${newId}-${safeFn}` :
    /* payslips — stesso percorso deterministico usato dall'upload manuale
       (routes/v1/payslips.js), necessario per l'upsert su company_id+worker_id+
       period_year+period_month: un secondo import per lo stesso periodo deve
       sovrascrivere, non duplicare. */
    `payslips/${companyId}/${workerId}/${periodYear}-${safeMo}.pdf`;

  // equipment_documents vive in un bucket separato (routes/v1/equipment.js),
  // non in quello condiviso dalle altre 4 destinazioni.
  const destBucket = destination === 'equipment_documents' ? EQUIPMENT_BUCKET : BUCKET;

  const { data: signedTmp } = await supabase.storage
    .from(BUCKET).createSignedUrl(upload.storage_path, 120);
  if (!signedTmp?.signedUrl) return { error: 'Impossibile accedere al file temporaneo.' };

  const dlResp = await fetch(signedTmp.signedUrl);
  if (!dlResp.ok) return { error: 'Download file temporaneo fallito.' };
  const fileBuf = Buffer.from(await dlResp.arrayBuffer());

  const { error: storErr } = await supabase.storage
    .from(destBucket)
    // payslips: path deterministico per periodo, un secondo import per lo
    // stesso mese sovrascrive di proposito (stesso comportamento dell'upload
    // manuale in routes/v1/payslips.js). Tutte le altre destinazioni usano un
    // newId univoco nel path, quindi upsert:false resta la scelta sicura.
    .upload(permanentPath, fileBuf, { contentType: upload.mime_type, upsert: destination === 'payslips' });
  if (storErr) return { error: 'Upload permanente fallito: ' + storErr.message };

  let docId, insertErr;

  if (destination === 'site_documents') {
    const { data: d, error: e } = await supabase.from('site_documents').insert({
      company_id: companyId, site_id: siteId, name,
      category:  sanitizeCategory('site_documents', category),
      file_path: permanentPath, mime_type: upload.mime_type, file_size: upload.size_bytes,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'company_documents') {
    const { data: d, error: e } = await supabase.from('company_documents').insert({
      company_id: companyId, name,
      category:       sanitizeCategory('company_documents', category),
      file_path:      permanentPath, mime_type: upload.mime_type, file_size: upload.size_bytes,
      ai_expiry_date: expiryDate || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'worker_documents') {
    // F-044 (AUDIT.md): worker_documents non ha una colonna file_size (a
    // differenza di site_documents/company_documents) — scriverla faceva
    // fallire silenziosamente OGNI archiviazione verso questa destinazione.
    const { data: d, error: e } = await supabase.from('worker_documents').insert({
      company_id: companyId, worker_id: workerId, name,
      doc_type:    category || 'altro',
      file_path:   permanentPath, mime_type: upload.mime_type,
      expiry_date: expiryDate || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'worker_certificates') {
    const { data: longSgn } = await supabase.storage
      .from(BUCKET).createSignedUrl(permanentPath, 31536000);
    const { data: d, error: e } = await supabase.from('worker_certificates').insert({
      company_id:     companyId, worker_id: workerId,
      // site_id: colonna già esistente su worker_certificates (migrazione 045),
      // finora mai popolata da qui — un attestato può vivere anche nel cantiere
      // dove il lavoratore opera oggi (Cartelle Intelligenti, AUDIT.md).
      site_id:        extraSiteId,
      pdf_url:        longSgn?.signedUrl || permanentPath,
      expiry_date:    expiryDate  || null,
      issue_date:     issueDate   || null,
      issuing_body:   issuingBody || null,
      course_type_id: courseTypeId || null,
      content_hash: contentHash,
    }).select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'payslips') {
    // status:'draft' apposta — anche una busta paga importata in blocco resta
    // invisibile al lavoratore finché l'azienda non la condivide esplicitamente
    // (stesso comportamento dell'upload manuale, mai un auto-share).
    const { data: d, error: e } = await supabase.from('payslips').upsert({
      company_id: companyId, worker_id: workerId, uploaded_by: userId,
      period_year: periodYear, period_month: periodMonth,
      // filename è il nome del FILE (stessa convenzione dell'upload manuale in
      // routes/v1/payslips.js), non il nome del lavoratore — "name" qui sotto
      // resta il nome del lavoratore solo per il riepilogo dell'audit trail.
      filename: upload.original_name, file_path: permanentPath, file_size: upload.size_bytes,
      status: 'draft', content_hash: contentHash,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,worker_id,period_year,period_month', ignoreDuplicates: false })
      .select('id').single();
    docId = d?.id; insertErr = e;

  } else if (destination === 'equipment_documents') {
    // Nessuna colonna expiry_date/content_hash su questa tabella (migrazione
    // 014) — a differenza delle altre 5 destinazioni, la scadenza di un mezzo
    // vive su equipment.insurance_expiry/inspection_date, non sul documento.
    const { data: d, error: e } = await supabase.from('equipment_documents').insert({
      company_id: companyId, equipment_id: resolvedEquipmentId,
      doc_type:  category || 'altro',
      file_name: name, file_url: permanentPath,
      file_size: upload.size_bytes, mime_type: upload.mime_type,
      uploaded_by: userId,
    }).select('id').single();
    docId = d?.id; insertErr = e;
  }

  if (insertErr) {
    supabase.storage.from(destBucket).remove([permanentPath]).catch(() => {});
    return { error: 'Errore DB: ' + insertErr.message };
  }

  await supabase.from('chat_uploads').update({ archived: true }).eq('id', uploadId);
  supabase.storage.from(BUCKET).remove([upload.storage_path]).catch(() => {});

  // F-105 (AUDIT.md): il caricamento manuale (routes/v1/workerDocs.js) risincronizza
  // sempre workers.health_fitness_expiry/safety_training_expiry dopo un idoneità
  // medica o un attestato formazione — questo percorso (archiviazione via chat,
  // tool Ladia archive_document) non lo faceva MAI: il documento finiva nel
  // registro ma lo stato di conformità mostrato in Organico/badge restava quello
  // vecchio, mentre Ladia dichiarava comunque "Fatto" — un falso successo.
  if (destination === 'worker_documents') {
    await syncWorkerExpiry(category || 'altro', workerId, companyId).catch(() => {});

    // Sweep F-105: stesso identico gap, terza istanza — un attestato di
    // formazione (antincendio/primo soccorso/lavori in quota/ponteggi/
    // gruista, oltre a formazione_sicurezza già coperta sopra) archiviato via
    // chat non generava/aggiornava mai la riga worker_certificates
    // corrispondente, a differenza del caricamento manuale (routes/v1/
    // workerDocs.js, stessa chiamata, dati manuali "senza AI" — qui i dati
    // sono quelli già confermati dall'utente nella card di conferma, non
    // diversi in affidabilità). Fire-and-forget come nell'originale: non deve
    // mai far fallire l'archiviazione del documento.
    const { data: longSgn } = await supabase.storage.from(destBucket).createSignedUrl(permanentPath, 31536000);
    syncToFormazione(
      docId, workerId, companyId,
      category || 'altro', name,
      issueDate || null, expiryDate || null,
      null, longSgn?.signedUrl || null,
    ).catch(() => {});
  }

  // Cartelle Intelligenti: worker_certificates ha già scritto site_id sopra —
  // per le altre destinazioni senza colonna site propria (worker_documents,
  // payslips, company_documents) il cantiere extra va in document_extra_homes,
  // agganciato alla riga unificata (documents) appena creata dal trigger di
  // sync (150-158) — best-effort, un fallimento qui non deve mai far fallire
  // l'archiviazione del documento.
  if (extraSiteId && destination !== 'worker_certificates') {
    try {
      const { data: unified } = await supabase
        .from('documents').select('id')
        .eq('source_table', destination).eq('legacy_id', docId).maybeSingle();
      if (unified) {
        await supabase.from('document_extra_homes').upsert({
          document_id: unified.id, folder_type: 'site', folder_key: extraSiteId, added_by: 'ladia',
        }, { onConflict: 'document_id,folder_type,folder_key', ignoreDuplicates: true });
      }
    } catch { /* best-effort — non deve mai bloccare l'archiviazione */ }
  }

  // destination è già il nome della risorsa registrata in ladiaSchemaRegistry.js
  // (site_documents/company_documents/worker_documents/worker_certificates/
  // equipment_documents, tutte bespoke-only con allow:false — l'undo resta
  // non offerto, il file in storage non verrebbe ripulito da un delete
  // generico) — logAction()
  // sostituisce il precedente auditLog() diretto: stesso trail legale, più
  // la riga in ladia_action_history che abilita la card verde di successo.
  const logResult = await logAction({
    companyId, userId, req, conversationId,
    resourceName: destination, action: 'create',
    recordId: docId,
    record: { name, category: category || 'altro', site_id: siteId || null, worker_id: workerId || null, equipment_id: resolvedEquipmentId || null, expiry_date: expiryDate || null },
    auditActionOverride: `record.create:${destination}`,
  });

  return {
    success: true, doc_id: docId, destination, name,
    expiry_date: expiryDate || null,
    messaggio: `Documento "${name}" archiviato in ${destination}${expiryDate ? ` — scadenza ${expiryDate}` : ''}.`,
    ...logResult,
  };
}

module.exports = { analyzeChatUpload, archiveChatUpload };
