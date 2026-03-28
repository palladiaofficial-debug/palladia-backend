'use strict';
/**
 * routes/v1/economia.js
 * SAL — Stato Avanzamento Lavori: budget, costi, ricavi per cantiere.
 *
 * GET    /api/v1/sites/:siteId/economia           — riepilogo + voci
 * PATCH  /api/v1/sites/:siteId/economia/settings  — aggiorna budget + SAL %
 * POST   /api/v1/sites/:siteId/economia/voci      — aggiungi voce
 * PATCH  /api/v1/sites/:siteId/economia/voci/:id  — modifica voce
 * DELETE /api/v1/sites/:siteId/economia/voci/:id  — elimina voce
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Verifica che il cantiere appartenga alla company dell'utente
async function resolveSite(siteId, companyId) {
  if (!isUuid(siteId)) return null;
  const { data } = await supabase
    .from('sites')
    .select('id, budget_totale, sal_percentuale')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();
  return data;
}

// ── GET /api/v1/sites/:siteId/economia ───────────────────────────────────────

router.get('/sites/:siteId/economia', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: voci, error } = await supabase
    .from('site_economia_voci')
    .select('id, tipo, categoria, voce, importo, data_competenza, note, created_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('data_competenza', { ascending: false })
    .order('created_at',      { ascending: false });

  if (error) {
    console.error('[economia/get]', error.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  const costi   = (voci || []).filter(v => v.tipo === 'costo');
  const ricavi  = (voci || []).filter(v => v.tipo === 'ricavo');
  const totCosti  = costi.reduce((s, v)  => s + Number(v.importo), 0);
  const totRicavi = ricavi.reduce((s, v) => s + Number(v.importo), 0);
  const utile     = totRicavi - totCosti;

  // Aggregazione per categoria
  const costiPerCategoria   = {};
  const ricaviPerCategoria  = {};
  costi.forEach(v  => { costiPerCategoria[v.categoria]  = (costiPerCategoria[v.categoria]  || 0) + Number(v.importo); });
  ricavi.forEach(v => { ricaviPerCategoria[v.categoria] = (ricaviPerCategoria[v.categoria] || 0) + Number(v.importo); });

  res.json({
    settings: {
      budget_totale:   site.budget_totale   !== null ? Number(site.budget_totale)   : null,
      sal_percentuale: site.sal_percentuale !== null ? Number(site.sal_percentuale) : 0,
    },
    summary: {
      totale_costi:  totCosti,
      totale_ricavi: totRicavi,
      utile,
      margine_percentuale: totRicavi > 0 ? Math.round((utile / totRicavi) * 100) : null,
    },
    voci: voci || [],
    costi_per_categoria:  costiPerCategoria,
    ricavi_per_categoria: ricaviPerCategoria,
  });
});

// ── PATCH /api/v1/sites/:siteId/economia/settings ────────────────────────────

router.patch('/sites/:siteId/economia/settings', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { budget_totale, sal_percentuale } = req.body;

  const patch = {};

  if (budget_totale !== undefined) {
    const n = parseFloat(budget_totale);
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'budget_totale non valido' });
    patch.budget_totale = n;
  }

  if (sal_percentuale !== undefined) {
    const n = parseFloat(sal_percentuale);
    if (isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'sal_percentuale deve essere 0–100' });
    patch.sal_percentuale = n;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  const { error } = await supabase.from('sites').update(patch).eq('id', siteId).eq('company_id', companyId);
  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true, ...patch });
});

// ── POST /api/v1/sites/:siteId/economia/voci ─────────────────────────────────

router.post('/sites/:siteId/economia/voci', async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { tipo, categoria, voce, importo, data_competenza, note } = req.body;

  if (!['costo', 'ricavo'].includes(tipo))
    return res.status(400).json({ error: 'tipo deve essere costo o ricavo' });
  if (!categoria || !String(categoria).trim())
    return res.status(400).json({ error: 'categoria obbligatoria' });
  if (!voce || !String(voce).trim())
    return res.status(400).json({ error: 'voce obbligatoria' });

  const imp = parseFloat(importo);
  if (isNaN(imp) || imp <= 0)
    return res.status(400).json({ error: 'importo deve essere > 0' });

  if (data_competenza && !/^\d{4}-\d{2}-\d{2}$/.test(data_competenza))
    return res.status(400).json({ error: 'data_competenza deve essere YYYY-MM-DD' });

  const { data: voce_creata, error } = await supabase
    .from('site_economia_voci')
    .insert({
      company_id:      companyId,
      site_id:         siteId,
      tipo,
      categoria:       String(categoria).trim(),
      voce:            String(voce).trim().slice(0, 300),
      importo:         imp,
      data_competenza: data_competenza || new Date().toISOString().slice(0, 10),
      note:            note ? String(note).trim().slice(0, 1000) : null,
      created_by:      user.id,
    })
    .select()
    .single();

  if (error) {
    console.error('[economia/post-voce]', error.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  res.status(201).json(voce_creata);
});

// ── PATCH /api/v1/sites/:siteId/economia/voci/:id ────────────────────────────

router.patch('/sites/:siteId/economia/voci/:id', async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const patch = {};
  const { tipo, categoria, voce, importo, data_competenza, note } = req.body;

  if (tipo !== undefined) {
    if (!['costo', 'ricavo'].includes(tipo)) return res.status(400).json({ error: 'tipo non valido' });
    patch.tipo = tipo;
  }
  if (categoria !== undefined) patch.categoria = String(categoria).trim();
  if (voce      !== undefined) patch.voce      = String(voce).trim().slice(0, 300);
  if (note      !== undefined) patch.note       = note ? String(note).trim().slice(0, 1000) : null;
  if (importo   !== undefined) {
    const imp = parseFloat(importo);
    if (isNaN(imp) || imp <= 0) return res.status(400).json({ error: 'importo deve essere > 0' });
    patch.importo = imp;
  }
  if (data_competenza !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_competenza)) return res.status(400).json({ error: 'data_competenza YYYY-MM-DD' });
    patch.data_competenza = data_competenza;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  const { error } = await supabase
    .from('site_economia_voci')
    .update(patch)
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true });
});

// ── DELETE /api/v1/sites/:siteId/economia/voci/:id ───────────────────────────

router.delete('/sites/:siteId/economia/voci/:id', async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase
    .from('site_economia_voci')
    .delete()
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true });
});

module.exports = router;
