'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { calcEndDate }       = require('../../lib/calcEndDate');

const VALID_REASONS = ['pioggia', 'vento', 'neve', 'altro'];

// ── Utility: ricalcola e salva end_date dopo ogni modifica sospensioni ─────────
async function recalcEndDate(siteId, companyId) {
  const { data: site } = await supabase
    .from('sites')
    .select('start_date, contract_days, days_type')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!site || !site.start_date || !site.contract_days) return;

  const { data: suspRows } = await supabase
    .from('site_suspension_days')
    .select('day')
    .eq('site_id', siteId);

  const suspDays = (suspRows || []).map(r => r.day);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, suspDays);

  if (newEnd) {
    await supabase
      .from('sites')
      .update({ end_date: newEnd })
      .eq('id', siteId)
      .eq('company_id', companyId);
  }
}

// ── GET /api/v1/sites/:siteId/suspension-days ──────────────────────────────────
router.get('/sites/:siteId/suspension-days', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  // Verifica ownership
  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { data, error } = await supabase
    .from('site_suspension_days')
    .select('id, day, reason, notes, created_by, created_at')
    .eq('site_id', siteId)
    .order('day', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data);
});

// ── POST /api/v1/sites/:siteId/suspension-days ─────────────────────────────────
router.post('/sites/:siteId/suspension-days', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { day, reason = 'pioggia', notes } = req.body || {};

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'INVALID_DAY', message: 'day deve essere YYYY-MM-DD' });
  }
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'INVALID_REASON', allowed: VALID_REASONS });
  }

  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { data, error } = await supabase
    .from('site_suspension_days')
    .insert({
      company_id: req.companyId,
      site_id:    siteId,
      day,
      reason,
      notes:      notes ? String(notes).trim() : null,
      created_by: req.user?.id ?? null,
    })
    .select('id, day, reason, notes, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'DAY_ALREADY_EXISTS', message: `${day} è già segnato come giorno di sospensione.` });
    }
    return res.status(500).json({ error: 'DB_ERROR', message: error.message });
  }

  // Ricalcola fine lavori
  await recalcEndDate(siteId, req.companyId);

  // Restituisce il giorno aggiunto + la nuova end_date
  const { data: updated } = await supabase
    .from('sites')
    .select('end_date')
    .eq('id', siteId)
    .maybeSingle();

  res.status(201).json({ suspension: data, newEndDate: updated?.end_date ?? null });
});

// ── DELETE /api/v1/sites/:siteId/suspension-days/:dayId ───────────────────────
router.delete('/sites/:siteId/suspension-days/:dayId', verifySupabaseJwt, async (req, res) => {
  const { siteId, dayId } = req.params;

  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { error } = await supabase
    .from('site_suspension_days')
    .delete()
    .eq('id', dayId)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  await recalcEndDate(siteId, req.companyId);

  const { data: updated } = await supabase
    .from('sites')
    .select('end_date')
    .eq('id', siteId)
    .maybeSingle();

  res.json({ ok: true, newEndDate: updated?.end_date ?? null });
});

// ── GET /api/v1/sites/:siteId/weather-suggestion ──────────────────────────────
// Chiama Open-Meteo (gratuito, no API key) con lat/lon del cantiere.
// Restituisce se ha piovuto ieri o oggi, come suggerimento per segnare sospensione.
router.get('/sites/:siteId/weather-suggestion', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites')
    .select('id, latitude, longitude')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });
  if (!site.latitude || !site.longitude) {
    return res.json({ available: false, reason: 'NO_COORDS' });
  }

  try {
    const today = new Date();
    const toISO = d => d.toISOString().split('T')[0];
    const yday = new Date(today); yday.setDate(yday.getDate() - 1);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${site.latitude}&longitude=${site.longitude}&daily=precipitation_sum&timezone=Europe%2FRome&start_date=${toISO(yday)}&end_date=${toISO(today)}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return res.json({ available: false, reason: 'API_ERROR' });

    const json = await response.json();
    const dates = json.daily?.time || [];
    const precip = json.daily?.precipitation_sum || [];

    const suggestions = dates
      .map((d, i) => ({ date: d, mm: precip[i] ?? 0 }))
      .filter(s => s.mm >= 10); // soglia: 10mm = giornata di pioggia significativa

    res.json({ available: true, suggestions });
  } catch {
    res.json({ available: false, reason: 'FETCH_ERROR' });
  }
});

module.exports = router;
