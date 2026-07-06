'use strict';
/**
 * services/ladiaDocumentSearch.js
 *
 * Cerca documenti in tutti gli archivi Palladia (ladia_document_templates,
 * site_documents, company_documents, worker_documents) e li legge con
 * Claude native PDF API per rispondere a domande specifiche sul loro contenuto.
 *
 * Tutti i PDF risiedono nel bucket 'site-documents' di Supabase Storage.
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');

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
  const mapped = tipo && tipo !== 'qualsiasi' ? typeMap[tipo.toLowerCase()] : null;

  const { data } = await q;
  return (data || []).map(d => ({
    source:         'ladia_template',
    id:             d.id,
    nome:           d.original_filename,
    storage_path:   d.storage_path,
    extracted_text: d.extracted_text,
    summary:        d.summary,
    key_sections:   d.key_sections,
    score:          3 + (mapped && d.document_type === mapped ? 2 : 0), // priorità alta — già analizzati
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
  const cats = tipo && TIPO_CATEGORIES[tipo.toLowerCase()];
  return (data || [])
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source: 'site_document', id: d.id, nome: d.name, storage_path: d.file_path,
      score: 2 + (cats?.includes(d.category) ? 2 : 0),
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
  const cats = tipo && TIPO_CATEGORIES[tipo.toLowerCase()];
  return (data || [])
    .filter(d => d.mime_type?.includes('pdf') || d.file_path?.endsWith('.pdf'))
    .map(d => ({
      source: 'company_document', id: d.id, nome: d.name, storage_path: d.file_path,
      score: 2 + (cats?.includes(d.category) ? 2 : 0),
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

  const docTypes = tipo && TIPO_DOC_TYPES[tipo.toLowerCase()];

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
      score:        1 + (docTypes?.includes(d.doc_type) ? 1 : 0),
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
    return parseClaudeJson(res.content?.[0]?.text);
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
  return parseClaudeJson(res.content?.[0]?.text);
}

function parseClaudeJson(raw = '') {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { risposta: raw.trim(), citazione: null, pagina: null };
  try {
    const p = JSON.parse(match[0]);
    return {
      risposta: p.risposta || '',
      citazione: p.citazione || null,
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
  const [templates, siteDocs, companyDocs, workerDocs] = await Promise.all([
    searchLadiaTemplates(companyId, nomeFile, tipo).catch(() => []),
    searchSiteDocuments(companyId, siteId, nomeFile, tipo).catch(() => []),
    searchCompanyDocuments(companyId, nomeFile, tipo).catch(() => []),
    searchWorkerDocuments(companyId, nomeFile, tipo, nomeLavoratore).catch(() => []),
  ]);

  const allDocs = [...templates, ...siteDocs, ...companyDocs, ...workerDocs];
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

module.exports = { searchAndReadDocument };
