'use strict';
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { parseCapitolatoPDF } = require('../../services/capitolatoParser');

const BUCKET   = 'site-documents';
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo file PDF accettati.'));
  },
});

async function requireSiteOwnership(siteId, companyId, res) {
  const { data } = await supabase.from('sites').select('id, name')
    .eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return null; }
  return data;
}

// ── POST /api/v1/sites/:siteId/capitolato ────────────────────────────────────
// Upload capitolato PDF → parsing AI → salva voci strutturate.
// Risponde via SSE per mostrare avanzamento.
router.post('/sites/:siteId/capitolato',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { siteId } = req.params;
    const site = await requireSiteOwnership(siteId, req.companyId, res);
    if (!site) return;

    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (type, payload) => {
      res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };

    try {
      send('progress', { message: 'Caricamento file…', percent: 5 });

      // 1. Salva PDF in site-documents bucket
      const storagePath = `${req.companyId}/${siteId}/capitolato-${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET).upload(storagePath, req.file.buffer, {
          contentType: 'application/pdf', upsert: true,
        });
      if (upErr) { send('error', { message: 'Errore caricamento file.' }); res.end(); return; }

      send('progress', { message: 'File salvato. Avvio lettura capitolato…', percent: 15 });

      // 2. Parsing AI (può richiedere 30-60 secondi per capitolati lunghi)
      const { voci, summary, totalCategorie, importoTotale } =
        await parseCapitolatoPDF(req.file.buffer, siteId, req.companyId, (msg, pct) => {
          send('progress', { message: msg, percent: pct });
        });

      send('progress', { message: `Trovate ${voci.length} voci in ${totalCategorie} categorie. Salvataggio…`, percent: 80 });

      // 3. Elimina voci precedenti (se ri-caricamento) e inserisce le nuove
      await supabase.from('capitolato_voci').delete()
        .eq('site_id', siteId).eq('company_id', req.companyId);

      if (voci.length > 0) {
        const rows = voci.map((v, i) => ({
          company_id:        req.companyId,
          site_id:           siteId,
          codice:            v.codice       || null,
          categoria:         v.categoria,
          descrizione:       v.descrizione,
          unita_misura:      v.unita_misura || null,
          quantita:          v.quantita     || null,
          prezzo_unitario:   v.prezzo_unitario || null,
          importo_contratto: v.importo_contratto || null,
          sort_order:        i,
        }));
        const { error: insErr } = await supabase.from('capitolato_voci').insert(rows);
        if (insErr) { send('error', { message: 'Errore salvataggio voci.' }); res.end(); return; }
      }

      // 4. Aggiorna ladia_site_config con il summary
      await supabase.from('ladia_site_config').upsert({
        company_id:         req.companyId,
        site_id:            siteId,
        capitolato_summary: summary,
      }, { onConflict: 'site_id' });

      send('progress', { message: 'Capitolato processato con successo!', percent: 100 });
      send('done', {
        voci_count:      voci.length,
        categorie_count: totalCategorie,
        importo_totale:  importoTotale,
        summary,
        storage_path:    storagePath,
      });

    } catch (err) {
      console.error('[capitolato] parsing error:', err.message);
      send('error', { message: err.message || 'Errore durante il parsing del capitolato.' });
    }

    res.end();
  }
);

// ── GET /api/v1/sites/:siteId/capitolato ─────────────────────────────────────
// Restituisce le voci estratte dal capitolato, raggruppate per categoria.
router.get('/sites/:siteId/capitolato', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const site = await requireSiteOwnership(siteId, req.companyId, res);
  if (!site) return;

  const [vociRes, cfgRes] = await Promise.all([
    supabase.from('capitolato_voci')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order').order('created_at'),
    supabase.from('ladia_site_config')
      .select('capitolato_summary')
      .eq('site_id', siteId).maybeSingle(),
  ]);

  const voci = vociRes.data || [];

  // Raggruppa per categoria
  const byCategoria = {};
  for (const v of voci) {
    if (!byCategoria[v.categoria]) byCategoria[v.categoria] = { voci: [], totale: 0 };
    byCategoria[v.categoria].voci.push(v);
    byCategoria[v.categoria].totale += parseFloat(v.importo_contratto) || 0;
  }

  const categorie = Object.entries(byCategoria).map(([nome, data]) => ({
    nome,
    voci:    data.voci,
    totale:  data.totale,
  }));

  const importoTotale = voci.reduce((s, v) => s + (parseFloat(v.importo_contratto) || 0), 0);

  res.json({
    voci,
    categorie,
    importo_totale: importoTotale,
    summary:        cfgRes.data?.capitolato_summary || null,
  });
});

// ── DELETE /api/v1/sites/:siteId/capitolato ──────────────────────────────────
// Cancella tutte le voci estratte (per ri-caricare il capitolato).
router.delete('/sites/:siteId/capitolato', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const site = await requireSiteOwnership(siteId, req.companyId, res);
  if (!site) return;

  const { error } = await supabase.from('capitolato_voci').delete()
    .eq('site_id', siteId).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
