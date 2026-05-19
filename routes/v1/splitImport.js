'use strict';
/**
 * routes/v1/splitImport.js
 * Split di PDF compositi: un unico file → più documenti × più lavoratori.
 *
 * POST /api/v1/split-import/analyze  — rileva struttura, splitta, analizza ogni pezzo
 * POST /api/v1/split-import/confirm  — salva i documenti confermati dall'utente
 */

const crypto    = require('crypto');
const multer    = require('multer');
const router    = require('express').Router();
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt }     = require('../../middleware/verifyJwt');
const { extractPdfText }        = require('../../lib/pdfExtract');
const { analyzeDocumentBuffer } = require('../../services/documentAI');

const BUCKET      = 'site-documents';
const MAX_BYTES   = 50 * 1024 * 1024; // 50 MB
const MAX_PAGES   = 150;
const CONCURRENCY = 3;

// ── Multer — solo PDF ─────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) =>
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Solo file PDF supportato per la modalità multi-documento.')),
});

// ── Fuzzy match lavoratori ────────────────────────────────────────────────────

function normName(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function scoreMatch(extracted, workerName) {
  const a = normName(extracted), b = normName(workerName);
  if (!a || !b) return 0;
  const ta = new Set(a.split(' ').filter(t => t.length > 1));
  const tb = new Set(b.split(' ').filter(t => t.length > 1));
  const common = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = common / Math.max(ta.size, tb.size, 1);
  const levScore   = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  return Math.round(tokenScore * 70 + levScore * 30);
}

function matchWorkers(nameQuery, workers) {
  if (!nameQuery) return [];
  return workers
    .map(w => ({ worker: w, score: scoreMatch(nameQuery, w.full_name) }))
    .filter(m => m.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ── Estrae il primo oggetto JSON completo (brace-tracking) ───────────────────

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

// ── Claude: rilevamento confini documenti ─────────────────────────────────────

const BOUNDARY_SYSTEM = `Sei un esperto di documentazione sicurezza lavoro italiana (D.Lgs. 81/2008).
Ricevi il testo estratto da un PDF composito con marcatori "--- Pagina N ---".
Identifica ogni documento separato nel file.

Restituisci SOLO questo JSON (zero markdown, zero testo extra):
{
  "documents": [
    {
      "page_start": <intero 1-indexed>,
      "page_end": <intero 1-indexed>,
      "worker_name": "<nome cognome lavoratore oppure null>",
      "doc_type": "<idoneita_medica|formazione_sicurezza|primo_soccorso|antincendio|lavori_quota|ponteggi|gruista|pes_pav_pei|rspp|patente_guida|altro>",
      "confidence": <0.0-1.0>
    }
  ]
}

Regole:
- Nuovo documento quando cambia lavoratore OPPURE cambia tipo di documento
- Un documento può occupare più pagine consecutive
- I range devono coprire TUTTE le pagine senza buchi né sovrapposizioni
- confidence ≥ 0.85 = confini chiari; < 0.5 = incerti (segnalali)`;

async function detectBoundaries(pdfBuffer) {
  const { text, numPages } = await extractPdfText(pdfBuffer, {
    maxPages: MAX_PAGES,
    minChars: 0,
  });

  const client = new Anthropic();
  let userContent;

  if (text.trim() && text.length >= 80) {
    userContent = `Il PDF ha ${numPages} pagine totali.\n\nTesto estratto:\n\n${text.slice(0, 32000)}\n\nIdentifica tutti i documenti.`;
  } else {
    // PDF scansionato senza testo OCR: analisi visiva
    userContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { type: 'text', text: `Il PDF ha ${numPages} pagine totali. Analizza visivamente le pagine e identifica tutti i documenti separati.` },
    ];
  }

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system:     BOUNDARY_SYSTEM,
    messages:   [{ role: 'user', content: userContent }],
  });

  const raw     = response.content?.[0]?.text || '';
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('Analisi struttura fallita: risposta AI non valida.');

  const parsed = JSON.parse(jsonStr);
  let docs = (parsed.documents || [])
    .map(d => ({
      page_start:  Math.max(1, Math.round(Number(d.page_start) || 1)),
      page_end:    Math.min(numPages, Math.round(Number(d.page_end) || 1)),
      worker_name: d.worker_name || null,
      doc_type:    d.doc_type || 'altro',
      confidence:  Math.min(1, Math.max(0, Number(d.confidence) || 0.7)),
    }))
    .filter(d => d.page_start <= d.page_end)
    .sort((a, b) => a.page_start - b.page_start);

  // Risolvi sovrapposizioni e buchi
  docs = normalizeBoundaries(docs, numPages);
  if (!docs.length) throw new Error('Nessun documento identificato nel PDF.');

  return { docs, numPages };
}

// Normalizza i confini: elimina sovrapposizioni, riempie buchi con "altro"
function normalizeBoundaries(docs, numPages) {
  const result = [];
  let cursor = 1;

  for (const doc of docs) {
    // Buco prima di questo documento
    if (doc.page_start > cursor) {
      result.push({ page_start: cursor, page_end: doc.page_start - 1, worker_name: null, doc_type: 'altro', confidence: 0.3 });
    }
    // Aggiusta sovrapposizioni col precedente
    const start = Math.max(doc.page_start, cursor);
    if (start <= doc.page_end) {
      result.push({ ...doc, page_start: start });
      cursor = doc.page_end + 1;
    }
  }
  // Pagine finali non coperte
  if (cursor <= numPages) {
    result.push({ page_start: cursor, page_end: numPages, worker_name: null, doc_type: 'altro', confidence: 0.3 });
  }
  return result;
}

// ── pdf-lib: split in buffer separati ────────────────────────────────────────

async function splitPdfBuffers(pdfBuffer, docs) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const total  = srcDoc.getPageCount();
  const results = [];

  for (const doc of docs) {
    const s  = Math.max(0, doc.page_start - 1);       // 0-indexed
    const e  = Math.min(total - 1, doc.page_end - 1); // 0-indexed inclusive
    const ix = Array.from({ length: e - s + 1 }, (_, i) => s + i);

    const newDoc = await PDFDocument.create();
    const pages  = await newDoc.copyPages(srcDoc, ix);
    pages.forEach(p => newDoc.addPage(p));
    results.push(Buffer.from(await newDoc.save()));
  }
  return results;
}

// ── Upload buffer in temp storage ─────────────────────────────────────────────

async function uploadTemp(companyId, jobId, idx, buf) {
  const path = `temp/split/${companyId}/${jobId}/${idx}.pdf`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (error) throw new Error(`Upload temp fallito: ${error.message}`);
  return path;
}

// ── Label tipo documento ──────────────────────────────────────────────────────

const DOC_LABEL = {
  idoneita_medica:     'Idoneità Medica',
  formazione_sicurezza:'Formazione Sicurezza',
  primo_soccorso:      'Primo Soccorso',
  antincendio:         'Antincendio',
  lavori_quota:        'Lavori in Quota',
  ponteggi:            'Ponteggi',
  gruista:             'Gruista',
  pes_pav_pei:         'PES/PAV/PEI',
  rspp:                'RSPP',
  patente_guida:       'Patente',
  altro:               'Documento',
};

// ── POST /api/v1/split-import/analyze ────────────────────────────────────────

router.post('/split-import/analyze',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    // Carica lavoratori attivi
    const { data: workers } = await supabase
      .from('workers')
      .select('id, full_name, photo_url, is_active')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('full_name');
    const allWorkers = workers || [];

    // 1. Rileva confini via Claude
    let docs, numPages;
    try {
      ({ docs, numPages } = await detectBoundaries(req.file.buffer));
    } catch (err) {
      const code = err.code === 'NO_TEXT' ? 'PDF_NO_TEXT' : 'BOUNDARY_DETECTION_FAILED';
      return res.status(422).json({ error: code, detail: err.message });
    }

    // 2. Splitta in buffer separati
    let splitBuffers;
    try {
      splitBuffers = await splitPdfBuffers(req.file.buffer, docs);
    } catch (err) {
      return res.status(500).json({ error: 'SPLIT_FAILED', detail: err.message });
    }

    const jobId   = crypto.randomUUID();
    const results = new Array(docs.length).fill(null);

    // 3. Upload temp + AI analysis + worker matching — pool di concorrenza
    let i = 0;
    const run = async () => {
      while (i < docs.length) {
        const idx = i++;
        const doc = docs[idx];
        const buf = splitBuffers[idx];

        // Upload in temp storage
        let tempPath;
        try { tempPath = await uploadTemp(req.companyId, jobId, idx, buf); }
        catch {
          results[idx] = {
            error: 'UPLOAD_FAILED',
            page_start: doc.page_start, page_end: doc.page_end,
          };
          continue;
        }

        // Rianalisi precisa del sotto-PDF
        let analysis = null;
        try { analysis = await analyzeDocumentBuffer(buf, 'application/pdf'); } catch { /* ignora */ }

        const nameForMatch  = analysis?.issued_to || doc.worker_name || '';
        const workerMatches = matchWorkers(nameForMatch, allWorkers);
        const docType       = analysis?.doc_type || doc.doc_type || 'altro';
        const expiryDate    = analysis?.expiry_date || null;
        const yr            = expiryDate ? new Date(expiryDate).getFullYear() : new Date().getFullYear();
        const workerName    = analysis?.issued_to || doc.worker_name || '';
        const typeLabel     = DOC_LABEL[docType] || 'Documento';
        const docName       = workerName
          ? `${typeLabel} - ${workerName.split(/\s+/).slice(0, 2).join(' ')} ${yr}`
          : `${typeLabel} ${yr}`;

        results[idx] = {
          temp_path:             tempPath,
          page_start:            doc.page_start,
          page_end:              doc.page_end,
          page_count:            doc.page_end - doc.page_start + 1,
          doc_type:              docType,
          doc_name:              docName,
          expiry_date:           expiryDate || '',
          summary:               analysis?.summary || null,
          worker_name_detected:  workerName,
          fiscal_code_detected:  analysis?.fiscal_code || null,
          worker_matches:        workerMatches,
          confidence:            doc.confidence,
          issues:                analysis?.issues || [],
          validity_ok:           analysis?.validity_ok ?? null,
        };
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, run));

    res.json({
      job_id:      jobId,
      num_pages:   numPages,
      total:       results.length,
      all_workers: allWorkers.map(w => ({ id: w.id, full_name: w.full_name })),
      documents:   results,
    });
  }
);

// ── POST /api/v1/split-import/confirm ────────────────────────────────────────

router.post('/split-import/confirm', verifySupabaseJwt, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'ITEMS_REQUIRED' });

  const toSave   = items.filter(it => it.included && it.worker_id && it.temp_path);
  const allPaths = items.map(it => it.temp_path).filter(Boolean);
  let saved = 0;
  const errors = [];

  for (const item of toSave) {
    const { temp_path, worker_id, doc_type, expiry_date, doc_name } = item;

    // Verifica appartenenza lavoratore alla company
    const { data: worker } = await supabase
      .from('workers').select('id')
      .eq('id', worker_id).eq('company_id', req.companyId).maybeSingle();
    if (!worker) { errors.push({ temp_path, error: 'WORKER_NOT_FOUND' }); continue; }

    // Scarica da temp storage
    const { data: fileData, error: dlErr } = await supabase.storage
      .from(BUCKET).download(temp_path);
    if (dlErr) { errors.push({ temp_path, error: 'DOWNLOAD_FAILED' }); continue; }

    const buf = Buffer.from(await fileData.arrayBuffer());

    // Upload nella posizione permanente
    const finalPath = `${req.companyId}/workers/${worker_id}/${crypto.randomUUID()}.pdf`;
    const { error: ulErr } = await supabase.storage.from(BUCKET).upload(finalPath, buf, {
      contentType: 'application/pdf', upsert: false,
    });
    if (ulErr) { errors.push({ temp_path, error: 'UPLOAD_FAILED' }); continue; }

    // Signed URL 10 anni
    const { data: signed } = await supabase.storage.from(BUCKET)
      .createSignedUrl(finalPath, 60 * 60 * 24 * 365 * 10);

    // Inserisce in worker_documents
    const { error: dbErr } = await supabase
      .from('worker_documents')
      .insert({
        company_id:  req.companyId,
        worker_id,
        doc_type:    doc_type   || 'altro',
        name:        (doc_name  || 'Documento').slice(0, 200),
        expiry_date: expiry_date || null,
        file_path:   finalPath,
        file_url:    signed?.signedUrl || null,
        mime_type:   'application/pdf',
      });

    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([finalPath]).catch(() => {});
      errors.push({ temp_path, error: 'DB_ERROR' });
      continue;
    }

    // Sincronizza shortcut scadenze su workers
    if (expiry_date) {
      const field = doc_type === 'idoneita_medica'      ? 'health_fitness_expiry'
                  : doc_type === 'formazione_sicurezza' ? 'safety_training_expiry'
                  : null;
      if (field) {
        await supabase.from('workers')
          .update({ [field]: expiry_date })
          .eq('id', worker_id).eq('company_id', req.companyId);
      }
    }

    saved++;
  }

  // Elimina TUTTI i file temp del job (inclusi quelli esclusi dall'utente)
  if (allPaths.length) {
    await supabase.storage.from(BUCKET).remove(allPaths).catch(() => {});
  }

  res.json({ saved, errors: errors.length ? errors : undefined });
});

module.exports = router;
