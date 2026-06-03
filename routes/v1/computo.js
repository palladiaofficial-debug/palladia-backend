'use strict';
/**
 * routes/v1/computo.js
 * Computo Metrico digitale con SAL per voce.
 *
 * POST   /api/v1/sites/:siteId/computo/parse     — AI parsing (no save, ritorna draft)
 * POST   /api/v1/sites/:siteId/computo           — salva computo (dopo revisione)
 * GET    /api/v1/sites/:siteId/computo           — recupera computo attivo con voci
 * GET    /api/v1/sites/:siteId/computo/export.pdf — esporta SAL in PDF stile Palladia
 * PATCH  /api/v1/computo/voci/:voceId/sal        — aggiorna SAL% voce singola
 * DELETE /api/v1/sites/:siteId/computo/:id       — elimina computo
 */

const router    = require('express').Router();
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { parsePdf, parseExcel } = require('../../services/computoParser');
const { generateComputoPdf } = require('../../services/computoPdfGenerator');
const { validate } = require('../../middleware/validate');
const { createComputoSchema, patchVoceSalSchema } = require('../../lib/schemas/computo');

let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

// ── Multer: in-memory, max 25MB, PDF + Excel ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Formato non supportato. Carica un PDF o un file Excel.'));
  },
});

router.use(verifySupabaseJwt);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function resolveSite(siteId, companyId) {
  if (!isUuid(siteId)) return null;
  const { data } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
  return data;
}

// ── POST /api/v1/sites/:siteId/computo/parse ──────────────────
// Parsa il file con AI, ritorna il draft senza salvare nulla.

router.post('/sites/:siteId/computo/parse',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    next();
  }),
  async (req, res) => {
    const { companyId } = req;
    const { siteId }    = req.params;

    const site = await resolveSite(siteId, companyId);
    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'Carica un file PDF o Excel.' });

    const { mimetype, buffer } = req.file;
    const isPdf   = mimetype === 'application/pdf';
    const isExcel = mimetype.includes('excel') || mimetype.includes('spreadsheet');

    try {
      let parsed;
      if (isPdf)        parsed = await parsePdf(buffer);
      else if (isExcel) parsed = await parseExcel(buffer);
      else return res.status(400).json({ error: 'FORMAT_UNSUPPORTED' });

      res.json({
        nome:             parsed.nome || 'Computo metrico',
        totale_contratto: parsed.totale_contratto,
        n_voci:           parsed.voci.filter(v => v.tipo === 'voce').length,
        n_categorie:      parsed.voci.filter(v => v.tipo === 'categoria').length,
        fonte:            isPdf ? 'pdf' : 'excel',
        voci:             parsed.voci,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[computo/parse] ERROR:', msg, err?.stack || '');
      const isUserError = msg.includes('non contiene') || msg.includes('Nessuna voce') || msg.includes('non parsabile') || msg.includes('grande');
      res.status(isUserError ? 422 : 500).json({ error: isUserError ? 'PARSE_FAILED' : 'INTERNAL', message: msg });
    }
  }
);

// ── POST /api/v1/sites/:siteId/computo/parse-generic ─────────
// Parsa UN QUALSIASI PDF preventivo/offerta con Claude puro (nessun regex).
// Utile per documenti non-strutturati: computi artigianali, preventivi liberi, ecc.
// Restituisce lo stesso formato di /parse per il flow di revisione identico.

router.post('/sites/:siteId/computo/parse-generic',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    next();
  }),
  async (req, res) => {
    const { companyId } = req;
    const { siteId }    = req.params;

    const site = await resolveSite(siteId, companyId);
    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const { mimetype, buffer, originalname } = req.file;
    if (mimetype !== 'application/pdf')
      return res.status(400).json({ error: 'PDF_ONLY', message: 'Carica un PDF per il preventivo libero.' });

    if (buffer.length > 15 * 1024 * 1024)
      return res.status(422).json({ error: 'FILE_TOO_LARGE_FOR_AI', message: 'Il PDF è troppo grande per l\'analisi AI (max 15 MB). Comprimi il file e riprova.' });

    const b64 = buffer.toString('base64');

    const prompt = `Sei un esperto di computi metrici edili italiani. Analizza questo documento (può essere un preventivo, un computo, un'offerta, un capitolato sintetico) ed estrai TUTTE le voci di lavoro presenti.

Per ogni voce fornisci:
- categoria: categoria/sezione di appartenza (es. "Demolizioni", "Strutture", "Finiture", ecc.)
- codice: codice della voce se presente, altrimenti null
- descrizione: descrizione della lavorazione (non troncare)
- unita_misura: unità di misura (m, m², m³, kg, cad, corpo, ecc.) o null
- quantita: numero come float, null se assente
- prezzo_unitario: prezzo unitario come float, null se assente
- importo: quantita × prezzo_unitario come float, o importo diretto se presente, null se non calcolabile

Regole:
1. Le CATEGORIE vanno estratte come oggetti con tipo "categoria"
2. Le VOCI SINGOLE di lavoro vanno estratte come oggetti con tipo "voce"
3. Ogni voce deve avere parent_codice uguale al codice della categoria di appartenenza
4. Se non ci sono categorie esplicite nel documento, creane una chiamata "Lavori"
5. Ignora totali, subtotali, condizioni di pagamento, firme, intestazioni aziendali

Rispondi SOLO con un oggetto JSON in questo formato (nessun testo fuori dal JSON):
{
  "nome": "titolo del documento o 'Preventivo'",
  "voci": [
    { "tipo": "categoria", "codice": "A", "descrizione": "Nome categoria", "sort_order": 0 },
    { "tipo": "voce", "parent_codice": "A", "codice": "A.1", "descrizione": "...", "unita_misura": "m²", "quantita": 120.5, "prezzo_unitario": 45.00, "importo": 5422.50, "sort_order": 1 }
  ]
}`;

    try {
      const ai  = getAI();
      const msg = await ai.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{
          role:    'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      });

      const raw  = msg.content.find(b => b.type === 'text')?.text?.trim() || '{}';
      const json = raw.startsWith('```') ? raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim() : raw;
      const data = JSON.parse(json);

      if (!Array.isArray(data.voci) || data.voci.length === 0)
        return res.status(422).json({ error: 'PARSE_FAILED', message: 'Nessuna voce trovata nel documento.' });

      const voci = data.voci.map((v, i) => ({
        tipo:            v.tipo === 'categoria' ? 'categoria' : 'voce',
        parent_codice:   v.parent_codice || null,
        codice:          v.codice        || null,
        descrizione:     String(v.descrizione || '').slice(0, 500),
        unita_misura:    v.unita_misura   || null,
        quantita:        v.quantita       != null ? Number(v.quantita)       : null,
        prezzo_unitario: v.prezzo_unitario != null ? Number(v.prezzo_unitario): null,
        importo:         v.importo        != null ? Number(v.importo)        : null,
        sort_order:      Number(v.sort_order ?? i),
      }));

      const totale = voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo || 0), 0);
      const nome   = String(data.nome || originalname?.replace(/\.pdf$/i, '') || 'Preventivo').slice(0, 200);

      res.json({
        nome,
        totale_contratto: Math.round(totale * 100) / 100,
        n_voci:           voci.filter(v => v.tipo === 'voce').length,
        n_categorie:      voci.filter(v => v.tipo === 'categoria').length,
        fonte:            'pdf',
        voci,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[computo/parse-generic] ERROR:', msg, err?.status ?? '', err?.stack || '');

      if (err instanceof SyntaxError)
        return res.status(422).json({ error: 'PARSE_FAILED', message: 'Il modello non ha restituito JSON valido. Riprova.' });

      if (err?.status === 529 || /overload/i.test(msg))
        return res.status(503).json({ error: 'AI_OVERLOADED', message: 'Il servizio AI è temporaneamente sovraccarico. Riprova tra qualche secondo.' });

      if (err?.status === 413 || /too large|request entity/i.test(msg))
        return res.status(422).json({ error: 'FILE_TOO_LARGE_FOR_AI', message: 'Il PDF è troppo grande per essere analizzato. Comprimi il file (max 15 MB) e riprova.' });

      if (/credit balance|billing|quota/i.test(msg))
        return res.status(503).json({ error: 'AI_QUOTA', message: 'Servizio AI temporaneamente non disponibile. Riprova più tardi.' });

      if (err?.status === 401 || /api.key|authentication/i.test(msg))
        return res.status(500).json({ error: 'AI_CONFIG', message: 'Configurazione AI non disponibile. Contatta il supporto.' });

      res.status(500).json({ error: 'INTERNAL', message: 'Errore durante l\'analisi. Riprova.' });
    }
  }
);

// ── POST /api/v1/sites/:siteId/computo ────────────────────────
// Salva il computo (confermato dall'utente dopo revisione).

router.post('/sites/:siteId/computo', validate(createComputoSchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;
  const { nome, fonte, voci } = req.body;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  if (!voci || !Array.isArray(voci) || voci.length === 0)
    return res.status(400).json({ error: 'VOCI_REQUIRED' });

  // Calcola totale contratto
  const totale = voci
    .filter(v => v.tipo === 'voce')
    .reduce((s, v) => s + (Number(v.importo) || 0), 0);

  // Elimina eventuale computo precedente (uno solo per cantiere)
  const { data: existing } = await supabase
    .from('site_computo').select('id').eq('site_id', siteId).eq('company_id', companyId).maybeSingle();
  if (existing) {
    await supabase.from('site_computo').delete().eq('id', existing.id);
  }

  // Crea nuovo computo
  const { data: computo, error: compErr } = await supabase
    .from('site_computo')
    .insert({
      company_id:       companyId,
      site_id:          siteId,
      nome:             String(nome || 'Computo metrico').slice(0, 200),
      fonte:            fonte || 'manuale',
      totale_contratto: Math.round(totale * 100) / 100,
      created_by:       user.id,
    })
    .select()
    .single();

  if (compErr) {
    console.error('[computo/save]', compErr.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  // Costruisci mappa codice → id per le categorie (per risolvere parent_id)
  const codiceToId = {};
  const toInsert   = [];

  // Prima passata: categorie
  for (const v of voci.filter(v => v.tipo === 'categoria')) {
    const row = {
      computo_id:   computo.id,
      company_id:   companyId,
      site_id:      siteId,
      tipo:         'categoria',
      parent_id:    null,
      sort_order:   v.sort_order ?? 0,
      codice:       v.codice || null,
      descrizione:  String(v.descrizione).slice(0, 500),
      sal_percentuale: 0,
    };
    const { data: saved } = await supabase.from('site_computo_voci').insert(row).select('id, codice').single();
    if (saved && v.codice) codiceToId[v.codice] = saved.id;
    toInsert.push(saved);
  }

  // Seconda passata: voci (in batch)
  const vociRows = voci
    .filter(v => v.tipo === 'voce')
    .map(v => ({
      computo_id:      computo.id,
      company_id:      companyId,
      site_id:         siteId,
      tipo:            'voce',
      parent_id:       v.parent_codice ? (codiceToId[v.parent_codice] || null) : null,
      sort_order:      v.sort_order ?? 0,
      codice:          v.codice || null,
      descrizione:     String(v.descrizione).slice(0, 500),
      unita_misura:    v.unita_misura || null,
      quantita:        v.quantita    != null ? Number(v.quantita)         : null,
      prezzo_unitario: v.prezzo_unitario != null ? Number(v.prezzo_unitario) : null,
      importo:         v.importo     != null ? Number(v.importo)          : null,
      sal_percentuale: 0,
    }));

  if (vociRows.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < vociRows.length; i += BATCH) {
      const { error } = await supabase.from('site_computo_voci').insert(vociRows.slice(i, i + BATCH));
      if (error) console.error('[computo/voci-batch]', error.message);
    }
  }

  res.status(201).json({
    id:               computo.id,
    nome:             computo.nome,
    totale_contratto: computo.totale_contratto,
    n_categorie:      voci.filter(v => v.tipo === 'categoria').length,
    n_voci:           vociRows.length,
  });
});

// ── GET /api/v1/sites/:siteId/computo/export.pdf ──────────────
// Genera PDF "SAL — Stato Avanzamento Lavori" stile Palladia.

router.get('/sites/:siteId/computo/export.pdf', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  if (!isUuid(siteId)) return res.status(400).json({ error: 'INVALID_SITE_ID' });

  // Carica computo
  const { data: computo } = await supabase
    .from('site_computo')
    .select('id, nome, fonte, totale_contratto, created_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!computo) return res.status(404).json({ error: 'COMPUTO_NOT_FOUND' });

  // Carica voci
  const { data: voci } = await supabase
    .from('site_computo_voci')
    .select('id, parent_id, tipo, sort_order, codice, descrizione, unita_misura, quantita, prezzo_unitario, importo, sal_percentuale, sal_note')
    .eq('computo_id', computo.id)
    .order('sort_order', { ascending: true });

  // Carica info cantiere e azienda per la cover
  const { data: site } = await supabase
    .from('sites')
    .select('name, address')
    .eq('id', siteId)
    .maybeSingle();

  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle();

  try {
    const pdfBuffer = await generateComputoPdf({
      computo,
      voci: voci || [],
      site,
      company,
    });

    const safeName = (computo.nome || 'computo').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="SAL_${safeName}.pdf"`,
      'Content-Length':      pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[computo/export.pdf]', err.message);
    res.status(500).json({ error: 'PDF_GENERATION_FAILED', detail: err.message });
  }
});

// ── GET /api/v1/sites/:siteId/computo ─────────────────────────
// Recupera il computo attivo con tutte le voci.

router.get('/sites/:siteId/computo', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  if (!isUuid(siteId)) return res.status(400).json({ error: 'INVALID_SITE_ID' });

  const { data: computo } = await supabase
    .from('site_computo')
    .select('id, nome, fonte, totale_contratto, created_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!computo) return res.json(null);

  const { data: voci } = await supabase
    .from('site_computo_voci')
    .select('id, parent_id, tipo, sort_order, codice, descrizione, unita_misura, quantita, prezzo_unitario, importo, sal_percentuale, sal_note, updated_at')
    .eq('computo_id', computo.id)
    .order('sort_order', { ascending: true });

  // Calcola importo maturato totale
  const allVoci = voci || [];
  const importoMaturato = allVoci
    .filter(v => v.tipo === 'voce')
    .reduce((s, v) => s + (Number(v.importo) || 0) * (Number(v.sal_percentuale) || 0) / 100, 0);

  res.json({
    ...computo,
    importo_maturato: Math.round(importoMaturato * 100) / 100,
    voci:             allVoci,
  });
});

// ── PATCH /api/v1/computo/voci/:voceId/sal ────────────────────
// Aggiorna SAL% di una singola voce (real-time dal frontend).

router.patch('/computo/voci/:voceId/sal', validate(patchVoceSalSchema), async (req, res) => {
  const { companyId }  = req;
  const { voceId }     = req.params;
  const { sal_percentuale, sal_note } = req.body;

  if (!isUuid(voceId)) return res.status(400).json({ error: 'INVALID_ID' });

  const sal = parseFloat(sal_percentuale);
  if (isNaN(sal) || sal < 0 || sal > 100)
    return res.status(400).json({ error: 'sal_percentuale deve essere 0–100' });

  const patch = { sal_percentuale: sal };
  if (sal_note !== undefined) patch.sal_note = sal_note ? String(sal_note).slice(0, 500) : null;

  const { error } = await supabase
    .from('site_computo_voci')
    .update(patch)
    .eq('id', voceId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true, sal_percentuale: sal });
});

// ── DELETE /api/v1/sites/:siteId/computo/:id ──────────────────

router.delete('/sites/:siteId/computo/:id', async (req, res) => {
  const { companyId }       = req;
  const { siteId, id }      = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase
    .from('site_computo')
    .delete()
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL' });
  res.json({ ok: true });
});

module.exports = router;
