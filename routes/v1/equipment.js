'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const multer    = require('multer');
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },  // 10 MB
});

const TYPE_ICONS = {
  'Escavatore':       '🚜',
  'Gru':              '🏗️',
  'Ponteggio':        '🧱',
  'Autocarro':        '🚛',
  'Betoniera':        '🔄',
  'Autovettura':      '🚗',
  'Furgone':          '🚐',
  'Motociclo/Scooter':'🛵',
  'Trattore':         '🚜',
  'Sollevatore':      '🔼',
  'Altro':            '🔧',
};

function calcStatus(row) {
  const today = new Date().toISOString().slice(0, 10);
  const in30  = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const dates = [row.inspection_date, row.insurance_expiry, row.maintenance_date].filter(Boolean);
  if (dates.some(d => d < today))               return 'expired';
  if (dates.some(d => d >= today && d <= in30))  return 'expiring';
  return 'ok';
}

function toApi(row) {
  return {
    id:                   row.id,
    type:                 row.type,
    model:                row.model               || '',
    icon:                 TYPE_ICONS[row.type]    || '🔧',
    plateOrSerial:        row.plate_or_serial     || '',
    ownership:            row.ownership,
    status:               calcStatus(row),
    purchaseDate:         row.purchase_date       || undefined,
    colore:               row.colore              || undefined,
    annoImmatricolazione: row.anno_immatricolazione || undefined,
    numeroTelaio:         row.numero_telaio       || undefined,
    maintenance: {
      inspection: row.inspection_date  || undefined,
      insurance:  row.insurance_expiry || undefined,
      scheduled:  row.maintenance_date || undefined,
    },
    notes: row.notes || undefined,
  };
}

// ── GET /api/v1/equipment ─────────────────────────────────────────────────────
router.get('/equipment', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('equipment')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(toApi));
});

// ── POST /api/v1/equipment/ocr ────────────────────────────────────────────────
// Accetta immagine o PDF, estrae dati con AI. Stateless (nessun salvataggio).
// DEVE stare PRIMA di /equipment/:id per evitare che "ocr" venga trattato come ID.
router.post('/equipment/ocr', verifySupabaseJwt, upload.single('file'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { mimetype, buffer } = req.file;
  const SUPPORTED_IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const isImage = SUPPORTED_IMAGES.includes(mimetype);
  const isPdf   = mimetype === 'application/pdf';

  if (!isImage && !isPdf) {
    return res.status(400).json({ error: 'INVALID_FILE_TYPE', detail: 'Accettati: jpg, png, webp, gif o PDF (HEIC non supportato)' });
  }

  const base64 = buffer.toString('base64');

  const prompt = `Sei un esperto di documenti italiani per veicoli e mezzi d'opera.
Analizza il documento allegato ed estrai i dati strutturati.

Può essere: libretto di circolazione, polizza assicurativa, foglio di revisione, certificato di collaudo, carta di circolazione, bollo, ecc.

Restituisci SOLO un oggetto JSON valido (nessun testo aggiuntivo) con questa struttura (usa null per campi non trovati o non leggibili):
{
  "targa": null,
  "marca": null,
  "modello": null,
  "anno_immatricolazione": null,
  "colore": null,
  "cilindrata": null,
  "numero_telaio": null,
  "intestatario": null,
  "data_prima_immatricolazione": null,
  "data_scadenza_assicurazione": null,
  "data_prossima_revisione": null,
  "data_ultima_revisione": null,
  "compagnia_assicurativa": null,
  "numero_polizza": null,
  "categoria_veicolo": null,
  "note_extra": null
}

IMPORTANTE:
- Le date devono essere nel formato YYYY-MM-DD
- La targa deve essere in maiuscolo senza spazi (es. "AB123CD")
- Se il documento è un libretto di circolazione italiano, la data di prossima revisione si calcola così: prima revisione a 4 anni dall'immatricolazione, poi ogni 2 anni
- Sii preciso e non inventare dati non presenti nel documento`;

  try {
    const content = isImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } },
          { type: 'text', text: prompt },
        ]
      : [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt },
        ];

    const msgOpts = {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages:   [{ role: 'user', content }],
    };

    const msg  = await getClient().messages.create(msgOpts);
    const text = msg.content[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    const extracted = match ? JSON.parse(match[0]) : {};

    res.json({ ok: true, extracted });
  } catch (e) {
    console.error('[equipment/ocr]', e.message);
    res.status(500).json({ error: 'OCR_ERROR', detail: e.message });
  }
});

// ── POST /api/v1/equipment ────────────────────────────────────────────────────
router.post('/equipment', verifySupabaseJwt, async (req, res) => {
  const {
    type, model, plateOrSerial, ownership,
    purchaseDate, inspectionDate, insuranceExpiry, maintenanceDate, notes,
    colore, annoImmatricolazione, numeroTelaio,
  } = req.body;

  if (!type || typeof type !== 'string' || type.trim().length === 0) {
    return res.status(400).json({ error: 'TYPE_REQUIRED' });
  }

  const { data, error } = await supabase
    .from('equipment')
    .insert([{
      company_id:             req.companyId,
      type:                   type.trim(),
      model:                  model?.trim()            || null,
      plate_or_serial:        plateOrSerial?.trim()    || null,
      ownership:              ownership                || 'Aziendale',
      purchase_date:          purchaseDate             || null,
      inspection_date:        inspectionDate           || null,
      insurance_expiry:       insuranceExpiry          || null,
      maintenance_date:       maintenanceDate          || null,
      notes:                  notes?.trim()            || null,
      colore:                 colore?.trim()           || null,
      anno_immatricolazione:  annoImmatricolazione?.trim() || null,
      numero_telaio:          numeroTelaio?.trim()     || null,
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toApi(data));
});

// ── PATCH /api/v1/equipment/:id ───────────────────────────────────────────────
router.patch('/equipment/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('equipment')
    .select('id')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .single();

  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const {
    type, model, plateOrSerial, ownership,
    purchaseDate, inspectionDate, insuranceExpiry, maintenanceDate, notes,
    colore, annoImmatricolazione, numeroTelaio,
  } = req.body;

  const patch = {};
  if (type               !== undefined) patch.type                  = type?.trim();
  if (model              !== undefined) patch.model                 = model?.trim()         || null;
  if (plateOrSerial      !== undefined) patch.plate_or_serial       = plateOrSerial?.trim() || null;
  if (ownership          !== undefined) patch.ownership             = ownership;
  if (purchaseDate       !== undefined) patch.purchase_date         = purchaseDate          || null;
  if (inspectionDate     !== undefined) patch.inspection_date       = inspectionDate        || null;
  if (insuranceExpiry    !== undefined) patch.insurance_expiry      = insuranceExpiry       || null;
  if (maintenanceDate    !== undefined) patch.maintenance_date      = maintenanceDate       || null;
  if (notes              !== undefined) patch.notes                 = notes?.trim()         || null;
  if (colore             !== undefined) patch.colore                = colore?.trim()        || null;
  if (annoImmatricolazione !== undefined) patch.anno_immatricolazione = annoImmatricolazione?.trim() || null;
  if (numeroTelaio       !== undefined) patch.numero_telaio         = numeroTelaio?.trim()  || null;

  const { data, error } = await supabase
    .from('equipment')
    .update(patch)
    .eq('id', id)
    .eq('company_id', req.companyId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(toApi(data));
});

// ── DELETE /api/v1/equipment/:id ──────────────────────────────────────────────
router.delete('/equipment/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('equipment')
    .update({ is_active: false })
    .eq('id', id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /api/v1/equipment/:id/documents ──────────────────────────────────────
router.get('/equipment/:id/documents', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: eq } = await supabase.from('equipment').select('id')
    .eq('id', id).eq('company_id', req.companyId).eq('is_active', true).single();
  if (!eq) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('equipment_documents')
    .select('id, doc_type, file_name, file_url, file_size, mime_type, ai_extracted, uploaded_at')
    .eq('equipment_id', id)
    .eq('company_id', req.companyId)
    .order('uploaded_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── POST /api/v1/equipment/:id/documents ─────────────────────────────────────
// Upload documento + OCR automatico + salvataggio in Storage
router.post('/equipment/:id/documents', verifySupabaseJwt, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { data: eq } = await supabase.from('equipment').select('id')
    .eq('id', id).eq('company_id', req.companyId).eq('is_active', true).single();
  if (!eq) return res.status(404).json({ error: 'NOT_FOUND' });

  const { mimetype, buffer, originalname, size } = req.file;
  const SUPPORTED_IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const isImage = SUPPORTED_IMAGES.includes(mimetype);
  const isPdf   = mimetype === 'application/pdf';

  if (!isImage && !isPdf) {
    return res.status(400).json({ error: 'INVALID_FILE_TYPE', detail: 'Accettati: jpg, png, webp, gif o PDF (HEIC non supportato)' });
  }

  const docType  = req.body?.doc_type || 'altro';
  const safeName = originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const storagePath = `${req.companyId}/${id}/${Date.now()}_${safeName}`;

  // Upload to Supabase Storage
  const { error: uploadErr } = await supabase.storage
    .from('equipment-docs')
    .upload(storagePath, buffer, { contentType: mimetype, upsert: false });

  if (uploadErr) {
    console.error('[equipment/docs] storage upload error:', uploadErr.message);
    return res.status(500).json({ error: 'STORAGE_ERROR', detail: uploadErr.message });
  }

  const { data: { publicUrl } } = supabase.storage
    .from('equipment-docs')
    .getPublicUrl(storagePath);

  // OCR asincrono
  let aiExtracted = null;
  try {
    const base64 = buffer.toString('base64');
    const prompt = `Analizza questo documento del veicolo/mezzo ed estrai i dati. Restituisci SOLO JSON valido:
{"targa":null,"marca":null,"modello":null,"anno_immatricolazione":null,"colore":null,"data_scadenza_assicurazione":null,"data_prossima_revisione":null,"data_ultima_revisione":null,"compagnia_assicurativa":null,"numero_polizza":null,"note_extra":null}
Date in formato YYYY-MM-DD. null per campi non presenti.`;

    const content = isImage
      ? [{ type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } }, { type: 'text', text: prompt }]
      : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: prompt }];

    const msgOpts = { model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content }] };

    const msg  = await getClient().messages.create(msgOpts);
    const text = msg.content[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    aiExtracted = match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.warn('[equipment/docs] OCR skipped:', e.message);
  }

  const { data: doc, error: insertErr } = await supabase
    .from('equipment_documents')
    .insert([{
      company_id:   req.companyId,
      equipment_id: id,
      doc_type:     docType,
      file_name:    originalname,
      file_url:     publicUrl,
      file_size:    size,
      mime_type:    mimetype,
      ai_extracted: aiExtracted,
      uploaded_by:  req.user?.id || null,
    }])
    .select()
    .single();

  if (insertErr) {
    console.error('[equipment/docs] insert error:', insertErr.message);
    return res.status(500).json({ error: 'DB_ERROR', detail: insertErr.message });
  }

  res.status(201).json({ ...doc, ai_extracted: aiExtracted });
});

// ── DELETE /api/v1/equipment/:id/documents/:docId ─────────────────────────────
router.delete('/equipment/:id/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { id, docId } = req.params;

  const { data: doc } = await supabase
    .from('equipment_documents')
    .select('file_url')
    .eq('id', docId)
    .eq('equipment_id', id)
    .eq('company_id', req.companyId)
    .single();

  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  // Rimuovi da Storage (best-effort)
  if (doc.file_url) {
    const urlParts = doc.file_url.split('/equipment-docs/');
    if (urlParts[1]) {
      await supabase.storage.from('equipment-docs').remove([urlParts[1]]);
    }
  }

  const { error } = await supabase
    .from('equipment_documents')
    .delete()
    .eq('id', docId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Assegnazione mezzi a cantiere ─────────────────────────────────────────────

router.get('/sites/:siteId/equipment', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('site_equipment')
    .select('id, equipment_id, assigned_at, equipment:equipment_id(type, model, plate_or_serial, ownership, inspection_date, insurance_expiry, maintenance_date, is_active)')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .order('assigned_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || [])
    .filter(r => r.equipment?.is_active !== false)
    .map(r => ({
      id:           r.id,
      equipment_id: r.equipment_id,
      assigned_at:  r.assigned_at,
      type:         r.equipment?.type        || '',
      model:        r.equipment?.model       || '',
      icon:         TYPE_ICONS[r.equipment?.type] || '🔧',
      plateOrSerial: r.equipment?.plate_or_serial || '',
      ownership:    r.equipment?.ownership   || '',
      status:       calcStatus(r.equipment   || {}),
    }));

  res.json(result);
});

router.post('/sites/:siteId/equipment', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { equipment_id } = req.body;
  if (!equipment_id) return res.status(400).json({ error: 'EQUIPMENT_ID_REQUIRED' });

  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase.from('site_equipment').insert([{
    company_id: req.companyId, site_id: siteId, equipment_id,
  }]);
  if (error?.code === '23505') return res.status(409).json({ error: 'ALREADY_ASSIGNED' });
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

router.delete('/sites/:siteId/equipment/:assignId', verifySupabaseJwt, async (req, res) => {
  const { siteId, assignId } = req.params;
  const { error } = await supabase
    .from('site_equipment').delete()
    .eq('id', assignId).eq('site_id', siteId).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
