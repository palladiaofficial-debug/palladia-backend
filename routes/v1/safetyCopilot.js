'use strict';
/**
 * routes/v1/safetyCopilot.js
 *
 * SAFETY COPILOT — API REST
 *
 * Endpoints:
 *   GET /api/v1/safety/risk-scores          — Dashboard: tutti i cantieri con risk score
 *   GET /api/v1/safety/risk-score/:siteId   — Dettaglio risk score di un cantiere
 *   GET /api/v1/safety/risk-history/:siteId — Storico risk score (trend)
 *   GET /api/v1/safety/inspection-shield/:siteId — Scudo Ispezione: dossier completo
 *   POST /api/v1/safety/refresh/:siteId     — Ricalcola risk score on-demand
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { cache } = require('../../middleware/cache');
const {
  computeRiskScore,
  generateInspectionShield,
  riskLevel,
  riskIcon,
  riskLabel,
} = require('../../services/safetyCopilot');

// ── GET /safety/risk-scores — Dashboard tutti i cantieri ────────────────────

router.get('/safety/risk-scores', verifySupabaseJwt, cache(120), async (req, res) => {
  try {
    const { data: sites } = await supabase.from('sites')
      .select('id, name, address, status, latitude, longitude')
      .eq('company_id', req.companyId)
      .neq('status', 'chiuso')
      .limit(100);

    if (!sites?.length) {
      return res.json({ scores: [], summary: { total: 0, verde: 0, giallo: 0, rosso: 0 } });
    }

    // Fetch ultimo score per ogni cantiere
    const siteIds = sites.map(s => s.id);
    const { data: latestScores } = await supabase.from('site_risk_scores')
      .select('site_id, score, level, dimensions, computed_at')
      .in('site_id', siteIds)
      .order('computed_at', { ascending: false })
      .limit(siteIds.length * 2);

    // Dedup: tieni solo il più recente per siteId
    const scoreMap = new Map();
    for (const s of latestScores || []) {
      if (!scoreMap.has(s.site_id)) scoreMap.set(s.site_id, s);
    }

    const scores = sites.map(site => {
      const cached = scoreMap.get(site.id);
      return {
        siteId: site.id,
        siteName: site.name || site.address,
        status: site.status,
        hasGps: !!(site.latitude && site.longitude),
        score: cached?.score ?? null,
        level: cached?.level ?? 'sconosciuto',
        icon: cached ? riskIcon(cached.level) : '⚪',
        label: cached ? riskLabel(cached.level) : 'Non calcolato',
        dimensions: cached?.dimensions ?? null,
        computedAt: cached?.computed_at ?? null,
      };
    });

    // Ordina: rosso prima, poi giallo, poi verde
    const levelOrder = { rosso: 0, giallo: 1, verde: 2, sconosciuto: 3 };
    scores.sort((a, b) => (levelOrder[a.level] ?? 9) - (levelOrder[b.level] ?? 9));

    const summary = {
      total:  scores.length,
      verde:  scores.filter(s => s.level === 'verde').length,
      giallo: scores.filter(s => s.level === 'giallo').length,
      rosso:  scores.filter(s => s.level === 'rosso').length,
    };

    res.json({ scores, summary });
  } catch (err) {
    console.error('[safetyCopilot] GET /risk-scores error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── GET /safety/risk-score/:siteId — Dettaglio singolo cantiere ─────────────

router.get('/safety/risk-score/:siteId', verifySupabaseJwt, cache(60), async (req, res) => {
  try {
    const { siteId } = req.params;

    // Verifica che il cantiere appartenga alla company
    const { data: site } = await supabase.from('sites')
      .select('id')
      .eq('id', siteId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

    const report = await computeRiskScore(siteId, req.companyId);
    res.json(report);
  } catch (err) {
    console.error('[safetyCopilot] GET /risk-score/:siteId error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── GET /safety/risk-history/:siteId — Trend storico ────────────────────────

router.get('/safety/risk-history/:siteId', verifySupabaseJwt, cache(300), async (req, res) => {
  try {
    const { siteId } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    // Verifica ownership
    const { data: site } = await supabase.from('sites')
      .select('id')
      .eq('id', siteId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data: history } = await supabase.from('site_risk_scores')
      .select('score, level, computed_at')
      .eq('site_id', siteId)
      .gte('computed_at', since)
      .order('computed_at', { ascending: true })
      .limit(2000);

    // Aggrega per giorno (media)
    const byDay = new Map();
    for (const h of history || []) {
      const day = h.computed_at.split('T')[0];
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(h.score);
    }

    const trend = [...byDay.entries()].map(([date, scores]) => ({
      date,
      avgScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
      level: riskLevel(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)),
      samples: scores.length,
    }));

    // Trend direction
    const recentAvg = trend.slice(-3).reduce((s, d) => s + d.avgScore, 0) / Math.min(3, trend.length) || 0;
    const olderAvg = trend.slice(0, 3).reduce((s, d) => s + d.avgScore, 0) / Math.min(3, trend.length) || 0;
    const trendDirection = recentAvg > olderAvg + 5 ? 'peggiorando' : recentAvg < olderAvg - 5 ? 'migliorando' : 'stabile';

    res.json({
      siteId,
      days,
      trend,
      trendDirection,
      currentScore: trend.length ? trend[trend.length - 1].avgScore : null,
    });
  } catch (err) {
    console.error('[safetyCopilot] GET /risk-history/:siteId error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── GET /safety/inspection-shield/:siteId — Scudo Ispezione ─────────────────

router.get('/safety/inspection-shield/:siteId', verifySupabaseJwt, async (req, res) => {
  try {
    const { siteId } = req.params;

    // Verifica ownership
    const { data: site } = await supabase.from('sites')
      .select('id')
      .eq('id', siteId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

    const shield = await generateInspectionShield(siteId, req.companyId);
    res.json(shield);
  } catch (err) {
    console.error('[safetyCopilot] GET /inspection-shield/:siteId error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── POST /safety/refresh/:siteId — Ricalcolo on-demand ─────────────────────

router.post('/safety/refresh/:siteId', verifySupabaseJwt, async (req, res) => {
  try {
    const { siteId } = req.params;

    // Verifica ownership
    const { data: site } = await supabase.from('sites')
      .select('id')
      .eq('id', siteId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

    const report = await computeRiskScore(siteId, req.companyId);

    // Salva in DB
    await supabase.from('site_risk_scores').insert({
      site_id:     siteId,
      company_id:  req.companyId,
      score:       report.score,
      level:       report.level,
      dimensions:  report.dimensions,
      computed_at: report.computedAt,
    });

    res.json(report);
  } catch (err) {
    console.error('[safetyCopilot] POST /refresh/:siteId error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
