'use strict';
const supabase = require('./supabase');
const Sentry = require('./sentry');
const { getAiBudgetLimit } = require('../services/stripe');
const { isFounder } = require('./founder');
const { sendAiSpendCircuitBreakerAlert } = require('../services/email');

const MASTER_COMPANY_IDS = new Set(
  (process.env.MASTER_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Company usate SOLO per test/QA/demo interne — separata da MASTER_COMPANY_IDS
// apposta: quella dà bypass sui feature flag (semantica diversa), questa serve
// solo a tenere pulito il report costi. Trovate manualmente il 6/08/2026
// controllando i top spender del mese: nessuna era mai stata esclusa perché
// nessuna coincide con MASTER_COMPANY_IDS/FOUNDER_USER_IDS. Un elenco esplicito
// invece di un pattern sul nome ("Test...") — un cliente vero potrebbe
// chiamarsi così, un ID non si sbaglia per caso.
const INTERNAL_TEST_COMPANY_IDS = new Set(
  (process.env.INTERNAL_TEST_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

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

// ── Circuit breaker: spesa AI giornaliera dell'intera piattaforma ──────────
// Soglia configurabile — di default ben sopra qualunque giorno reale visto
// finora (~$5 nel picco peggiore documentato, vedi F-027 / incidente crediti
// del 6/08) così scatta solo su un'anomalia vera, non su un giorno intenso
// ma normale. Regolabile su Railway senza deploy: AI_SPEND_DAILY_LIMIT_USD.
const AI_SPEND_DAILY_LIMIT_USD = Number(process.env.AI_SPEND_DAILY_LIMIT_USD) || 50;

// Throttle della query di controllo (diverso dal debounce dell'allerta, che è
// durevole su DB — vedi sotto): un loop che chiama logUsage() migliaia di
// volte al secondo non deve anche martellare il DB con una query di somma
// ad ogni singola chiamata. Al massimo una query ogni CHECK_INTERVAL_MS.
const CHECK_INTERVAL_MS = 60 * 1000;
let _lastSpendCheckAt = 0;

// "Oggi" in Europe/Rome — stesso trucco già usato in services/ladiaProactive.js
// (toLocaleDateString('sv-SE', ...) produce direttamente YYYY-MM-DD).
function todayRomeKey() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

// Spesa AI stimata di oggi (Europe/Rome), totale e "clienti reali" (esclude
// is_internal — dogfooding/test/QA, stessa distinzione già usata sopra).
async function getTodayAiSpend() {
  const dayStart = `${todayRomeKey()}T00:00:00.000Z`;
  const { data, error } = await supabase
    .from('ladia_usage_log')
    .select('estimated_cost_usd, is_internal')
    .gte('created_at', dayStart);
  if (error) throw new Error('DB_ERROR: ' + error.message);

  let total = 0, external = 0;
  for (const r of data) {
    const cost = Number(r.estimated_cost_usd);
    total += cost;
    if (!r.is_internal) external += cost;
  }
  return { total, external };
}

// Se la spesa totale di oggi supera la soglia, notifica una sola volta al
// giorno — dedup durevole su ai_spend_alerts (migrazione 159), non solo in
// memoria: regge riavvii del processo e più istanze Railway in parallelo,
// perché il vincolo UNIQUE(alert_date) fa vincere un solo INSERT. Fail-open:
// un errore qui non deve mai impedire la scrittura del log di utilizzo.
async function checkGlobalDailySpendCircuitBreaker() {
  const now = Date.now();
  if (now - _lastSpendCheckAt < CHECK_INTERVAL_MS) return;
  _lastSpendCheckAt = now;

  try {
    const { total, external } = await getTodayAiSpend();
    if (total < AI_SPEND_DAILY_LIMIT_USD) return;

    const alertDate = todayRomeKey();
    // L'INSERT vince solo per il primo processo/istanza che arriva qui oggi —
    // questo È il debounce, non un controllo preliminare separato.
    const { error: insertErr } = await supabase.from('ai_spend_alerts').insert({
      alert_date:         alertDate,
      total_spend_usd:    total,
      external_spend_usd: external,
      threshold_usd:      AI_SPEND_DAILY_LIMIT_USD,
    });
    if (insertErr) {
      if (insertErr.code !== '23505') { // 23505 = unique_violation, atteso e silenzioso
        console.error('[ladia_usage_log] circuit breaker insert error:', insertErr.message);
      }
      return; // già notificato oggi, da questo processo o da un altro
    }

    console.error(`[costGuard] Spesa AI giornaliera oltre soglia: $${total.toFixed(2)} (clienti reali $${external.toFixed(2)}) su soglia $${AI_SPEND_DAILY_LIMIT_USD}`);
    Sentry.captureMessage(
      `Spesa AI giornaliera oltre soglia: $${total.toFixed(2)} su $${AI_SPEND_DAILY_LIMIT_USD} (clienti reali $${external.toFixed(2)})`,
      'error',
    );
    await sendAiSpendCircuitBreakerAlert({
      totalSpendUsd: total, externalSpendUsd: external,
      thresholdUsd: AI_SPEND_DAILY_LIMIT_USD, alertDate,
    }).catch(e => console.error('[ladia_usage_log] sendAiSpendCircuitBreakerAlert failed:', e.message));
  } catch (e) {
    console.error('[ladia_usage_log] checkGlobalDailySpendCircuitBreaker fallito:', e.message);
  }
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
      // Railway inietta RAILWAY_ENVIRONMENT automaticamente su ogni deploy,
      // sempre assente in locale — a differenza di NODE_ENV (mai impostato
      // né qui né su Railway, verificato il 6/08/2026) è un segnale
      // affidabile: se manca, il processo gira in locale, quindi è per
      // definizione test/sviluppo, indipendentemente da quale company/utente
      // usa. Trovato IL GIORNO STESSO in cui is_internal è stato introdotto:
      // senza questo, ogni verifica dal vivo fatta avviando il server in
      // locale (la normalità di questa sessione) finiva marcata come spesa
      // di un cliente reale nel report costi.
      is_internal:            isFounder(userId) || MASTER_COMPANY_IDS.has(companyId) ||
                               INTERNAL_TEST_COMPANY_IDS.has(companyId) || !process.env.RAILWAY_ENVIRONMENT,
      input_tokens:           usage.input_tokens || 0,
      output_tokens:          usage.output_tokens || 0,
      cache_creation_tokens:  usage.cache_creation_input_tokens || 0,
      cache_read_tokens:      usage.cache_read_input_tokens || 0,
      estimated_cost_usd:     estimatedCostUsd,
    });
    if (error) console.error('[ladia_usage_log] insert error:', error.message);
    else checkGlobalDailySpendCircuitBreaker().catch(e => console.error('[ladia_usage_log] circuit breaker fallito:', e.message));
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

// Primo istante del mese di calendario successivo (UTC) — quando si azzera lo
// speso e il budget fair-use torna disponibile.
function nextResetDate() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Verifica il budget fair-use del piano della company. Ritorna { allowed, plan,
// limit, spend, resetsAt } — limit null = nessun tetto (enterprise). Non blocca
// mai per errori DB: in caso di problema nel controllo, allowed resta true
// (fail-open, coerente con "Ladia non deve mai bloccarsi per un guasto nostro").
async function checkAiBudget(companyId) {
  try {
    const { data: company } = await supabase
      .from('companies')
      .select('subscription_plan, subscription_status, trial_ends_at')
      .eq('id', companyId)
      .single();
    if (!company) return { allowed: true, plan: null, limit: null, spend: null, resetsAt: null };

    const trialExpired = company.subscription_status === 'trial' &&
      company.trial_ends_at && new Date(company.trial_ends_at).getTime() < Date.now();
    const effectivePlan = trialExpired ? 'trial' : company.subscription_plan;
    const limit = getAiBudgetLimit(effectivePlan);
    if (limit === null) return { allowed: true, plan: effectivePlan, limit: null, spend: null, resetsAt: null };

    const spend = await getMonthlyAiSpend(companyId);
    return { allowed: spend < limit, plan: effectivePlan, limit, spend, resetsAt: nextResetDate().toISOString() };
  } catch (e) {
    console.error('[ladia_usage_log] checkAiBudget fallito, fail-open:', e.message);
    return { allowed: true, plan: null, limit: null, spend: null, resetsAt: null };
  }
}

// F-056 (AUDIT.md): shape esposta a /api/v1/billing/status per mostrare al
// cliente l'utilizzo AI PRIMA che tocchi il muro (checkAiBudget da solo serve
// solo a bloccare/permettere — qui trasformiamo lo stesso risultato in un
// numero mostrabile in UI). Estratta come funzione pura testabile senza DB:
// il calcolo di `percentage` è l'unica logica non banale (arrotondamento,
// null-safety per i piani enterprise senza tetto) e va protetto da regressioni
// indipendentemente da checkAiBudget stesso.
function formatAiUsageStatus(budget) {
  if (!budget || budget.limit === null || budget.spend == null) {
    return { spend: budget?.spend ?? null, limit: budget?.limit ?? null, percentage: null, resets_at: budget?.resetsAt ?? null };
  }
  return {
    spend:      budget.spend,
    limit:      budget.limit,
    percentage: Math.round((budget.spend / budget.limit) * 100),
    resets_at:  budget.resetsAt,
  };
}

module.exports = {
  logUsage, estimateCostUsd, getMonthlyAiSpend, checkAiBudget,
  getTodayAiSpend, checkGlobalDailySpendCircuitBreaker, AI_SPEND_DAILY_LIMIT_USD,
  formatAiUsageStatus,
};
