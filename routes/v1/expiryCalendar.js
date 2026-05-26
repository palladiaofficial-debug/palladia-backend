'use strict';
// ── Scadenzario unificato ─────────────────────────────────────────────────────
// GET /api/v1/expiry-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Aggrega TUTTE le scadenze della company in un unico feed ordinato per data:
//   - Lavoratori: safety_training_expiry, health_fitness_expiry
//   - Subappaltatori: durc_expiry, insurance_expiry, soa_expiry
//   - Azienda: durc_expiry
//   - Cantieri: suolo_occupazione_end, end_date
//
// GET /api/v1/expiry-calendar/summary
//   Conteggio totale per severity (critical / warning / info)
// ─────────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

function daysFrom(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date().setHours(0,0,0,0)) / 86400000);
}

function severity(days) {
  if (days === null) return null;
  if (days < 0)   return 'critical';
  if (days <= 7)  return 'critical';
  if (days <= 30) return 'warning';
  return 'info';
}

function fmtDate(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}

// ── GET /api/v1/expiry-calendar ───────────────────────────────────────────────
router.get('/expiry-calendar', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  // Finestra: default prossimi 90 giorni + già scaduti ultimi 30
  const fromParam = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toParam   = req.query.to   || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const [workersRes, subsRes, companyRes, sitesRes, salRes] = await Promise.all([
    supabase
      .from('workers')
      .select('id, full_name, safety_training_expiry, health_fitness_expiry')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`safety_training_expiry.gte.${fromParam},health_fitness_expiry.gte.${fromParam}`)
      .or(`safety_training_expiry.lte.${toParam},health_fitness_expiry.lte.${toParam}`),

    supabase
      .from('subcontractors')
      .select('id, company_name, durc_expiry, insurance_expiry, soa_expiry')
      .eq('company_id', companyId),

    supabase
      .from('companies')
      .select('id, name, durc_expiry')
      .eq('id', companyId)
      .maybeSingle(),

    supabase
      .from('sites')
      .select('id, name, suolo_occupazione_end, end_date, suolo_occupazione')
      .eq('company_id', companyId)
      .neq('status', 'eliminato'),

    supabase
      .from('site_sal_history')
      .select('id, site_id, sal_number, importo_maturato, data_pagamento_prevista, sites(name)')
      .eq('company_id', companyId)
      .is('pagato_il', null)
      .not('data_pagamento_prevista', 'is', null),
  ]);

  const events = [];

  // Lavoratori
  for (const w of (workersRes.data || [])) {
    if (w.safety_training_expiry) {
      const d = fmtDate(w.safety_training_expiry);
      events.push({ date: d, days: daysFrom(d), type: 'formazione', label: `Formazione — ${w.full_name}`, entity: w.full_name, entity_id: w.id, entity_type: 'worker', severity: severity(daysFrom(d)) });
    }
    if (w.health_fitness_expiry) {
      const d = fmtDate(w.health_fitness_expiry);
      events.push({ date: d, days: daysFrom(d), type: 'idoneita', label: `Idoneità medica — ${w.full_name}`, entity: w.full_name, entity_id: w.id, entity_type: 'worker', severity: severity(daysFrom(d)) });
    }
  }

  // Subappaltatori
  for (const s of (subsRes.data || [])) {
    const fields = [
      { key: 'durc_expiry',      label: 'DURC',          type: 'durc' },
      { key: 'insurance_expiry', label: 'Assicurazione',  type: 'assicurazione' },
      { key: 'soa_expiry',       label: 'SOA',            type: 'soa' },
    ];
    for (const f of fields) {
      if (s[f.key]) {
        const d = fmtDate(s[f.key]);
        events.push({ date: d, days: daysFrom(d), type: f.type, label: `${f.label} — ${s.company_name}`, entity: s.company_name, entity_id: s.id, entity_type: 'subcontractor', severity: severity(daysFrom(d)) });
      }
    }
  }

  // Azienda
  if (companyRes.data?.durc_expiry) {
    const d = fmtDate(companyRes.data.durc_expiry);
    events.push({ date: d, days: daysFrom(d), type: 'durc', label: `DURC aziendale — ${companyRes.data.name}`, entity: companyRes.data.name, entity_id: companyRes.data.id, entity_type: 'company', severity: severity(daysFrom(d)) });
  }

  // Cantieri
  for (const s of (sitesRes.data || [])) {
    if (s.suolo_occupazione && s.suolo_occupazione_end) {
      const d = fmtDate(s.suolo_occupazione_end);
      events.push({ date: d, days: daysFrom(d), type: 'suolo', label: `Suolo pubblico — ${s.name}`, entity: s.name, entity_id: s.id, entity_type: 'site', severity: severity(daysFrom(d)) });
    }
    if (s.end_date) {
      const d = fmtDate(s.end_date);
      const sev = severity(daysFrom(d));
      if (sev === 'critical' || sev === 'warning') {
        events.push({ date: d, days: daysFrom(d), type: 'fine_cantiere', label: `Fine cantiere — ${s.name}`, entity: s.name, entity_id: s.id, entity_type: 'site', severity: sev });
      }
    }
  }

  // SAL non incassati
  for (const sal of (salRes.data || [])) {
    const d = fmtDate(sal.data_pagamento_prevista);
    const siteName = sal.sites?.name || 'Cantiere';
    const imp = sal.importo_maturato != null
      ? ` — € ${Number(sal.importo_maturato).toLocaleString('it-IT', { maximumFractionDigits: 0 })}` : '';
    events.push({
      date: d,
      days: daysFrom(d),
      type: 'sal_pagamento',
      label: `Incasso SAL N.${sal.sal_number}${imp} — ${siteName}`,
      entity: siteName,
      entity_id: sal.site_id,
      entity_type: 'site',
      severity: severity(daysFrom(d)),
    });
  }

  // Filtra per finestra e ordina per data
  const filtered = events
    .filter(e => e.date && e.date >= fromParam && e.date <= toParam)
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ events: filtered, from: fromParam, to: toParam });
});

// ── GET /api/v1/expiry-calendar/summary ──────────────────────────────────────
router.get('/expiry-calendar/summary', verifySupabaseJwt, async (req, res) => {
  const to90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const from30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // Re-use main handler logic inline but only count
  const req2 = { ...req, query: { from: from30, to: to90 } };
  const mockRes = {
    _data: null,
    json(d) { this._data = d; }
  };

  // Call with a fake next to avoid complexity — just duplicate the aggregation
  const [workersRes, subsRes, companyRes, sitesRes, salRes] = await Promise.all([
    supabase.from('workers').select('id, safety_training_expiry, health_fitness_expiry').eq('company_id', req.companyId).eq('is_active', true),
    supabase.from('subcontractors').select('id, durc_expiry, insurance_expiry, soa_expiry').eq('company_id', req.companyId),
    supabase.from('companies').select('id, durc_expiry').eq('id', req.companyId).maybeSingle(),
    supabase.from('sites').select('id, suolo_occupazione_end, end_date, suolo_occupazione').eq('company_id', req.companyId).neq('status', 'eliminato'),
    supabase.from('site_sal_history').select('data_pagamento_prevista').eq('company_id', req.companyId).is('pagato_il', null).not('data_pagamento_prevista', 'is', null),
  ]);

  const counts = { critical: 0, warning: 0, info: 0, total: 0 };
  const allDates = [];

  const pushDate = (d) => { if (d) allDates.push(fmtDate(d)); };
  for (const w of (workersRes.data || [])) { pushDate(w.safety_training_expiry); pushDate(w.health_fitness_expiry); }
  for (const s of (subsRes.data || [])) { pushDate(s.durc_expiry); pushDate(s.insurance_expiry); pushDate(s.soa_expiry); }
  if (companyRes.data?.durc_expiry) pushDate(companyRes.data.durc_expiry);
  for (const s of (sitesRes.data || [])) { if (s.suolo_occupazione) pushDate(s.suolo_occupazione_end); }
  for (const sal of (salRes.data || [])) { pushDate(sal.data_pagamento_prevista); }

  for (const d of allDates) {
    if (!d) continue;
    const sev = severity(daysFrom(d));
    if (sev === 'critical' || sev === 'warning' || sev === 'info') {
      counts[sev]++;
      counts.total++;
    }
  }

  res.json(counts);
});

module.exports = router;
