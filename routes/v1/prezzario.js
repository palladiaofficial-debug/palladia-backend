'use strict';
const router   = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// ── GET /api/v1/prezzario/regioni ─────────────────────────────────────────────
// Restituisce regioni e anni disponibili nel prezzario.
router.get('/prezzario/regioni', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('prezzario_voci')
    .select('regione, anno')
    .order('regione')
    .order('anno', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Deduplica
  const seen = new Set();
  const regioni = [];
  for (const r of (data || [])) {
    const key = `${r.regione}|${r.anno}`;
    if (!seen.has(key)) { seen.add(key); regioni.push(r); }
  }
  res.json({ regioni });
});

// ── GET /api/v1/prezzario/search ──────────────────────────────────────────────
// Ricerca full-text nel prezzario regionale.
// Query params: q (testo), regione (default: liguria), anno (default: ultimo disponibile),
//               categoria, limit (default: 10, max: 50)
router.get('/prezzario/search', verifySupabaseJwt, async (req, res) => {
  const q        = (req.query.q || '').trim();
  const regione  = (req.query.regione || 'liguria').toLowerCase();
  const categoria = req.query.categoria;
  const limit    = Math.min(parseInt(req.query.limit) || 10, 50);

  // Determina anno: richiesto o l'ultimo disponibile per la regione
  let anno = req.query.anno ? parseInt(req.query.anno) : null;
  if (!anno) {
    const { data: latest } = await supabase
      .from('prezzario_voci')
      .select('anno')
      .eq('regione', regione)
      .order('anno', { ascending: false })
      .limit(1)
      .maybeSingle();
    anno = latest?.anno || null;
  }

  if (!anno) return res.json({ voci: [], total: 0, regione, anno: null });

  // Ricerca: full-text se query presente, altrimenti per categoria
  let query = supabase
    .from('prezzario_voci')
    .select('id, codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli, note')
    .eq('regione', regione)
    .eq('anno', anno)
    .limit(limit);

  if (q) {
    // Usa full-text search con plainto_tsquery (gestisce automaticamente plurali italiani)
    query = query.textSearch('descrizione_tsv', q, {
      type: 'plain',
      config: 'italian',
    });
  }

  if (categoria) {
    query = query.ilike('categoria', `%${categoria}%`);
  }

  if (!q && !categoria) {
    query = query.order('categoria').order('codice');
  }

  const { data, error } = await query;
  if (error) {
    // Fallback ILIKE se FTS fallisce (es. parola troppo corta)
    const fallback = await supabase
      .from('prezzario_voci')
      .select('id, codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli, note')
      .eq('regione', regione)
      .eq('anno', anno)
      .ilike('descrizione', `%${q}%`)
      .limit(limit);

    if (fallback.error) return res.status(500).json({ error: fallback.error.message });
    return res.json({ voci: fallback.data, total: fallback.data.length, regione, anno });
  }

  res.json({ voci: data, total: data.length, regione, anno });
});

// ── GET /api/v1/prezzario/categorie ──────────────────────────────────────────
// Lista categorie disponibili per una regione/anno.
router.get('/prezzario/categorie', verifySupabaseJwt, async (req, res) => {
  const regione = (req.query.regione || 'liguria').toLowerCase();
  const anno    = req.query.anno ? parseInt(req.query.anno) : null;

  let query = supabase
    .from('prezzario_voci')
    .select('categoria')
    .eq('regione', regione);

  if (anno) query = query.eq('anno', anno);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const categorie = [...new Set((data || []).map(r => r.categoria))].sort();
  res.json({ categorie, regione, anno });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PREZZI FORNITORI AZIENDA (company_prezzi) — JWT protetto
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/company-prezzi ────────────────────────────────────────────────
// Lista/ricerca prezzi fornitori dell'azienda.
router.get('/company-prezzi', verifySupabaseJwt, async (req, res) => {
  const q       = (req.query.q || '').trim();
  const limit   = Math.min(parseInt(req.query.limit) || 20, 100);

  let query = supabase
    .from('company_prezzi')
    .select('id, descrizione, fornitore, um, prezzo, categoria, valid_from, valid_to, note')
    .eq('company_id', req.companyId)
    .order('categoria')
    .order('descrizione')
    .limit(limit);

  if (q) {
    query = query.textSearch('descrizione_tsv', q, { type: 'plain', config: 'italian' });
  }

  const { data, error } = await query;

  if (error && q) {
    // Fallback ILIKE
    const { data: fb, error: fbErr } = await supabase
      .from('company_prezzi')
      .select('id, descrizione, fornitore, um, prezzo, categoria, valid_from, valid_to, note')
      .eq('company_id', req.companyId)
      .ilike('descrizione', `%${q}%`)
      .limit(limit);
    if (fbErr) return res.status(500).json({ error: fbErr.message });
    return res.json({ prezzi: fb, total: fb.length });
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ prezzi: data, total: data.length });
});

// ── POST /api/v1/company-prezzi ───────────────────────────────────────────────
router.post('/company-prezzi', verifySupabaseJwt, async (req, res) => {
  const { descrizione, fornitore, um, prezzo, categoria, valid_from, valid_to, note } = req.body;

  if (!descrizione || !um || prezzo == null) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['descrizione', 'um', 'prezzo'] });
  }

  const prezzoNum = parseFloat(prezzo);
  if (isNaN(prezzoNum) || prezzoNum < 0) {
    return res.status(400).json({ error: 'INVALID_PRICE' });
  }

  const { data, error } = await supabase
    .from('company_prezzi')
    .insert({
      company_id: req.companyId,
      descrizione: descrizione.trim(),
      fornitore:   fornitore?.trim() || null,
      um:          um.trim(),
      prezzo:      prezzoNum,
      categoria:   categoria?.trim() || null,
      valid_from:  valid_from || null,
      valid_to:    valid_to   || null,
      note:        note?.trim() || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── PATCH /api/v1/company-prezzi/:id ─────────────────────────────────────────
router.patch('/company-prezzi/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  const allowed = ['descrizione', 'fornitore', 'um', 'prezzo', 'categoria', 'valid_from', 'valid_to', 'note'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS' });
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('company_prezzi')
    .update(updates)
    .eq('id', id)
    .eq('company_id', req.companyId)  // sicurezza: solo la propria azienda
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

// ── DELETE /api/v1/company-prezzi/:id ────────────────────────────────────────
router.delete('/company-prezzi/:id', verifySupabaseJwt, async (req, res) => {
  const { error } = await supabase
    .from('company_prezzi')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
