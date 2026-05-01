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

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
const BUCKET     = 'site-documents';

// ── Prompt documenti aziendali ────────────────────────────────────────────────

const COMPANY_DOC_PROMPT = `Sei un esperto di sicurezza sul lavoro e documentazione aziendale italiana (D.Lgs. 81/2008).
Analizza il documento e restituisci SOLO un oggetto JSON valido con questa struttura:

{
  "summary": "<2-3 frasi: cosa è, chi l'ha emesso, cosa attesta>",
  "doc_type_detected": "<durc|dvr|duvri|soa|iso|assicurazione|polizza|visura|formazione|rspp|rls|medico_competente|visite_mediche|primo_soccorso|emergenze|preposto|f24|altro>",
  "expiry_date": "<YYYY-MM-DD oppure null se non presente o permanente>",
  "renewal_years": <numero intero anni tra un rinnovo e l'altro, null se non applicabile>,
  "issued_by": "<ente o soggetto che ha emesso il documento, null se non leggibile>",
  "issues": ["<eventuale problema: documento scaduto, firma mancante, dati incompleti, ecc.>"],
  "validity_ok": <true se il documento sembra valido e completo, false se ci sono problemi>
}

Esempi renewal_years: DURC=3mesi(0), DVR=nessun limite fisso(null), SOA=5, ISO=3, assicurazione=1, idoneità medica=1 o 2, formazione sicurezza=5.
Scrivi issues solo se ci sono problemi reali. Output: SOLO JSON grezzo senza markdown.`;

// ── Prompt documenti lavoratori ───────────────────────────────────────────────

const WORKER_DOC_PROMPT = `Sei un esperto di sicurezza sul lavoro italiana (D.Lgs. 81/2008) e certificazioni lavoratori.
Analizza il documento e restituisci SOLO un oggetto JSON valido con questa struttura:

{
  "summary": "<2-3 frasi: cosa attesta, chi riguarda, cosa autorizza>",
  "doc_type_detected": "<idoneita_medica|formazione_sicurezza|primo_soccorso|antincendio|lavori_quota|ponteggi|gruista|pes_pav_pei|rspp|patente_guida|altro>",
  "expiry_date": "<YYYY-MM-DD oppure null se non presente o permanente>",
  "renewal_years": <numero intero anni tra un rinnovo e l'altro, null se non applicabile>,
  "issued_to": "<nome e cognome del lavoratore a cui è intestato, null se non leggibile>",
  "issued_by": "<medico, ente di formazione o soggetto emittente, null se non leggibile>",
  "issues": ["<eventuale problema: scaduto, firma mancante, nominativo illeggibile, ecc.>"],
  "validity_ok": <true se il documento sembra valido e completo, false se ci sono problemi>
}

Esempi renewal_years: idoneità medica=1(rischio alto) o 2(normale), formazione_sicurezza=5, primo_soccorso=3, antincendio=3, lavori_quota=5, ponteggi=4, patente_guida=10.
Scrivi issues solo se ci sono problemi reali. Output: SOLO JSON grezzo senza markdown.`;

// ── Helper: scarica file da Storage ──────────────────────────────────────────

async function downloadFileBuffer(filePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
  if (error) throw new Error(`Storage download error: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: fileBuffer.toString('base64') } };

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     systemPrompt,
    messages: [{
      role:    'user',
      content: [
        contentBlock,
        { type: 'text', text: 'Analizza questo documento e restituisci il JSON richiesto.' },
      ],
    }],
  });

  const raw = response.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude non ha restituito un JSON valido');
  return JSON.parse(jsonMatch[0]);
}

// ── Normalizza data ────────────────────────────────────────────────────────────

function normalizeDate(val) {
  if (!val || typeof val !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  return null;
}

// ── Analisi documento aziendale ────────────────────────────────────────────────

async function analyzeCompanyDoc(docId, filePath, mimeType) {
  try {
    const buffer = await downloadFileBuffer(filePath);
    const raw    = await analyzeDocument(buffer, mimeType, COMPANY_DOC_PROMPT);
    if (!raw) return; // formato non analizzabile

    const patch = {
      ai_summary:        (raw.summary       || '').slice(0, 2000) || null,
      ai_expiry_date:    normalizeDate(raw.expiry_date),
      ai_renewal_years:  Number.isInteger(raw.renewal_years) ? raw.renewal_years : null,
      ai_issued_by:      (raw.issued_by     || '').slice(0, 500)  || null,
      ai_issues:         Array.isArray(raw.issues) ? raw.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
      ai_validity_ok:    typeof raw.validity_ok === 'boolean' ? raw.validity_ok : null,
      ai_analyzed_at:    new Date().toISOString(),
    };

    await supabase.from('company_documents').update(patch).eq('id', docId);
  } catch (err) {
    console.error('[documentAI] company doc analysis failed:', docId, err.message);
  }
}

// ── Analisi documento lavoratore ───────────────────────────────────────────────

async function analyzeWorkerDoc(docId, workerId, companyId, filePath, mimeType) {
  try {
    const buffer = await downloadFileBuffer(filePath);
    const raw    = await analyzeDocument(buffer, mimeType, WORKER_DOC_PROMPT);
    if (!raw) return;

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

    // Se l'AI ha estratto una scadenza e il record non aveva expiry_date, aggiornala
    if (patch.ai_expiry_date) {
      const { data: doc } = await supabase
        .from('worker_documents')
        .select('expiry_date, doc_type')
        .eq('id', docId)
        .maybeSingle();

      if (doc && !doc.expiry_date) {
        await supabase.from('worker_documents')
          .update({ expiry_date: patch.ai_expiry_date })
          .eq('id', docId);

        // Sincronizza shortcut su workers
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
    }
  } catch (err) {
    console.error('[documentAI] worker doc analysis failed:', docId, err.message);
  }
}

module.exports = { analyzeCompanyDoc, analyzeWorkerDoc };
