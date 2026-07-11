'use strict';
const multer   = require('multer');
const router   = require('express').Router();
const supabase  = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { createCompanyPrezzoSchema, patchCompanyPrezzoSchema } = require('../../lib/schemas/prezzario');
const { aiLimiter } = require('../../middleware/rateLimit');
const { logUsage } = require('../../lib/ladiaUsageLog');

let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['application/pdf','image/jpeg','image/png','image/webp','image/heic'];
    if (ok.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Usa PDF o immagini (JPG, PNG, WEBP, HEIC).'));
  },
});

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
// Cache anno per regione — evita query ripetuta ad ogni ricerca
const _annoCache = {};
router.get('/prezzario/search', verifySupabaseJwt, async (req, res) => {
  const q        = (req.query.q || '').trim();
  const regione  = (req.query.regione || 'liguria').toLowerCase();
  const categoria = req.query.categoria;
  const limit    = Math.min(parseInt(req.query.limit) || 10, 50);

  let anno = req.query.anno ? parseInt(req.query.anno) : null;
  if (!anno) {
    if (_annoCache[regione]) {
      anno = _annoCache[regione];
    } else {
      const { data: latest } = await supabase
        .from('prezzario_voci')
        .select('anno')
        .eq('regione', regione)
        .order('anno', { ascending: false })
        .limit(1)
        .maybeSingle();
      anno = latest?.anno || null;
      if (anno) _annoCache[regione] = anno;
    }
  }

  if (!anno) return res.json({ voci: [], total: 0, regione, anno: null });

  let query = supabase
    .from('prezzario_voci')
    .select('id, codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli, note')
    .eq('regione', regione)
    .eq('anno', anno)
    .limit(limit);

  if (q) {
    query = query.textSearch('descrizione_tsv', q, {
      type: 'plain',
      config: 'italian',
    });
  }

  if (categoria) {
    query = query.eq('categoria', categoria);
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
router.post('/company-prezzi', verifySupabaseJwt, validate(createCompanyPrezzoSchema), async (req, res) => {
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
router.patch('/company-prezzi/:id', verifySupabaseJwt, validate(patchCompanyPrezzoSchema), async (req, res) => {
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

// ── POST /api/v1/company-prezzi/bulk ─────────────────────────────────────────
// Salva più voci in una volta sola (dopo la review del parsing AI).
router.post('/company-prezzi/bulk', verifySupabaseJwt, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'MISSING_ITEMS' });
  if (items.length > 500)
    return res.status(400).json({ error: 'TOO_MANY_ITEMS', max: 500 });

  const today = new Date().toISOString().split('T')[0];
  const rows = items
    .filter(it => it.descrizione?.trim() && it.prezzo != null && !isNaN(parseFloat(it.prezzo)))
    .map(it => ({
      company_id: req.companyId,
      descrizione: it.descrizione.trim().slice(0, 300),
      fornitore:   it.fornitore?.trim().slice(0, 100) || null,
      um:          it.um?.trim().slice(0, 20)         || null,
      prezzo:      parseFloat(it.prezzo),
      categoria:   it.categoria?.trim()               || null,
      note:        it.note?.trim()                    || null,
      valid_from:  today,
    }));

  if (rows.length === 0) return res.status(400).json({ error: 'NO_VALID_ITEMS' });

  const { data, error } = await supabase.from('company_prezzi').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ saved: data.length, items: data });
});

// ── POST /api/v1/company-prezzi/parse-offerta ─────────────────────────────────
// Carica un'offerta/preventivo fornitore (PDF o immagine) → AI estrae tutte
// le righe di prezzo → ritorna array per review utente (NON salva nulla).
router.post('/company-prezzi/parse-offerta',
  verifySupabaseJwt,
  aiLimiter,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const buf  = req.file.buffer;
    const mime = req.file.mimetype;
    const b64  = buf.toString('base64');
    const isPdf = mime === 'application/pdf';

    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime,               data: b64 } };

    const prompt = `Analizza questo documento (offerta, preventivo o listino prezzi di un fornitore edile).
Estrai TUTTE le voci di prezzo unitario presenti, ignorando subtotali e totali complessivi.

Per ogni voce restituisci:
- descrizione: descrizione del materiale/prodotto/servizio (chiara, max 200 caratteri)
- um: unità di misura (mq, ml, m², m³, pz, kg, t, ora, g, mc, l, set) — null se assente
- prezzo: prezzo UNITARIO come numero decimale con punto (es. 42.50). null se non leggibile.
- categoria: scegli tra Materiali | Manodopera | Noli | Trasporti | Subappalto | Forniture | Altro

Rispondi SOLO con questo JSON (nessun testo fuori):
{
  "fornitore": "Nome Fornitore Srl o null",
  "data_offerta": "YYYY-MM-DD o null",
  "items": [
    { "descrizione": "...", "um": "mq", "prezzo": 42.50, "categoria": "Materiali" }
  ]
}

Includi solo righe con prezzo unitario numerico leggibile. Max 300 voci.`;

    try {
      const msg = await getAI().messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages:   [{ role: 'user', content: [fileBlock, { type: 'text', text: prompt }] }],
      });
      logUsage({ companyId: req.companyId, userId: req.user?.id, model: 'claude-haiku-4-5-20251001', callSite: 'prezzario_parse_offerta', usage: msg.usage });

      const raw  = msg.content.find(b => b.type === 'text')?.text?.trim() || '{}';
      const json = raw.startsWith('```') ? raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim() : raw;
      const parsed = JSON.parse(json);

      const CATEGORIE = ['Materiali','Manodopera','Noli','Trasporti','Subappalto','Forniture','Altro'];
      const items = (parsed.items || [])
        .filter(it => it.descrizione?.trim() && it.prezzo != null && !isNaN(parseFloat(it.prezzo)))
        .map(it => ({
          descrizione: it.descrizione.trim().slice(0, 200),
          um:          it.um?.trim() || null,
          prezzo:      parseFloat(it.prezzo),
          categoria:   CATEGORIE.includes(it.categoria) ? it.categoria : 'Altro',
          fornitore:   (it.fornitore || parsed.fornitore || '').trim().slice(0, 100) || null,
        }));

      if (items.length === 0)
        return res.status(422).json({ error: 'NO_ITEMS', message: 'Nessun prezzo unitario leggibile nel documento.' });

      res.json({
        fornitore:    parsed.fornitore || null,
        data_offerta: parsed.data_offerta || null,
        items,
      });
    } catch (err) {
      console.error('[prezzario/parse-offerta]', err?.message || err);
      res.status(500).json({ error: 'PARSE_FAILED', message: 'Errore AI. Riprova.' });
    }
  }
);

module.exports = router;
