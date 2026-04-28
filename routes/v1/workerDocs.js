'use strict';
// ── Worker Documents ───────────────────────────────────────────────────────────
// Archivio documenti personali del lavoratore (idoneità, attestati, corsi…)
//
// GET    /api/v1/workers/:workerId/documents          — lista doc lavoratore
// POST   /api/v1/workers/:workerId/documents          — aggiungi documento
// PATCH  /api/v1/workers/:workerId/documents/:docId   — modifica documento
// DELETE /api/v1/workers/:workerId/documents/:docId   — elimina documento
// GET    /api/v1/worker-documents                     — tutti i doc company (vista globale)
// ──────────────────────────────────────────────────────────────────────────────

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const ALLOWED_TYPES = [
  'idoneita_medica',
  'formazione_sicurezza',
  'primo_soccorso',
  'antincendio',
  'lavori_quota',
  'ponteggi',
  'gruista',
  'pes_pav_pei',
  'rspp',
  'patente_guida',
  'altro',
];

function isValidDate(val) {
  if (!val) return true;
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

async function verifyWorker(workerId, companyId) {
  const { data } = await supabase
    .from('workers')
    .select('id')
    .eq('id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();
  return !!data;
}

// Sincronizza scadenze shortcut su workers quando si salva idoneità / formazione
async function syncWorkerExpiry(docType, expiryDate, workerId, companyId) {
  if (!expiryDate) return;
  const field = docType === 'idoneita_medica'      ? 'health_fitness_expiry'
    : docType === 'formazione_sicurezza' ? 'safety_training_expiry'
    : null;
  if (!field) return;
  await supabase.from('workers')
    .update({ [field]: expiryDate })
    .eq('id', workerId)
    .eq('company_id', companyId);
}

// ── GET /api/v1/workers/:workerId/documents ───────────────────────────────────
router.get('/workers/:workerId/documents', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  if (!await verifyWorker(workerId, req.companyId))
    return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('worker_documents')
    .select('*')
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/workers/:workerId/documents ──────────────────────────────────
router.post('/workers/:workerId/documents', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  const { doc_type, name, issued_date, expiry_date, file_url, notes } = req.body;

  if (!name || !String(name).trim())
    return res.status(400).json({ error: 'NAME_REQUIRED' });
  if (doc_type && !ALLOWED_TYPES.includes(doc_type))
    return res.status(400).json({ error: 'INVALID_DOC_TYPE' });
  if (!isValidDate(issued_date) || !isValidDate(expiry_date))
    return res.status(400).json({ error: 'DATE_FORMAT_YYYY_MM_DD' });

  if (!await verifyWorker(workerId, req.companyId))
    return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('worker_documents')
    .insert({
      company_id:  req.companyId,
      worker_id:   workerId,
      doc_type:    doc_type || 'altro',
      name:        String(name).trim(),
      issued_date: issued_date || null,
      expiry_date: expiry_date || null,
      file_url:    file_url   || null,
      notes:       notes ? String(notes).trim() : null,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  await syncWorkerExpiry(data.doc_type, data.expiry_date, workerId, req.companyId);
  res.status(201).json(data);
});

// ── PATCH /api/v1/workers/:workerId/documents/:docId ──────────────────────────
router.patch('/workers/:workerId/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { workerId, docId } = req.params;
  const allowed = ['doc_type', 'name', 'issued_date', 'expiry_date', 'file_url', 'notes'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k] || null;
  }
  if ('name' in updates) updates.name = String(updates.name || '').trim();
  if ('doc_type' in updates && updates.doc_type && !ALLOWED_TYPES.includes(updates.doc_type))
    return res.status(400).json({ error: 'INVALID_DOC_TYPE' });
  if (!isValidDate(updates.issued_date) || !isValidDate(updates.expiry_date))
    return res.status(400).json({ error: 'DATE_FORMAT_YYYY_MM_DD' });
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('worker_documents')
    .update(updates)
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId)
    .select('*')
    .single();

  if (error || !data) return res.status(404).json({ error: 'DOC_NOT_FOUND' });

  await syncWorkerExpiry(data.doc_type, data.expiry_date, workerId, req.companyId);
  res.json(data);
});

// ── DELETE /api/v1/workers/:workerId/documents/:docId ─────────────────────────
router.delete('/workers/:workerId/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { workerId, docId } = req.params;

  const { error } = await supabase
    .from('worker_documents')
    .delete()
    .eq('id',         docId)
    .eq('worker_id',  workerId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

// ── GET /api/v1/worker-documents — vista globale (sezione Documenti) ──────────
router.get('/worker-documents', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('worker_documents')
    .select(`
      *,
      worker:workers ( id, full_name, photo_url, is_active )
    `)
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false })
    .limit(1000);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

module.exports = router;
