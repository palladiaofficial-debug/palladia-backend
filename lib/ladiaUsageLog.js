'use strict';
const supabase = require('./supabase');

// Prezzi ufficiali Anthropic (USD per 1M token, luglio 2026). Cache write/read
// sono moltiplicatori standard del prezzo input (5 min TTL, quello che usiamo
// — vedi buildCachedSystem in routes/v1/chat.js): write ×1.25, read ×0.1.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};
const CACHE_WRITE_MULT = 1.25;
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

module.exports = { logUsage, estimateCostUsd };
