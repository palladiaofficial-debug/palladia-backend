'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const TYPE_ICONS = {
  'Escavatore': '🚜', 'Gru': '🏗️', 'Ponteggio': '🧱',
  'Autocarro': '🚛', 'Betoniera': '🔄', 'Altro': '🔧',
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
    id:            row.id,
    type:          row.type,
    model:         row.model          || '',
    icon:          TYPE_ICONS[row.type] || '🔧',
    plateOrSerial: row.plate_or_serial || '',
    ownership:     row.ownership,
    status:        calcStatus(row),
    purchaseDate:  row.purchase_date   || undefined,
    maintenance: {
      inspection: row.inspection_date  || undefined,
      insurance:  row.insurance_expiry || undefined,
      scheduled:  row.maintenance_date || undefined,
    },
    notes: row.notes || undefined,
  };
}

/**
 * GET /api/v1/equipment
 * Lista tutti i mezzi attivi dell'azienda.
 */
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

/**
 * POST /api/v1/equipment
 * Crea un nuovo mezzo.
 */
router.post('/equipment', verifySupabaseJwt, async (req, res) => {
  const {
    type, model, plateOrSerial, ownership,
    purchaseDate, inspectionDate, insuranceExpiry, maintenanceDate, notes,
  } = req.body;

  if (!type || typeof type !== 'string' || type.trim().length === 0) {
    return res.status(400).json({ error: 'TYPE_REQUIRED' });
  }

  const { data, error } = await supabase
    .from('equipment')
    .insert([{
      company_id:      req.companyId,
      type:            type.trim(),
      model:           model?.trim()          || null,
      plate_or_serial: plateOrSerial?.trim()  || null,
      ownership:       ownership              || 'Aziendale',
      purchase_date:   purchaseDate           || null,
      inspection_date: inspectionDate         || null,
      insurance_expiry: insuranceExpiry       || null,
      maintenance_date: maintenanceDate       || null,
      notes:           notes?.trim()          || null,
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toApi(data));
});

/**
 * PATCH /api/v1/equipment/:id
 * Aggiorna un mezzo (ownership, scadenze, ecc.)
 */
router.patch('/equipment/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  // Verifica ownership
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
  } = req.body;

  const patch = {};
  if (type            !== undefined) patch.type             = type?.trim();
  if (model           !== undefined) patch.model            = model?.trim()         || null;
  if (plateOrSerial   !== undefined) patch.plate_or_serial  = plateOrSerial?.trim() || null;
  if (ownership       !== undefined) patch.ownership        = ownership;
  if (purchaseDate    !== undefined) patch.purchase_date    = purchaseDate    || null;
  if (inspectionDate  !== undefined) patch.inspection_date  = inspectionDate  || null;
  if (insuranceExpiry !== undefined) patch.insurance_expiry = insuranceExpiry || null;
  if (maintenanceDate !== undefined) patch.maintenance_date = maintenanceDate || null;
  if (notes           !== undefined) patch.notes            = notes?.trim()   || null;

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

/**
 * DELETE /api/v1/equipment/:id
 * Soft delete (is_active = false).
 */
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
