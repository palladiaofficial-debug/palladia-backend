#!/usr/bin/env node
/**
 * scripts/ai-usage-report.js
 *
 * Riepilogo spesa AI (ladia_usage_log) — quanto e su cosa, così la spesa non
 * resta invisibile finché il credito Anthropic non finisce a sorpresa.
 *
 * Uso:
 *   node scripts/ai-usage-report.js            (ultimi 7 giorni, tutte le company)
 *   node scripts/ai-usage-report.js 30          (ultimi 30 giorni)
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 7;

function fmtUsd(n) { return '$' + n.toFixed(4); }

(async () => {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('ladia_usage_log')
    .select('company_id, model, call_site, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, created_at')
    .gte('created_at', since);

  if (error) {
    console.error('Errore query:', error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log(`Nessuna chiamata registrata negli ultimi ${days} giorni.`);
    return;
  }

  const totalCost = data.reduce((s, r) => s + Number(r.estimated_cost_usd), 0);
  console.log(`\n=== Spesa AI stimata — ultimi ${days} giorni ===`);
  console.log(`Chiamate totali: ${data.length}   Costo stimato totale: ${fmtUsd(totalCost)}\n`);

  const byCallSite = {};
  for (const r of data) {
    byCallSite[r.call_site] ??= { calls: 0, cost: 0, model: r.model };
    byCallSite[r.call_site].calls += 1;
    byCallSite[r.call_site].cost  += Number(r.estimated_cost_usd);
  }
  console.log('Per punto di chiamata:');
  Object.entries(byCallSite)
    .sort((a, b) => b[1].cost - a[1].cost)
    .forEach(([site, s]) => console.log(`  ${site.padEnd(24)} ${String(s.calls).padStart(5)} chiamate   ${fmtUsd(s.cost)}`));

  const byCompany = {};
  for (const r of data) {
    byCompany[r.company_id] ??= { calls: 0, cost: 0 };
    byCompany[r.company_id].calls += 1;
    byCompany[r.company_id].cost  += Number(r.estimated_cost_usd);
  }
  console.log('\nPer company (top 10):');
  Object.entries(byCompany)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 10)
    .forEach(([companyId, s]) => console.log(`  ${companyId}   ${String(s.calls).padStart(5)} chiamate   ${fmtUsd(s.cost)}`));

  console.log('');
})();
