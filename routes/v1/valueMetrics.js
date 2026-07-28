'use strict';
/**
 * routes/v1/valueMetrics.js
 * Layer "proof of value" — widget dashboard impresa.
 *
 * GET /api/v1/value-metrics                 — numeri precalcolati (letti da
 *                                              value_metrics, MAI ricalcolati
 *                                              a request — vedi services/valueMetrics.js
 *                                              + cron giornaliero dailyStatsCron.js)
 * GET /api/v1/value-metrics/detail/:metric   — elenco esatto degli eventi dietro
 *                                              un numero (click-through), calcolato
 *                                              live: sempre aggiornato, sempre
 *                                              coerente con la stessa logica usata
 *                                              per l'aggregato.
 */
const router   = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const supabase = require('../../lib/supabase');
const {
  computeScadenzeESanzioni, computeDocumentiGenerati, computeOrePresenza,
} = require('../../services/valueMetrics');

router.get('/value-metrics', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('value_metrics')
    .select('scadenze_intercettate, sanzioni_evitate_cents, documenti_generati, ore_presenza_tracciate, has_data, computed_at')
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  if (!data || !data.has_data) {
    return res.json({ has_data: false });
  }

  res.json({
    has_data: true,
    scadenze_intercettate:  data.scadenze_intercettate,
    sanzioni_evitate_cents: data.sanzioni_evitate_cents,
    documenti_generati:     data.documenti_generati,
    ore_presenza_tracciate: data.ore_presenza_tracciate,
    computed_at:            data.computed_at,
  });
});

router.get('/value-metrics/detail/:metric', verifySupabaseJwt, async (req, res) => {
  const { metric } = req.params;

  try {
    if (metric === 'scadenze' || metric === 'sanzioni') {
      const { count, sanzioniCents, items } = await computeScadenzeESanzioni(req.companyId);
      return res.json({
        metric, count, sanzioni_evitate_cents: sanzioniCents,
        items: items.map(i => ({
          entity_type:      i.entity_type,
          label:             i.label,
          notified_at:       i.notified_at,
          resolved_at:       i.resolved_at,
          violation_label:   i.violation_label || null,
          amount_min_cents:  i.amount_min_cents || null,
        })),
      });
    }
    if (metric === 'documenti') {
      const { count, items } = await computeDocumentiGenerati(req.companyId);
      return res.json({ metric, count, items });
    }
    if (metric === 'presenze') {
      const { totalHours, totalShifts, items } = await computeOrePresenza(req.companyId);
      return res.json({ metric, total_hours: totalHours, total_shifts: totalShifts, items });
    }
    return res.status(400).json({ error: 'INVALID_METRIC' });
  } catch (e) {
    res.status(500).json({ error: 'COMPUTE_ERROR', detail: e.message });
  }
});

module.exports = router;
