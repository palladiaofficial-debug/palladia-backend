'use strict';
const supabase = require('./supabase');
const { getAiBudgetLimit } = require('../services/stripe');

// Prezzi ufficiali Anthropic (USD per 1M token, luglio 2026). Moltiplicatori
// cache dipendono dal TTL: 1.25x per 5 minuti, 2x per 1 ora. Il codice usa
// SEMPRE ttl:'1h' (vedi buildCachedSystem/TOOLS_CACHED in routes/v1/chat.js),
// quindi qui va sempre il moltiplicatore 1h — non quello 5 minuti (bug corretto
// il 13/07/2026: sottostimava la spesa reale cache-write di ~1.6x). Lettura
// cache resta 0.1x indipendentemente dal TTL.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};
const CACHE_WRITE_MULT = 2.0;
const CACHE_READ_MULT  = 0.1;

function estimateCostUsd(model, usage) {
  const price = PRICING[model];
  if (!price || !usage) return 0;
  const inputTokens        = usage.input_tokens || 0;
  const outputTokens       = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens     = usage.cache_read_input_tokens || 0;

  const cost =
    (inputTokens         / 1_000_000) * price.input +
    (outputTokens        / 1_000_000) * price.output +
    (cacheCreationTokens / 1_000_000) * price.input * CACHE_WRITE_MULT +
    (cacheReadTokens      / 1_000_000) * price.input * CACHE_READ_MULT;

  return cost;
}

// Fire-and-forget: non deve mai bloccare o far fallire la risposta a Ladia.
async function logUsage({ companyId, userId = null, conversationId = null, model, callSite, usage }) {
  if (!usage) return;
  try {
    const estimatedCostUsd = estimateCostUsd(model, usage);
    const { error } = await supabase.from('ladia_usage_log').insert({
      company_id:            companyId,
      user_id:                userId,
      conversation_id:        conversationId,
      model,
      call_site:              callSite,
      input_tokens:           usage.input_tokens || 0,
      output_tokens:          usage.output_tokens || 0,
      cache_creation_tokens:  usage.cache_creation_input_tokens || 0,
      cache_read_tokens:      usage.cache_read_input_tokens || 0,
      estimated_cost_usd:     estimatedCostUsd,
    });
    if (error) console.error('[ladia_usage_log] insert error:', error.message);
  } catch (e) {
    console.error('[ladia_usage_log] insert exception:', e.message);
  }
}

// Spesa AI stimata della company nel mese di calendario corrente (UTC).
async function getMonthlyAiSpend(companyId) {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('ladia_usage_log')
    .select('estimated_cost_usd')
    .eq('company_id', companyId)
    .gte('created_at', startOfMonth.toISOString());
  if (error) throw new Error('DB_ERROR: ' + error.message);

  return data.reduce((sum, r) => sum + Number(r.estimated_cost_usd), 0);
}

// Verifica il budget fair-use del piano della company. Ritorna { allowed, plan,
// limit, spend } — limit null = nessun tetto (enterprise). Non blocca mai per
// errori DB: in caso di problema nel controllo, allowed resta true (fail-open,
// coerente con "Ladia non deve mai bloccarsi per un guasto nostro").
async function checkAiBudget(companyId) {
  try {
    const { data: company } = await supabase
      .from('companies')
      .select('subscription_plan, subscription_status, trial_ends_at')
      .eq('id', companyId)
      .single();
    if (!company) return { allowed: true, plan: null, limit: null, spend: null };

    const trialExpired = company.subscription_status === 'trial' &&
      company.trial_ends_at && new Date(company.trial_ends_at).getTime() < Date.now();
    const effectivePlan = trialExpired ? 'trial' : company.subscription_plan;
    const limit = getAiBudgetLimit(effectivePlan);
    if (limit === null) return { allowed: true, plan: effectivePlan, limit: null, spend: null };

    const spend = await getMonthlyAiSpend(companyId);
    return { allowed: spend < limit, plan: effectivePlan, limit, spend };
  } catch (e) {
    console.error('[ladia_usage_log] checkAiBudget fallito, fail-open:', e.message);
    return { allowed: true, plan: null, limit: null, spend: null };
  }
}

module.exports = { logUsage, estimateCostUsd, getMonthlyAiSpend, checkAiBudget };
