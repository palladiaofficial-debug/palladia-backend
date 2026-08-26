'use strict';
/**
 * services/ladiaDocumentSearch.js
 *
 * Cerca documenti in tutti gli archivi Palladia (ladia_document_templates,
 * site_documents, company_documents, worker_documents, subcontractor_documents,
 * studio_shared_documents, payslips) e li legge con Claude native PDF API per
 * rispondere a domande specifiche sul loro contenuto.
 *
 * Tutti i PDF risiedono nel bucket 'site-documents' di Supabase Storage.
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');
const { logUsage } = require('../lib/ladiaUsageLog');
const { flattenToText } = require('../lib/ocrSanitize');

const BUCKET             = 'site-documents';
const SIGNED_URL_SECONDS = 24 * 60 * 60; // 24 ore
const MAX_PDF_BYTES      = 15 * 1024 * 1024; // 15 MB
const MODEL              = 'claude-sonnet-4-6';

// ── Utilità storage ───────────────────────────────────────────────────────────

async function downloadPdf(storagePath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw new Error(`Storage download error: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error(`PDF troppo grande (${Math.round(buf.length / 1_000_000)} MB)`);
  return buf;
}

async function getSignedUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (error) throw new Error(`Signed URL error: ${error.message}`);
  return data.signedUrl;
}

// ── Ricerca documenti ─────────────────────────────────────────────────────────

// `tipo` arriva in due vocabolari diversi a seconda del tool chiamante:
// leggi_documento_pdf passa una parola semantica italiana (il suo enum
// tipo_documento: durc, assicurazione, capitolato, ...), search_documents passa
// spesso il valore letterale della colonna category/doc_type nel DB (es. 'dvr',
// 'durc' — che coincidono per site_documents, ma NON sempre: subcontractor_documents
// usa 'insurance' dove site_documents usa 'assicurazione'). Prova prima la mappa
// semantica, poi il valore letterale diretto, così il boost scatta con entrambi i
// vocabolari — non cambia mai se un documento viene trovato (quello è sempre la
// ricerca per nome, mai esclusiva), solo l'ordine tra più risultati con lo stesso nome.
function matchBoost(tipoMap, tipo, actualValue) {
  if (!tipo || !actualValue) return false;
  const key = tipo.toLowerCase();
  const mapped = tipoMap[key];
  if (mapped) return Array.isArray(mapped) ? mapped.includes(actualValue) : mapped === actualValue;
  return key === actualValue.toLowerCase();
}

async function searchLadiaTemplates(companyId, nomeFile, tipo) {
  let q = supabase
    .from('ladia_document_templates')
    .select('id, document_type, original_filename, summary, key_sections, extracted_text, storage_path, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(15);

  if (nomeFile) q = q.ilike('original_filename', `%${nomeFile}%`);

  const typeMap = {
    capitolato: 'capitolato', contratto: 'contratto', pos: 'POS', psc: 'PSC',
    durc: 'altro', dvr: 'altro', assicurazione: 'altro', attestato: 'altro', certificato: 'altro',
  };
  const effectiveTipo = tipo && tipo !== 'qualsiasi' ? tipo : null;

  const { data } = await q;
  return (data || []).map(d => ({
    source:         'ladia_template',
    id:             d.id,
    nome:           d.original_filename,
    storage_path:   d.storage_path,
    extracted_text: d.extracted_text,
    summary:        d.summary,
    key_sections:   d.key_sections,
    score:          3 + (matchBoost(typeMap, effectiveTipo, d.document_type) ? 2 : 0), // priorità alta — già analizzati
  }));
}

async function searchSiteDocuments(companyId, siteId, nomeFile, tipo) {
  const TIPO_CATEGORIES = {
    pos: ['pos'], psc: ['psc'], durc: ['durc'], dvr: ['dvr'],
    assicurazione: ['assicurazione'], notifica_asl: ['notifica_asl'],
  };

  let q = supabase
    .from('site_documents')
    .select('id, name, category, file_path, mime_type, created_at')
    .eq('company_id', companyId)
    .not('file_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (siteId)  q = q.eq('site_id', siteId);
  if (nomeFile) q = q.ilike('name', `%${nomeFile}%`);

  const { data } = await q;
  // La categoria è solo un BOOST del punteggio, non un filtro escludente: un
  // documento archiviato con la categoria "sbagliata" dall'utente deve restare
  // trovabile (altrimenti il tool risponde "non trovato" su un doc che esiste).
  return (data || [])
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source: 'site_document', id: d.id, nome: d.name, storage_path: d.file_path,
      score: 2 + (matchBoost(TIPO_CATEGORIES, tipo, d.category) ? 2 : 0),
    }));
}

async function searchCompanyDocuments(companyId, nomeFile, tipo) {
  const TIPO_CATEGORIES = {
    durc: ['durc'], assicurazione: ['assicurazione', 'polizza'],
    rspp: ['rspp'], dvr: ['dvr'], formazione: ['formazione'],
    visura: ['visura'], iso: ['iso'], soa: ['soa'],
  };

  let q = supabase
    .from('company_documents')
    .select('id, name, category, file_path, mime_type, created_at')
    .eq('company_id', companyId)
    .not('file_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (nomeFile) q = q.ilike('name', `%${nomeFile}%`);

  const { data } = await q;
  return (data || [])
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source: 'company_document', id: d.id, nome: d.name, storage_path: d.file_path,
      score: 2 + (matchBoost(TIPO_CATEGORIES, tipo, d.category) ? 2 : 0),
    }));
}

async function searchWorkerDocuments(companyId, nomeFile, tipo, nomeLavoratore) {
  const TIPO_DOC_TYPES = {
    attestato: null, certificato: null, idoneita_medica: ['idoneita_medica'],
    formazione: ['formazione_sicurezza', 'primo_soccorso', 'antincendio',
                 'lavori_quota', 'ponteggi', 'gruista', 'pes_pav_pei'],
  };

  // Trova worker per nome (se specificato)
  let workerIds = null;
  if (nomeLavoratore) {
    const { data: workers } = await supabase
      .from('workers')
      .select('id')
      .eq('company_id', companyId)
      .ilike('full_name', `%${nomeLavoratore}%`)
      .limit(5);
    if (!workers?.length) return [];
    workerIds = workers.map(w => w.id);
  }

  let q = supabase
    .from('worker_documents')
    .select('id, name, doc_type, file_path, mime_type, worker_id, created_at')
    .eq('company_id', companyId)
    .not('file_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(25);

  if (workerIds) q = q.in('worker_id', workerIds);
  if (nomeFile) q = q.ilike('name', `%${nomeFile}%`);

  const { data } = await q;
  if (!data?.length) return [];

  // Arricchisci con il nome del lavoratore
  const wIds = [...new Set(data.map(d => d.worker_id).filter(Boolean))];
  let workerNames = {};
  if (wIds.length) {
    const { data: ws } = await supabase
      .from('workers').select('id, full_name').in('id', wIds);
    (ws || []).forEach(w => { workerNames[w.id] = w.full_name; });
  }

  return data
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source:       'worker_document',
      id:           d.id,
      nome:         `${workerNames[d.worker_id] || 'Lavoratore'} — ${d.name || d.doc_type}`,
      storage_path: d.file_path,
      score:        1 + (matchBoost(TIPO_DOC_TYPES, tipo, d.doc_type) ? 1 : 0),
    }));
}

async function searchSubcontractorDocuments(companyId, nomeFile, tipo) {
  const TIPO_CATEGORIES = {
    durc: ['durc'], assicurazione: ['insurance'], soa: ['soa'], visura: ['visura'], iso: ['iso'],
  };

  let q = supabase
    .from('subcontractor_documents')
    .select('id, name, category, file_path, mime_type, subcontractor_id, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (nomeFile) q = q.ilike('name', `%${nomeFile}%`);

  const { data } = await q;
  if (!data?.length) return [];

  const subIds = [...new Set(data.map(d => d.subcontractor_id).filter(Boolean))];
  let subNames = {};
  if (subIds.length) {
    const { data: subs } = await supabase.from('subcontractors').select('id, company_name').in('id', subIds);
    (subs || []).forEach(s => { subNames[s.id] = s.company_name; });
  }

  return data
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source: 'subcontractor_document', id: d.id,
      nome: `${subNames[d.subcontractor_id] || 'Subappaltatore'} — ${d.name}`,
      storage_path: d.file_path,
      score: 2 + (matchBoost(TIPO_CATEGORIES, tipo, d.category) ? 2 : 0),
    }));
}

async function searchStudioSharedDocuments(companyId, nomeFile) {
  let q = supabase
    .from('studio_shared_documents')
    .select('id, name, file_path, mime_type, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (nomeFile) q = q.ilike('name', `%${nomeFile}%`);

  const { data } = await q;
  return (data || [])
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({ source: 'studio_shared_document', id: d.id, nome: d.name, storage_path: d.file_path, score: 2 }));
}

async function searchPayslips(companyId, nomeFile, nomeLavoratore) {
  let workerIds = null;
  if (nomeLavoratore) {
    const { data: workers } = await supabase
      .from('workers').select('id').eq('company_id', companyId).ilike('full_name', `%${nomeLavoratore}%`).limit(5);
    if (!workers?.length) return [];
    workerIds = workers.map(w => w.id);
  }

  let q = supabase
    .from('payslips')
    .select('id, filename, file_path, period_year, period_month, worker_id, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(25);

  if (workerIds) q = q.in('worker_id', workerIds);
  if (nomeFile) q = q.ilike('filename', `%${nomeFile}%`);

  const { data } = await q;
  if (!data?.length) return [];

  const wIds = [...new Set(data.map(d => d.worker_id).filter(Boolean))];
  let workerNames = {};
  if (wIds.length) {
    const { data: ws } = await supabase.from('workers').select('id, full_name').in('id', wIds);
    (ws || []).forEach(w => { workerNames[w.id] = w.full_name; });
  }

  // payslips non ha mime_type (sono sempre PDF caricati come tali, vedi routes/v1/payslips.js) — nessun filtro extra necessario.
  return data.map(d => ({
    source: 'payslip', id: d.id,
    nome: `Cedolino ${workerNames[d.worker_id] || 'lavoratore'} — ${String(d.period_month).padStart(2, '0')}/${d.period_year}`,
    storage_path: d.file_path,
    score: 1,
  }));
}

// ── Lettura documento con Claude ──────────────────────────────────────────────

async function readDocumentWithClaude(doc, domanda) {
  const client = new Anthropic();

  // Se il documento è un template già elaborato usa il testo estratto (più veloce)
  if (doc.source === 'ladia_template' && doc.extracted_text) {
    const res = await client.messages.create({
      model:      MODEL,
      max_tokens: 800,
      system: `Sei un assistente tecnico edile. Rispondi SOLO con JSON grezzo (no markdown):
{"risposta":"<risposta precisa alla domanda, max 300 parole>","citazione":"<frase/paragrafo rilevante verbatim dal testo, max 500 caratteri>","pagina":null}`,
      messages: [{
        role: 'user',
        content: `DOCUMENTO: ${doc.nome}\nCONTENUTO:\n${doc.extracted_text.slice(0, 12000)}\n\nDOMANDA: ${domanda}`,
      }],
    });
    return { ...parseClaudeJson(res.content?.[0]?.text), usage: res.usage };
  }

  // PDF nativo
  const pdfBuffer = await downloadPdf(doc.storage_path);
  const res = await client.messages.create({
    model:      MODEL,
    max_tokens: 800,
    system: `Sei un assistente tecnico edile. Rispondi SOLO con JSON grezzo (no markdown):
{"risposta":"<risposta precisa alla domanda, max 300 parole>","citazione":"<frase/paragrafo rilevante verbatim dal documento, max 500 caratteri>","pagina":<numero pagina intero o null>}`,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: `DOMANDA: ${domanda}` },
      ],
    }],
  });
  return { ...parseClaudeJson(res.content?.[0]?.text), usage: res.usage };
}

function parseClaudeJson(raw = '') {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { risposta: raw.trim(), citazione: null, pagina: null };
  try {
    const p = JSON.parse(match[0]);
    // F-086/BLOCCO 2: stesso pattern F-066 — nessuno schema imposto sulla
    // risposta di Claude, un documento denso può far restituire un oggetto
    // annidato invece di testo semplice. `citazione` viene renderizzata
    // direttamente come figlio React in ladiaChatCards.tsx (tipizzata
    // string|null solo lato TypeScript, nessuna garanzia a runtime) — un
    // oggetto qui crasherebbe la chat con l'errore #31, come F-066.
    return {
      risposta: flattenToText(p.risposta) || '',
      citazione: flattenToText(p.citazione),
      pagina: typeof p.pagina === 'number' ? p.pagina : null,
    };
  } catch {
    return { risposta: raw.trim(), citazione: null, pagina: null };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Cerca e legge il documento più pertinente tra tutti gli archivi.
 *
 * @param {{ companyId, siteId, domanda, tipo, nomeFile, nomeLavoratore }} opts
 * @returns {{ risposta, citazione, pagina, nome_doc, signed_url, n_trovati, altri_nomi }}
 */
async function searchAndReadDocument({ companyId, siteId, domanda, tipo, nomeFile, nomeLavoratore }) {
  const [templates, siteDocs, companyDocs, workerDocs, subDocs, studioDocs, payslips] = await Promise.all([
    searchLadiaTemplates(companyId, nomeFile, tipo).catch(() => []),
    searchSiteDocuments(companyId, siteId, nomeFile, tipo).catch(() => []),
    searchCompanyDocuments(companyId, nomeFile, tipo).catch(() => []),
    searchWorkerDocuments(companyId, nomeFile, tipo, nomeLavoratore).catch(() => []),
    searchSubcontractorDocuments(companyId, nomeFile, tipo).catch(() => []),
    searchStudioSharedDocuments(companyId, nomeFile).catch(() => []),
    searchPayslips(companyId, nomeFile, nomeLavoratore).catch(() => []),
  ]);

  const allDocs = [...templates, ...siteDocs, ...companyDocs, ...workerDocs, ...subDocs, ...studioDocs, ...payslips];
  if (!allDocs.length) {
    return { errore: 'Nessun documento trovato. Verifica che il documento sia caricato su Palladia.' };
  }

  // Ordina per score (template prima), poi prende il primo
  allDocs.sort((a, b) => b.score - a.score);
  const doc = allDocs[0];

  // Leggi con Claude (con fallback se download fallisce)
  let analysis;
  try {
    analysis = await readDocumentWithClaude(doc, domanda);
  } catch (err) {
    // Prova il prossimo documento disponibile
    for (const fallback of allDocs.slice(1, 3)) {
      try {
        analysis = await readDocumentWithClaude(fallback, domanda);
        Object.assign(doc, fallback); // usa il fallback come doc principale
        break;
      } catch { /* continua */ }
    }
    if (!analysis) throw new Error(`Impossibile leggere il documento: ${err.message}`);
  }
  logUsage({ companyId, model: MODEL, callSite: 'ladia_document_search_read', usage: analysis.usage });

  // Genera URL firmato per il documento originale
  let signedUrl = null;
  if (doc.storage_path) {
    signedUrl = await getSignedUrl(doc.storage_path).catch(() => null);
  }

  return {
    risposta:    analysis.risposta,
    citazione:   analysis.citazione,
    pagina:      analysis.pagina,
    nome_doc:    doc.nome,
    signed_url:  signedUrl,
    n_trovati:   allDocs.length,
    altri_nomi:  allDocs.slice(1, 4).map(d => d.nome),
  };
}

module.exports = {
  searchAndReadDocument,
  searchSubcontractorDocuments,
  searchStudioSharedDocuments,
  searchPayslips,
  matchBoost,
  parseClaudeJson, // esportata solo per il test di regressione F-086 (BLOCCO 2, classe "fiducia cieca IA")
};
