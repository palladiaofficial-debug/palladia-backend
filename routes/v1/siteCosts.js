'use strict';
const path      = require('path');
const multer    = require('multer');
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { patchCostSchema } = require('../../lib/schemas/siteCosts');
const { sendDbError } = require('../../lib/httpErrors');
const { extractSiteCostFromDocument } = require('../../lib/siteCostOcr');

const BUCKET   = 'site-media';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Usa PDF o immagini (JPG, PNG, WEBP, HEIC).'));
  },
});

async function requireSiteOwnership(siteId, companyId, res) {
  const { data } = await supabase.from('sites').select('id')
    .eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return false; }
  return true;
}

// ── GET /api/v1/sites/:siteId/costs ──────────────────────────────────────────
// Lista costi con aggregati per fase + confronto capitolato.
router.get('/sites/:siteId/costs', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;

  const [costsRes, phasesRes] = await Promise.all([
    supabase.from('site_costs')
      .select('*, subcontractor:subcontractor_id(id, company_name)')
      .eq('site_id', siteId)
      .order('data_documento', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('site_phases')
      .select('id, nome, importo_contratto')
      .eq('site_id', siteId),
  ]);

  const costs  = costsRes.data  || [];
  const phases = phasesRes.data || [];

  // Aggregati per fase
  const byPhase = {};
  for (const c of costs) {
    const key = c.phase_id || '__nofase';
    if (!byPhase[key]) byPhase[key] = 0;
    byPhase[key] += parseFloat(c.importo) || 0;
  }

  // Arricchisci fasi con totale costi e flag sforamento
  const phasesSummary = phases.map(p => ({
    id:                p.id,
    nome:              p.nome,
    importo_contratto: parseFloat(p.importo_contratto) || 0,
    costi_reali:       byPhase[p.id] || 0,
    sforamento:        p.importo_contratto != null &&
                       (byPhase[p.id] || 0) > parseFloat(p.importo_contratto),
  }));

  const totale = costs.reduce((s, c) => s + (parseFloat(c.importo) || 0), 0);

  // Genera signed URL per file allegati
  const costsWithUrls = await Promise.all(costs.map(async c => {
    if (!c.file_url) return c;
    try {
      const { data: signed } = await supabase.storage.from(BUCKET)
        .createSignedUrl(c.file_url, 3600);
      return { ...c, file_signed_url: signed?.signedUrl || null };
    } catch { return c; }
  }));

  res.json({ costs: costsWithUrls, phases_summary: phasesSummary, totale });
});

// ── POST /api/v1/sites/:siteId/costs ─────────────────────────────────────────
// Aggiungi costo (form JSON o con allegato foto/PDF fattura).
router.post('/sites/:siteId/costs',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { siteId } = req.params;
    if (!await requireSiteOwnership(siteId, req.companyId, res)) return;

    const body = req.body;
    if (!body.descrizione?.trim()) return res.status(400).json({ error: 'MISSING_DESCRIZIONE' });

    // F-220 (AUDIT.md): un DDT quasi mai ha un prezzo (le merci arrivano
    // prima della fattura di riscontro) — stesso principio già stabilito per
    // il flusso badge (routes/v1/badgeDdt.js, F-213) e per la colonna DB
    // (site_costs.importo nullable dalla migrazione 221): qui, l'unico altro
    // punto che crea righe manualmente, il vincolo imponeva comunque un
    // valore inventato. Per ogni altro tipo l'importo resta obbligatorio.
    const tipo = body.tipo || 'fattura';
    const importoProvided = body.importo !== undefined && body.importo !== null && String(body.importo).trim() !== '';
    if (importoProvided && isNaN(parseFloat(body.importo)))
      return res.status(400).json({ error: 'MISSING_IMPORTO' });
    if (tipo !== 'ddt' && !importoProvided)
      return res.status(400).json({ error: 'MISSING_IMPORTO' });

    let file_url = null;
    if (req.file) {
      const ext  = path.extname(req.file.originalname) || '.jpg';
      const name = `${req.companyId}/${siteId}/costi/${Date.now()}${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET).upload(name, req.file.buffer, { contentType: req.file.mimetype });
      if (!uploadErr) file_url = name;
    }

    // F-188 (AUDIT.md): subcontractor_id opzionale — collega il costo a un
    // subappaltatore REALE (non solo al testo libero `fornitore`) per poterlo
    // sommare in modo affidabile nella sua vista economia. Validato: deve
    // essere un subappaltatore della stessa company assegnato a QUESTO
    // cantiere — mai un id preso a caso da un'altra scheda.
    let subcontractorId = null;
    if (isUuid(body.subcontractor_id)) {
      const { data: assigned } = await supabase
        .from('site_subcontractors')
        .select('subcontractor_id')
        .eq('site_id', siteId).eq('company_id', req.companyId).eq('subcontractor_id', body.subcontractor_id)
        .maybeSingle();
      if (!assigned) return res.status(400).json({ error: 'SUBCONTRACTOR_NOT_ASSIGNED', message: 'Il subappaltatore indicato non è assegnato a questo cantiere.' });
      subcontractorId = body.subcontractor_id;
    }

    const { data, error } = await supabase.from('site_costs').insert({
      company_id:         req.companyId,
      site_id:            siteId,
      phase_id:           isUuid(body.phase_id) ? body.phase_id : null,
      capitolato_voce_id: isUuid(body.capitolato_voce_id) ? body.capitolato_voce_id : null,
      subcontractor_id:   subcontractorId,
      descrizione:        body.descrizione.trim(),
      fornitore:          body.fornitore?.trim() || null,
      quantita:           body.quantita   ? parseFloat(body.quantita)   : null,
      unita_misura:       body.unita_misura?.trim() || null,
      prezzo_unitario:    body.prezzo_unitario ? parseFloat(body.prezzo_unitario) : null,
      importo:            importoProvided ? parseFloat(body.importo) : null,
      data_documento:     body.data_documento || null,
      tipo,
      numero_documento:   body.numero_documento?.trim() || null,
      file_url,
      categoria:          body.categoria?.trim() || null,
      note:               body.note?.trim() || null,
      created_by:         `web:${req.user.id}`,
    }).select().single();

    if (error) return sendDbError(res, error);
    res.status(201).json(data);
  }
);

// ── PATCH /api/v1/sites/:siteId/costs/:costId ────────────────────────────────
router.patch('/sites/:siteId/costs/:costId', verifySupabaseJwt, validate(patchCostSchema), async (req, res) => {
  const { siteId, costId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
  if (!isUuid(costId)) return res.status(400).json({ error: 'INVALID_COST_ID' });

  const allowed = ['descrizione', 'fornitore', 'quantita', 'unita_misura', 'prezzo_unitario',
                   'importo', 'data_documento', 'tipo', 'numero_documento', 'phase_id',
                   'capitolato_voce_id', 'categoria', 'note', 'pagato_il'];
  const numeric = new Set(['quantita', 'prezzo_unitario', 'importo']);
  const nullable = new Set(['pagato_il', 'data_documento', 'fornitore', 'numero_documento',
                            'note', 'categoria', 'phase_id', 'capitolato_voce_id', 'unita_misura']);
  const updates = {};
  for (const k of allowed) {
    if (!(k in req.body)) continue;
    if (numeric.has(k)) {
      const n = parseFloat(req.body[k]);
      updates[k] = isNaN(n) ? null : n;
    } else if (nullable.has(k)) {
      updates[k] = req.body[k] || null;
    } else {
      updates[k] = req.body[k] || null;
    }
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'NO_UPDATES' });

  const { data, error } = await supabase.from('site_costs')
    .update(updates)
    .eq('id', costId).eq('site_id', siteId).eq('company_id', req.companyId)
    .select().single();

  if (error) return sendDbError(res, error);
  if (!data)  return res.status(404).json({ error: 'COST_NOT_FOUND' });
  res.json(data);
});

// ── DELETE /api/v1/sites/:siteId/costs/:costId ───────────────────────────────
router.delete('/sites/:siteId/costs/:costId', verifySupabaseJwt, async (req, res) => {
  const { siteId, costId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
  if (!isUuid(costId)) return res.status(400).json({ error: 'INVALID_COST_ID' });

  // Recupera file_url prima di eliminare per rimuoverlo dallo storage
  const { data: row } = await supabase.from('site_costs')
    .select('file_url').eq('id', costId).eq('company_id', req.companyId).maybeSingle();

  const { error } = await supabase.from('site_costs')
    .delete().eq('id', costId).eq('site_id', siteId).eq('company_id', req.companyId);

  if (error) return sendDbError(res, error);

  // Rimuovi file allegato dallo storage (fire-and-forget)
  if (row?.file_url) {
    supabase.storage.from(BUCKET).remove([row.file_url])
      .catch(e => console.error('[siteCosts] storage remove error:', e.message));
  }

  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/costs/ocr ─────────────────────────────────────
// Legge una fattura (PDF o immagine) con Claude Vision e restituisce i campi
// pre-compilati. Non salva nulla — il frontend usa i dati per riempire il form.
router.post('/sites/:siteId/costs/ocr',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { siteId } = req.params;
    if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    try {
      const fields = await extractSiteCostFromDocument(req.file.buffer, req.file.mimetype, {
        companyId: req.companyId, userId: req.user?.id, callSite: 'site_costs_ocr',
      });
      res.json(fields);
    } catch (err) {
      console.error('[siteCosts/ocr] AI error:', err?.message || err);
      res.status(500).json({ error: 'OCR_FAILED', message: 'Impossibile leggere il documento.' });
    }
  }
);

module.exports = router;
