'use strict';
/**
 * services/documentAI.js
 * Analisi AI (Claude) per documenti aziendali e documenti lavoratori.
 *
 * Estrae: scadenza, ogni quanti anni si rinnova, ente emittente, nominativo,
 * problemi rilevati, validità, riassunto in linguaggio naturale.
 *
 * Usato da companyDocuments.js e workerDocs.js dopo ogni upload.
 */

const Anthropic          = require('@anthropic-ai/sdk');
const supabase           = require('../lib/supabase');
const { extractPdfText } = require('../lib/pdfExtract');
const { logUsage }       = require('../lib/ladiaUsageLog');

const MODEL_TEXT   = 'claude-haiku-4-5-20251001'; // PDF con testo OCR — veloce, economico
const MODEL_VISION = 'claude-sonnet-4-6';          // PDF scansionati e immagini — visione accurata
const MAX_TOKENS   = 1024;
const BUCKET       = 'site-documents';

// ── Prompt documenti aziendali ────────────────────────────────────────────────

const COMPANY_DOC_PROMPT = `Sei un esperto di sicurezza sul lavoro e documentazione aziendale italiana (D.Lgs. 81/2008).
Analizza il documento e restituisci SOLO un oggetto JSON valido con questa struttura:

{
  "summary": "<2-3 frasi: cosa è, chi l'ha emesso, cosa attesta>",
  "doc_type_detected": "<durc|dvr|duvri|soa|iso|assicurazione|polizza|visura|formazione|rspp|rls|medico_competente|visite_mediche|primo_soccorso|emergenze|preposto|f24|altro>",
  "expiry_date": "<YYYY-MM-DD oppure null solo se impossibile determinare>",
  "renewal_years": <numero intero anni tra un rinnovo e l'altro, null se non applicabile>,
  "issued_by": "<ente o soggetto che ha emesso il documento, null se non leggibile>",
  "issues": ["<eventuale problema: documento scaduto, firma mancante, dati incompleti, ecc.>"],
  "validity_ok": <true se il documento sembra valido e completo, false se ci sono problemi>
}

REGOLA CRITICA PER expiry_date:
Se il documento ha una data di emissione ma NON una scadenza esplicita, e conosci il periodo standard,
CALCOLA la scadenza: expiry_date = data_emissione + renewal_years anni (o mesi per DURC).
Restituisci null SOLO se non riesci a determinare né emissione né scadenza.

Periodi standard: DURC=3 mesi (renewal_years=0, calcola comunque scadenza), DVR=null (nessun limite),
SOA=5 anni, ISO=3 anni, assicurazione=1 anno, polizza=1 anno, visura=nessuna scadenza (null).
Scrivi issues solo se ci sono problemi reali. Output: SOLO JSON grezzo senza markdown.`;

// ── Prompt documenti lavoratori ───────────────────────────────────────────────

const WORKER_DOC_PROMPT = `Sei un esperto di sicurezza sul lavoro italiana (D.Lgs. 81/2008) e certificazioni lavoratori.
Analizza il documento e restituisci SOLO un oggetto JSON valido con questa struttura:

{
  "summary": "<2-3 frasi: cosa attesta, chi riguarda, cosa autorizza>",
  "doc_type_detected": "<idoneita_medica|formazione_sicurezza|primo_soccorso|antincendio|lavori_quota|ponteggi|gruista|pes_pav_pei|rspp|patente_guida|altro>",
  "expiry_date": "<YYYY-MM-DD oppure null solo se impossibile determinare>",
  "renewal_years": <numero intero anni tra un rinnovo e l'altro, null se non applicabile>,
  "issued_to": "<nome e cognome ESATTAMENTE come appare nel documento; null se anche solo una lettera è incerta>",
  "fiscal_code": "<codice fiscale italiano 16 caratteri alfanumerici maiuscoli; null se non leggibile con certezza>",
  "issued_by": "<medico, ente di formazione o soggetto emittente, null se non leggibile>",
  "issues": ["<problema reale: scaduto, firma mancante, nominativo illeggibile, ecc.>"],
  "validity_ok": <true se il documento sembra valido e completo, false se ci sono problemi>
}

━━━ REGOLA ASSOLUTA — issued_to (nome lavoratore) ━━━
Trascrivi il nome LETTERA PER LETTERA esattamente come lo vedi scritto.
NON dedurre, NON completare lettere mancanti, NON normalizzare.
Se qualsiasi lettera del nome è sfocata, coperta, parzialmente visibile o incerta → issued_to: null.
È VIETATO inventare o ipotizzare un nome plausibile: null è sempre preferibile a un nome errato.
Aggiungi in issues: "Nominativo lavoratore non leggibile con certezza" se restituisci null.

━━━ REGOLA CRITICA — expiry_date ━━━
Se il documento ha solo data di emissione (senza scadenza esplicita), calcola:
expiry_date = data_emissione + renewal_years anni.
Esempio: formazione sicurezza emessa 15/03/2020 → renewal_years=5 → expiry_date="2025-03-15".
Restituisci null SOLO se non riesci a leggere né emissione né scadenza.

Periodi di rinnovo standard D.Lgs. 81/2008:
- idoneita_medica: 1 anno (rischio alto) o 2 anni (normale) → usa 1 se non specificato
- formazione_sicurezza: 5 anni
- primo_soccorso: 3 anni
- antincendio: 3 anni (medio/alto rischio), 5 anni (basso rischio)
- lavori_quota: 5 anni
- ponteggi: 4 anni
- gruista: 5 anni
- pes_pav_pei: 3 anni
- rspp: 5 anni
- patente_guida: 10 anni (B normale)

Output: SOLO JSON grezzo senza markdown.`;

// ── Helper: scarica file da Storage ──────────────────────────────────────────

async function downloadFileBuffer(filePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
  if (error) throw new Error(`Storage download error: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Estrae il primo oggetto JSON completo da una stringa (brace-tracking) ──────

function extractFirstJson(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}' && --depth === 0) return str.slice(start, i + 1);
  }
  return null;
}

// ── Analisi Claude ─────────────────────────────────────────────────────────────

async function analyzeDocument(fileBuffer, mimeType, systemPrompt) {
  const client = new Anthropic();

  // Claude supporta PDF nativo e immagini; Word non è supportato come documento nativo
  const isPdf   = mimeType === 'application/pdf';
  const isImage = mimeType?.startsWith('image/');

  if (!isPdf && !isImage) {
    // Word e altri formati: non analizzabili direttamente — ritorna analisi vuota
    return null;
  }

  let model = MODEL_TEXT;
  let messageContent;
  if (isPdf) {
    const { text: pdfText } = await extractPdfText(fileBuffer, { maxPages: 30, minChars: 10 });
    if (pdfText.trim()) {
      model = MODEL_TEXT;
      messageContent = `Testo estratto dal PDF:\n\n${pdfText.slice(0, 15000)}\n\nAnalizza questo documento e restituisci il JSON richiesto.`;
    } else {
      model = MODEL_VISION;
      messageContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
        { type: 'text', text: 'Analizza questo documento e restituisci il JSON richiesto.' },
      ];
    }
  } else {
    model = MODEL_VISION;
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } },
      { type: 'text',  text: 'Analizza questo documento e restituisci il JSON richiesto.' },
    ];
  }

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system:     systemPrompt,
    messages: [{ role: 'user', content: messageContent }],
  });

  const raw = response.content?.[0]?.text || '';
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('Claude non ha restituito un JSON valido');
  return { data: JSON.parse(jsonStr), usage: response.usage, model };
}

// ── Normalizza data ────────────────────────────────────────────────────────────

function normalizeDate(val) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim();
  // Formato ISO già corretto
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return s;
    return null;
  }
  // Formato italiano DD/MM/YYYY o DD-MM-YYYY
  const itMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (itMatch) {
    const iso = `${itMatch[3]}-${itMatch[2].padStart(2,'0')}-${itMatch[1].padStart(2,'0')}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return iso;
  }
  return null;
}

// ── Analisi documento aziendale ────────────────────────────────────────────────

async function analyzeCompanyDoc(docId, filePath, mimeType) {
  try {
    const buffer  = await downloadFileBuffer(filePath);
    const result  = await analyzeDocument(buffer, mimeType, COMPANY_DOC_PROMPT);
    if (!result) return; // formato non analizzabile
    const { data: raw, usage, model } = result;

    const patch = {
      ai_summary:        (raw.summary       || '').slice(0, 2000) || null,
      ai_expiry_date:    normalizeDate(raw.expiry_date),
      ai_renewal_years:  Number.isInteger(raw.renewal_years) ? raw.renewal_years : null,
      ai_issued_by:      (raw.issued_by     || '').slice(0, 500)  || null,
      ai_issues:         Array.isArray(raw.issues) ? raw.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
      ai_validity_ok:    typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
      ai_analyzed_at:    new Date().toISOString(),
    };

    const { data: updated } = await supabase.from('company_documents').update(patch).eq('id', docId).select('company_id').maybeSingle();
    if (updated?.company_id) logUsage({ companyId: updated.company_id, model, callSite: 'company_doc_analysis', usage });
  } catch (err) {
    console.error('[documentAI] company doc analysis failed:', docId, err.message);
  }
}

// ── Analisi documento di cantiere ──────────────────────────────────────────────
// Stessa logica di analyzeCompanyDoc — site_documents usa le stesse categorie
// (pos, psc, notifica_asl, durc, dvr, assicurazione, altro), stesso prompt.

async function analyzeSiteDoc(docId, filePath, mimeType) {
  try {
    const buffer  = await downloadFileBuffer(filePath);
    const result  = await analyzeDocument(buffer, mimeType, COMPANY_DOC_PROMPT);
    if (!result) return; // formato non analizzabile
    const { data: raw, usage, model } = result;

    const patch = {
      ai_summary:        (raw.summary       || '').slice(0, 2000) || null,
      ai_expiry_date:    normalizeDate(raw.expiry_date),
      ai_renewal_years:  Number.isInteger(raw.renewal_years) ? raw.renewal_years : null,
      ai_issued_by:      (raw.issued_by     || '').slice(0, 500)  || null,
      ai_issues:         Array.isArray(raw.issues) ? raw.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
      ai_validity_ok:    typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
      ai_analyzed_at:    new Date().toISOString(),
    };

    const { data: updated } = await supabase.from('site_documents').update(patch).eq('id', docId).select('company_id').maybeSingle();
    if (updated?.company_id) logUsage({ companyId: updated.company_id, model, callSite: 'site_doc_analysis', usage });
  } catch (err) {
    console.error('[documentAI] site doc analysis failed:', docId, err.message);
  }
}

// ── Analisi documento lavoratore ───────────────────────────────────────────────

async function analyzeWorkerDoc(docId, workerId, companyId, filePath, mimeType) {
  try {
    const buffer  = await downloadFileBuffer(filePath);
    const result  = await analyzeDocument(buffer, mimeType, WORKER_DOC_PROMPT);
    if (!result) return;
    const { data: raw, usage, model } = result;
    logUsage({ companyId, model, callSite: 'worker_doc_analysis', usage });

    const patch = {
      ai_summary:        (raw.summary    || '').slice(0, 2000) || null,
      ai_expiry_date:    normalizeDate(raw.expiry_date),
      ai_renewal_years:  Number.isInteger(raw.renewal_years) ? raw.renewal_years : null,
      ai_issued_to:      (raw.issued_to  || '').slice(0, 500)  || null,
      ai_issued_by:      (raw.issued_by  || '').slice(0, 500)  || null,
      ai_issues:         Array.isArray(raw.issues) ? raw.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
      ai_validity_ok:    typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
      ai_analyzed_at:    new Date().toISOString(),
    };

    await supabase.from('worker_documents').update(patch).eq('id', docId);

    // Leggi il documento aggiornato (serve per sync formazione e shortcut workers)
    const { data: doc } = await supabase
      .from('worker_documents')
      .select('doc_type, name, issued_date, expiry_date, file_url')
      .eq('id', docId)
      .maybeSingle();

    if (doc) {
      const expiryToUse = doc.expiry_date || patch.ai_expiry_date;

      // Se l'AI ha estratto una scadenza e il record non ne aveva, aggiornala
      if (!doc.expiry_date && patch.ai_expiry_date) {
        await supabase.from('worker_documents')
          .update({ expiry_date: patch.ai_expiry_date })
          .eq('id', docId);

        const field = doc.doc_type === 'idoneita_medica'      ? 'health_fitness_expiry'
                    : doc.doc_type === 'formazione_sicurezza' ? 'safety_training_expiry'
                    : null;
        if (field) {
          await supabase.from('workers')
            .update({ [field]: patch.ai_expiry_date })
            .eq('id', workerId)
            .eq('company_id', companyId);
        }
      }

      // Sincronizza con sistema Formazione (worker_certificates)
      await syncToFormazione(
        docId, workerId, companyId,
        doc.doc_type, doc.name,
        doc.issued_date,
        expiryToUse,
        patch.ai_issued_by,
        doc.file_url,
      );
    }
  } catch (err) {
    console.error('[documentAI] worker doc analysis failed:', docId, err.message);
  }
}

// ── Analisi su buffer diretto (smart import — senza salvare prima) ─────────────
// Restituisce i dati estratti da Claude in forma normalizzata, senza toccare il DB.
async function analyzeDocumentBuffer(fileBuffer, mimeType, companyId = null, userId = null) {
  const result = await analyzeDocument(fileBuffer, mimeType, WORKER_DOC_PROMPT);
  if (!result) return null;
  const { data: raw, usage, model } = result;
  if (companyId) logUsage({ companyId, userId, model, callSite: 'document_buffer_analysis', usage });
  const rawCf = String(raw.fiscal_code || '').toUpperCase().replace(/\s/g, '');
  return {
    doc_type:      raw.doc_type_detected || 'altro',
    expiry_date:   normalizeDate(raw.expiry_date),
    renewal_years: Number.isInteger(raw.renewal_years) ? raw.renewal_years : null,
    issued_to:     (String(raw.issued_to  || '')).trim().slice(0, 200) || null,
    fiscal_code:   /^[A-Z0-9]{16}$/.test(rawCf) ? rawCf : null,
    issued_by:     (String(raw.issued_by  || '')).trim().slice(0, 200) || null,
    summary:       (String(raw.summary    || '')).slice(0, 800)        || null,
    issues:        Array.isArray(raw.issues)
      ? raw.issues.slice(0, 5).map(s => String(s).slice(0, 200))
      : [],
    validity_ok:   typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
  };
}

// ── Sync Documenti → Formazione ───────────────────────────────────────────────
// Quando un worker_document di tipo formativo viene caricato/analizzato,
// crea o aggiorna automaticamente il record in worker_certificates.

const FORMAZIONE_SYNC_TYPES = new Set([
  'formazione_sicurezza', 'primo_soccorso', 'antincendio',
  'lavori_quota', 'ponteggi', 'gruista',
]);

function detectCourseTypeName(docType, docName) {
  const lower = (docName || '').toLowerCase();
  switch (docType) {
    case 'formazione_sicurezza':
      if (lower.includes('alto'))  return 'Formazione lavoratori - Rischio Alto';
      if (lower.includes('medio')) return 'Formazione lavoratori - Rischio Medio';
      if (lower.includes('basso')) return 'Formazione lavoratori - Rischio Basso';
      return 'Formazione lavoratori - Rischio Alto'; // default cantieri edili
    case 'primo_soccorso':
      if (lower.includes('gruppo a')) return 'Primo Soccorso - Gruppo A';
      return 'Primo Soccorso - Gruppo B/C';
    case 'antincendio':
      if (lower.includes('alto'))  return 'Antincendio - Rischio Alto';
      if (lower.includes('basso')) return 'Antincendio - Rischio Basso';
      return 'Antincendio - Rischio Medio';
    case 'lavori_quota': return 'Lavori in quota';
    case 'ponteggi':     return 'Ponteggi - Montaggio e smontaggio';
    case 'gruista':      return 'Gru per autocarro';
    default:             return null;
  }
}

async function syncToFormazione(docId, workerId, companyId, docType, docName, issueDate, expiryDate, issuedBy, fileUrl) {
  if (!FORMAZIONE_SYNC_TYPES.has(docType)) return;
  const courseTypeName = detectCourseTypeName(docType, docName);
  if (!courseTypeName) return;

  const { data: ct } = await supabase
    .from('course_types')
    .select('id, validity_years')
    .ilike('name', courseTypeName)
    .maybeSingle();
  if (!ct) return; // course_type non ancora nel DB

  // Calcola issue_date se mancante
  let resolvedIssue = issueDate || null;
  if (!resolvedIssue && expiryDate && ct.validity_years) {
    const d = new Date(expiryDate);
    d.setFullYear(d.getFullYear() - ct.validity_years);
    resolvedIssue = d.toISOString().slice(0, 10);
  }
  if (!resolvedIssue || !expiryDate) return; // dati insufficienti

  const body = (issuedBy || '').trim() || 'Non specificato';

  // Cerca certificato esistente per worker + course_type
  const { data: existing } = await supabase
    .from('worker_certificates')
    .select('id, expiry_date')
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .eq('course_type_id', ct.id)
    .order('expiry_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Aggiorna solo se la nuova scadenza è più recente o uguale
    if (!existing.expiry_date || expiryDate >= existing.expiry_date) {
      await supabase.from('worker_certificates')
        .update({ issue_date: resolvedIssue, expiry_date: expiryDate, issuing_body: body, pdf_url: fileUrl || null })
        .eq('id', existing.id);
    }
  } else {
    await supabase.from('worker_certificates').insert({
      company_id:     companyId,
      worker_id:      workerId,
      course_type_id: ct.id,
      issue_date:     resolvedIssue,
      expiry_date:    expiryDate,
      issuing_body:   body,
      pdf_url:        fileUrl || null,
    });
  }
}

// ── Analisi generica per documenti subappaltatori ─────────────────────────────
// Usa COMPANY_DOC_PROMPT (DURC, polizza, SOA, visura, ecc.) e restituisce patch pronta.
async function analyzeSubcontractorDocBuffer(fileBuffer, mimeType, companyId = null, userId = null) {
  const result = await analyzeDocument(fileBuffer, mimeType, COMPANY_DOC_PROMPT);
  if (!result) return null;
  const { data: raw, usage, model } = result;
  if (companyId) logUsage({ companyId, userId, model, callSite: 'subcontractor_doc_analysis', usage });
  return {
    summary:     (raw.summary    || '').slice(0, 2000) || null,
    expiry_date: normalizeDate(raw.expiry_date),
    issues:      Array.isArray(raw.issues) ? raw.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
    validity_ok: typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
  };
}

module.exports = {
  analyzeCompanyDoc, analyzeSiteDoc, analyzeWorkerDoc, analyzeDocumentBuffer, analyzeSubcontractorDocBuffer, syncToFormazione,
  // Esportati per riuso da services/smartImportAI.js (Importazione Intelligente) —
  // stessi prompt per tipo documento, nessuna duplicazione.
  COMPANY_DOC_PROMPT, WORKER_DOC_PROMPT, MODEL_TEXT, MODEL_VISION, MAX_TOKENS,
  analyzeDocument, downloadFileBuffer, extractFirstJson, normalizeDate,
};
