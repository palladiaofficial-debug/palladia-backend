'use strict';
/**
 * services/ladiaProactive.js
 * Motore proattivo di Ladia — invia messaggi ai tecnici PRIMA che lo chiedano.
 *
 * Trigger implementati:
 *   1. rain_alert      — pioggia domani > RAIN_THRESHOLD% → alert meteo cantiere
 *   2. nc_stale        — NC critica/alta aperta da > 48h → reminder
 *   3. budget_alert    — budget consumato > 85% con SAL < 75% → alert sforamento
 *   4. inactivity      — nessuna nota né presenza da 3 giorni lavorativi → check-in
 *   5. doc_expiry      — documento lavoratore scade entro 7 giorni → urgency alert
 *
 * Anti-spam: ogni trigger usa ladia_proactive_log per deduplicazione.
 * Un messaggio NON viene mai ripetuto entro la finestra di dedup.
 *
 * Avvio: startLadiaProactiveCron() da server.js
 * Schedule: ogni 30 minuti. Con dedup, ogni trigger è inviato al massimo
 * una volta al giorno (o settimana per inactivity).
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');
const { getForecast }            = require('./weatherService');
const { generateNcProposal,
        generateBudgetProposal } = require('./ladiaSmartProposal');
const { runComplianceChecks,
        buildComplianceMessage } = require('./complianceEngine');

// ── Costanti ──────────────────────────────────────────────────
const RAIN_THRESHOLD    = 50;  // % probabilità pioggia per triggare alert
const NC_STALE_HOURS    = 48;  // ore dopo le quali una NC alta/critica è "stale"
const BUDGET_THRESHOLD  = 85;  // % budget consumato per triggare alert
const INACTIVITY_DAYS   = 3;   // giorni senza attività per triggare check-in
const DOC_EXPIRY_DAYS   = 7;   // giorni alla scadenza documento per urgency alert

// ── Deduplicazione ────────────────────────────────────────────

/**
 * Controlla se questo trigger è già stato inviato a questo chatId di recente.
 * @param {string} chatId
 * @param {string} triggerType
 * @param {string} triggerKey - identificatore univoco del trigger (include data o ID)
 * @returns {Promise<boolean>}
 */
async function alreadySent(chatId, triggerType, triggerKey) {
  const { data } = await supabase
    .from('ladia_proactive_log')
    .select('id')
    .eq('chat_id', String(chatId))
    .eq('trigger_type', triggerType)
    .eq('trigger_key', triggerKey)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
}

/**
 * Registra che il trigger è stato inviato (prevent future duplicates).
 */
async function markSent(chatId, triggerType, triggerKey, companyId, siteId) {
  await supabase.from('ladia_proactive_log').insert({
    chat_id:      String(chatId),
    trigger_type: triggerType,
    trigger_key:  triggerKey,
    company_id:   companyId,
    site_id:      siteId || null,
  });
}

// ── Helper: recupera chatId target per un cantiere ────────────

/**
 * Restituisce i chatId Telegram da notificare per un cantiere.
 * Prima tenta gli utenti con active_site_id = siteId.
 * Se nessuno ha quel sito attivo, cade su tutti gli utenti della company.
 */
async function getChatIdsForSite(companyId, siteId) {
  // Utenti con questo cantiere attivo
  const { data: direct } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId)
    .eq('active_site_id', siteId);

  if (direct?.length) return direct.map(u => u.telegram_chat_id);

  // Fallback: tutti gli utenti della company
  const { data: all } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId);

  return (all || []).map(u => u.telegram_chat_id);
}

/**
 * Recupera TUTTI gli utenti Telegram con active_site_id non null,
 * e i dati del loro cantiere attivo.
 * @returns {Promise<Array<{chatId, companyId, siteId, siteName, siteAddress, latitude, longitude, budget_totale, sal_percentuale}>>}
 */
async function fetchActiveSiteUsers() {
  const { data: users, error } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id, company_id, active_site_id, notification_level, last_interaction_at')
    .not('active_site_id', 'is', null)
    .limit(500);

  if (error || !users?.length) return [];

  // Recupera i dati dei cantieri in batch
  const siteIds = [...new Set(users.map(u => u.active_site_id))];
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, address, status, budget_totale, sal_percentuale, latitude, longitude, company_id')
    .in('id', siteIds)
    .neq('status', 'chiuso');

  if (!sites?.length) return [];

  const siteMap = new Map(sites.map(s => [s.id, s]));

  return users
    .map(u => {
      const site = siteMap.get(u.active_site_id);
      if (!site) return null;
      return {
        chatId:              u.telegram_chat_id,
        companyId:           u.company_id,
        siteId:              site.id,
        siteName:            site.name || site.address || 'Cantiere',
        latitude:            site.latitude,
        longitude:           site.longitude,
        budgetTotale:        Number(site.budget_totale || 0),
        salPct:              Number(site.sal_percentuale || 0),
        notificationLevel:   u.notification_level || 'balanced',
        lastInteractionAt:   u.last_interaction_at || null,
      };
    })
    .filter(Boolean);
}

// ── Invio sicuro (non blocca il cron se Telegram fallisce) ────

async function safeSend(chatId, text, opts = {}) {
  try {
    await tg.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error(`[ladiaProactive] sendMessage ${chatId} failed:`, err.message);
  }
}

// ── Trigger 1: Pioggia domani ─────────────────────────────────

async function checkRainAlert(entry) {
  const { chatId, companyId, siteId, siteName, latitude, longitude } = entry;
  if (!latitude || !longitude) return; // niente GPS → skip

  let forecast;
  try {
    forecast = await getForecast(latitude, longitude);
  } catch {
    return;
  }

  const tomorrow = forecast[1]; // indice 0 = oggi, 1 = domani
  if (!tomorrow || tomorrow.precipProb < RAIN_THRESHOLD) return;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const key   = `rain_${siteId}_${today}`;

  if (await alreadySent(chatId, 'rain_alert', key)) return;

  const icon = tomorrow.precipProb >= 70 ? '🌧️' : '🌦️';
  const text =
    `${icon} <b>Ladia — Allerta meteo</b>\n\n` +
    `Domani su <b>${siteName}</b> è prevista pioggia con probabilità ${tomorrow.precipProb}%` +
    (tomorrow.description ? ` (${tomorrow.description})` : '') + `.\n\n` +
    `Se hai gettate, opere esterne o ponteggi, valuta uno spostamento.\n\n` +
    `Vuoi che avvisi subito tutta la squadra?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '📲 Avvisa la squadra',  callbackData: `act:rain_notify:${siteId}` },
    { text: '❌ Gestisco io',         callbackData: `act:rain_skip:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'rain_alert', key, companyId, siteId);
  console.log(`[ladiaProactive] rain_alert → chat ${chatId} — ${siteName} (${tomorrow.precipProb}%)`);
}

// ── Trigger 2: NC stale ───────────────────────────────────────

async function checkNcStale(entry) {
  const { chatId, companyId, siteId, siteName } = entry;

  const cutoff = new Date(Date.now() - NC_STALE_HOURS * 3_600_000).toISOString();
  const today  = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

  const { data: staleNcs } = await supabase
    .from('site_notes')
    .select('id, content, ai_summary, urgency, created_at')
    .eq('site_id', siteId)
    .eq('category', 'non_conformita')
    .in('urgency', ['alta', 'critica'])
    .is('resolved_at', null)
    .lt('created_at', cutoff)
    .order('urgency', { ascending: false })
    .limit(5);

  if (!staleNcs?.length) return;

  // Aggregazione: UN solo messaggio per sito per giorno (non uno per NC)
  const key = `nc_stale_batch_${siteId}_${today}`;
  if (await alreadySent(chatId, 'nc_stale_batch', key)) return;

  const hasCritica = staleNcs.some(nc => nc.urgency === 'critica');
  const icon       = hasCritica ? '🔴' : '🟠';

  const ncLines = staleNcs.map(nc => {
    const ageHours = Math.round((Date.now() - new Date(nc.created_at).getTime()) / 3_600_000);
    const ageDays  = Math.floor(ageHours / 24);
    const ageLabel = ageDays >= 1 ? `${ageDays}gg` : `${ageHours}h`;
    const urgIcon  = nc.urgency === 'critica' ? '🔴' : '🟠';
    const snippet  = (nc.ai_summary || nc.content || '').slice(0, 80);
    return `${urgIcon} <b>${ageLabel}</b> — <i>${snippet}</i>`;
  }).join('\n');

  const text =
    `${icon} <b>Ladia — ${staleNcs.length} NC non risolte</b> su ${siteName}\n\n` +
    `${ncLines}\n\n` +
    `Parlane con Ladia per chiuderle o aggiornarle.`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '🤖 Gestisci con Ladia', callbackData: `act:open_ladia:${siteId}` },
    { text: '❌ Le vedo dopo',        callbackData: `act:skip_nc_batch:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'nc_stale_batch', key, companyId, siteId);
  console.log(`[ladiaProactive] nc_stale_batch → chat ${chatId} — ${siteName} (${staleNcs.length} NC)`);
}

// ── Trigger 3: Budget alert ───────────────────────────────────

async function checkBudgetAlert(entry) {
  const { chatId, companyId, siteId, siteName, budgetTotale, salPct } = entry;
  if (!budgetTotale) return;

  const { data: voci } = await supabase
    .from('site_economia_voci')
    .select('tipo, importo')
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (!voci?.length) return;

  const costi    = voci.filter(v => v.tipo === 'costo').reduce((s, v) => s + Number(v.importo), 0);
  const spendPct = Math.round((costi / budgetTotale) * 100);

  if (spendPct < BUDGET_THRESHOLD) return;
  if (salPct >= 75) return; // SAL avanzato → normale che si spenda

  // Usa soglia come parte della key → viene inviato una sola volta per ogni soglia (85%, 90%, 95%)
  const threshold = spendPct >= 95 ? 95 : spendPct >= 90 ? 90 : 85;
  const key = `budget_${siteId}_${threshold}pct`;

  if (await alreadySent(chatId, 'budget_alert', key)) return;

  const fmtEur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const costiStr  = fmtEur(costi);
  const budgetStr = fmtEur(budgetTotale);

  // LIVELLO 2 — Smart proposal: Claude Haiku genera diagnosi + raccomandazione specifica
  const smartProposal = await generateBudgetProposal(siteName, spendPct, salPct, costiStr, budgetStr);

  let text;
  if (smartProposal) {
    // Proposta contestualizzata con diagnosi Claude
    text =
      `📊 <b>Ladia — Allerta budget ${spendPct}%</b>\n\n` +
      `${smartProposal}\n\n` +
      `Vuoi un'analisi completa adesso?`;
  } else {
    // Fallback template
    text =
      `📊 <b>Ladia — Allerta budget</b>\n\n` +
      `<b>${siteName}</b>: ${spendPct}% budget consumato ` +
      `(${costiStr} su ${budgetStr}), SAL ${salPct}%.\n\n` +
      `⚠️ Rischio sforamento. Vuoi un'analisi completa?`;
  }

  const keyboard = tg.buildInlineKeyboard([
    { text: '🤖 Analisi completa con Ladia',  callbackData: `act:budget_ladia:${siteId}` },
  ], 1);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'budget_alert', key, companyId, siteId);
  console.log(`[ladiaProactive] budget_alert → chat ${chatId} — ${siteName} (${spendPct}%)`);
}

// ── Trigger 4: Inattività cantiere ────────────────────────────

async function checkInactivity(entry) {
  const { chatId, companyId, siteId, siteName } = entry;

  // Conta giorni lavorativi (lun-ven) nell'ultimo periodo
  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 3_600_000).toISOString();

  const [notesRes, presenceRes] = await Promise.all([
    supabase.from('site_notes')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId)
      .gte('created_at', cutoff),

    supabase.from('presence_logs')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId)
      .gte('timestamp_server', cutoff),
  ]);

  const hasActivity = (notesRes.count || 0) > 0 || (presenceRes.count || 0) > 0;
  if (hasActivity) return;

  // Dedup: una volta ogni 7 giorni per sito
  const weekNum = Math.floor(Date.now() / (7 * 24 * 3_600_000));
  const key = `inactive_${siteId}_wk${weekNum}`;

  if (await alreadySent(chatId, 'inactivity', key)) return;

  const text =
    `👋 <b>Ladia — Check-in cantiere</b>\n\n` +
    `Non ricevo aggiornamenti da <b>${siteName}</b> da ${INACTIVITY_DAYS} giorni.\n\n` +
    `Tutto ok? Posso aiutarti a registrare un aggiornamento.`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '📝 Scrivi a Ladia',  callbackData: `act:open_ladia:${siteId}` },
    { text: '✅ Tutto ok',         callbackData: `act:skip_inactive:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'inactivity', key, companyId, siteId);
  console.log(`[ladiaProactive] inactivity → chat ${chatId} — ${siteName}`);
}

// ── Trigger 5: Scadenze documenti urgenti ─────────────────────

async function checkDocExpiry(entry) {
  const { chatId, companyId, siteId, siteName } = entry;

  // Trova lavoratori assegnati a questo cantiere
  const { data: assignments } = await supabase
    .from('worksite_workers')
    .select('worker_id')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .limit(100);

  if (!assignments?.length) return;

  const workerIds = assignments.map(a => a.worker_id);
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff    = new Date(today.getTime() + DOC_EXPIRY_DAYS * 86_400_000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

  const { data: workers } = await supabase
    .from('workers')
    .select('id, full_name, safety_training_expiry, health_fitness_expiry')
    .in('id', workerIds)
    .or(`safety_training_expiry.lte.${cutoff},health_fitness_expiry.lte.${cutoff}`)
    .limit(20);

  if (!workers?.length) return;

  // Aggregazione: UN solo messaggio per sito per giorno
  const dateKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const batchKey = `expiry_batch_${siteId}_${dateKey}`;
  if (await alreadySent(chatId, 'doc_expiry_batch', batchKey)) return;

  const lines = [];
  for (const w of workers) {
    const trainDays = w.safety_training_expiry
      ? Math.round((new Date(w.safety_training_expiry) - today) / 86_400_000) : null;
    const fitDays   = w.health_fitness_expiry
      ? Math.round((new Date(w.health_fitness_expiry)  - today) / 86_400_000) : null;

    if (trainDays !== null && trainDays <= DOC_EXPIRY_DAYS) {
      const icon  = trainDays <= 0 ? '🔴' : trainDays <= 3 ? '🟠' : '🟡';
      const label = trainDays <= 0 ? `SCADUTA ${Math.abs(trainDays)}gg fa` : `tra ${trainDays}gg`;
      lines.push(`${icon} <b>${w.full_name}</b> — Formazione ${label}`);
    }
    if (fitDays !== null && fitDays <= DOC_EXPIRY_DAYS) {
      const icon  = fitDays <= 0 ? '🔴' : fitDays <= 3 ? '🟠' : '🟡';
      const label = fitDays <= 0 ? `SCADUTA ${Math.abs(fitDays)}gg fa` : `tra ${fitDays}gg`;
      lines.push(`${icon} <b>${w.full_name}</b> — Idoneità ${label}`);
    }
  }

  if (!lines.length) return;

  const hasCritica = lines.some(l => l.startsWith('🔴'));
  const icon       = hasCritica ? '🔴' : lines.some(l => l.startsWith('🟠')) ? '🟠' : '🟡';

  const text =
    `${icon} <b>Ladia — Scadenze documenti</b> — ${siteName}\n\n` +
    `${lines.join('\n')}\n\n` +
    `Vuoi che avvisi subito il team?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '📢 Avvisa il team',  callbackData: `act:expiry_remind_batch:${siteId}` },
    { text: '❌ Ho visto',         callbackData: `act:expiry_skip_batch:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'doc_expiry_batch', batchKey, companyId, siteId);
  console.log(`[ladiaProactive] doc_expiry_batch → chat ${chatId} — ${siteName} (${lines.length} scadenze)`);
}

// ── Trigger 6: Caldo estremo ──────────────────────────────────
// Temperature > 33°C → obbligo D.Lgs. 81/2008 art. 28 misure microclima

const HEAT_THRESHOLD_C = 33; // °C temperatura massima per triggare alert

async function checkHeatWarning(entry) {
  const { chatId, companyId, siteId, siteName, latitude, longitude } = entry;
  if (!latitude || !longitude) return;

  let forecast;
  try {
    forecast = await getForecast(latitude, longitude);
  } catch {
    return;
  }

  const today = forecast[0];
  if (!today || today.tempMax === null || today.tempMax < HEAT_THRESHOLD_C) return;

  const dateKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const key     = `heat_${siteId}_${dateKey}`;

  if (await alreadySent(chatId, 'heat_alert', key)) return;

  const text =
    `🌡️ <b>Ladia — Allerta caldo</b>\n\n` +
    `Oggi su <b>${siteName}</b> si prevede una temperatura massima di <b>${today.tempMax}°C</b>.\n\n` +
    `⚠️ Oltre i 33°C scatta l'obbligo di misure aggiuntive (D.Lgs. 81/2008 art. 28):\n` +
    `• Acqua e ombra sempre disponibili\n` +
    `• Orari pesanti: evitare 12:00–15:00\n` +
    `• Monitorare i lavoratori a rischio\n\n` +
    `Vuoi che avvisi la squadra adesso?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '🔔 Avvisa la squadra',  callbackData: `act:heat_notify:${siteId}` },
    { text: '✅ Ho già gestito',      callbackData: `act:heat_skip:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'heat_alert', key, companyId, siteId);
  console.log(`[ladiaProactive] heat_alert → chat ${chatId} — ${siteName} (${today.tempMax}°C)`);
}

// ── Trigger 7: Zero presenze a metà mattina ────────────────────
// Alle 10:00 (±30min), se un cantiere attivo ha 0 timbrature oggi → check-in silenzioso

const MID_MORNING_HOUR = 10;

async function checkMidMorningPresences(entry) {
  const { chatId, companyId, siteId, siteName } = entry;

  // Esegui solo nella finestra 09:30–10:30 (Europe/Rome)
  const hourRome = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false }).format(new Date()), 10);
  if (hourRome < 9 || hourRome >= 11) return;

  const dateKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const key     = `midmorning_${siteId}_${dateKey}`;

  if (await alreadySent(chatId, 'mid_morning', key)) return;

  // Controlla presenze oggi per questo cantiere
  const dayStart = `${dateKey}T00:00:00.000Z`;
  const { count } = await supabase
    .from('presence_logs')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('event_type', 'ENTRY')
    .gte('timestamp_server', dayStart);

  if (count > 0) return; // ci sono già presenze → tutto normale

  const text =
    `👀 <b>Ladia — Nessuna timbratura</b>\n\n` +
    `Sono le ${MID_MORNING_HOUR}:00 e su <b>${siteName}</b> non ho ancora registrato presenze oggi.\n\n` +
    `Cantiere fermo? Vuoi che prendo nota o aggiorni lo stato?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '📝 Scrivi a Ladia',  callbackData: `act:open_ladia:${siteId}` },
    { text: '✅ È tutto ok',       callbackData: `act:skip_inactive:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'mid_morning', key, companyId, siteId);
  console.log(`[ladiaProactive] mid_morning_presences → chat ${chatId} — ${siteName} (0 presenze)`);
}

// ── Trigger 8: Pattern NC ripetute ────────────────────────────
// 3+ NC aperte negli ultimi 30 giorni sullo stesso cantiere → "problema sistemico"

const NC_PATTERN_THRESHOLD = 3;  // numero minimo NC per triggare
const NC_PATTERN_DAYS      = 30; // finestra temporale in giorni

async function checkRepeatedNcPattern(entry) {
  const { chatId, companyId, siteId, siteName } = entry;

  const cutoff = new Date(Date.now() - NC_PATTERN_DAYS * 86_400_000).toISOString();

  const { count } = await supabase
    .from('site_notes')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('category', 'non_conformita')
    .is('resolved_at', null)
    .gte('created_at', cutoff);

  if ((count || 0) < NC_PATTERN_THRESHOLD) return;

  // Dedup: una sola notifica per soglia (3, 5, 10...)
  const bucket = count >= 10 ? '10plus' : count >= 5 ? '5plus' : '3plus';
  const weekNum = Math.floor(Date.now() / (7 * 24 * 3_600_000));
  const key = `nc_pattern_${siteId}_${bucket}_wk${weekNum}`;

  if (await alreadySent(chatId, 'nc_pattern', key)) return;

  const text =
    `📈 <b>Ladia — Anomalia rilevata</b>\n\n` +
    `Su <b>${siteName}</b> ho contato <b>${count} Non Conformità aperte</b> negli ultimi ${NC_PATTERN_DAYS} giorni.\n\n` +
    `Questo schema suggerisce un problema sistemico, non episodico. ` +
    `Potrebbe valere la pena fare un sopralluogo mirato o una riunione di cantiere.\n\n` +
    `Vuoi che Ladia ti prepari un riepilogo completo delle NC aperte?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '🤖 Analisi NC con Ladia',  callbackData: `act:budget_ladia:${siteId}` },
    { text: '✅ Ho già gestito',         callbackData: `act:skip_inactive:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'nc_pattern', key, companyId, siteId);
  console.log(`[ladiaProactive] nc_pattern → chat ${chatId} — ${siteName} (${count} NC aperte)`);
}

// ── Fatigue protection ────────────────────────────────────────
// Se l'utente è in 'balanced' e non interagisce da FATIGUE_DAYS giorni,
// passa automaticamente a 'quiet' e manda un messaggio gentile.

const FATIGUE_DAYS = 3;

async function applyFatigueIfNeeded(entry) {
  if (entry.notificationLevel !== 'balanced') return;

  const refDate = entry.lastInteractionAt
    ? new Date(entry.lastInteractionAt)
    : null;

  // Se non ha mai interagito non forziamo il quiet — aspettiamo che premi almeno un bottone
  if (!refDate) return;

  const daysSince = (Date.now() - refDate.getTime()) / 86_400_000;
  if (daysSince < FATIGUE_DAYS) return;

  await supabase.from('telegram_users')
    .update({ notification_level: 'quiet' })
    .eq('telegram_chat_id', String(entry.chatId));

  entry.notificationLevel = 'quiet'; // aggiorna per questo ciclo

  await safeSend(entry.chatId,
    `🔕 <b>Ladia</b> — Non ricevo tue risposte da ${Math.floor(daysSince)} giorni.\n\n` +
    `Per non disturbarti, da ora ti mando solo il briefing mattutino e il resoconto serale.\n\n` +
    `Scrivi <code>/impostazioni</code> per cambiare le notifiche quando vuoi.`
  );

  console.log(`[ladiaProactive] fatigue → chat ${entry.chatId} switched to quiet (${Math.floor(daysSince)}gg senza interazione)`);
}

// ── Trigger 9: Rischio conformità ─────────────────────────────
// Scatta quando il compliance engine rileva 2+ problemi simultanei.
// Dedup: una volta ogni 3 giorni per sito (non ogni 30min).

async function checkComplianceRisk(entry) {
  const { chatId, companyId, siteId } = entry;

  // Dedup: una notifica ogni 3 giorni per sito
  const today   = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const bucket  = Math.floor(new Date(today).getTime() / (3 * 86_400_000));
  const key     = `compliance_${siteId}_b${bucket}`;

  if (await alreadySent(chatId, 'compliance_risk', key)) return;

  let report;
  try {
    report = await runComplianceChecks(siteId, companyId);
  } catch (err) {
    console.error(`[ladiaProactive] compliance check error: ${err.message}`);
    return;
  }

  // Soglia: almeno 1 critico o 2+ warning
  const { criticalCount, warnCount, checks, siteName } = report;
  if (criticalCount === 0 && warnCount < 2) return;

  const scoreIcon = criticalCount > 0 ? '🔴' : '🟡';
  const riskItems = checks
    .filter(c => c.status !== 'ok')
    .map(c => `• ${c.detail.split('\n')[0]}`) // solo prima riga del detail
    .join('\n');

  const text =
    `${scoreIcon} <b>Ladia — Rischio conformità</b> — ${siteName}\n\n` +
    `Ho rilevato ${criticalCount + warnCount} element${criticalCount + warnCount > 1 ? 'i' : 'o'} ` +
    `che potrebbero essere contestati in un'ispezione:\n${riskItems}\n\n` +
    `Vuoi il report completo?`;

  const keyboard = tg.buildInlineKeyboard([
    { text: '🛡️ Report conformità',  callbackData: `act:compliance_report:${siteId}` },
    { text: '❌ Ho già gestito',      callbackData: `act:skip_compliance:${siteId}` },
  ], 2);

  await safeSend(chatId, text, { replyMarkup: keyboard });
  await markSent(chatId, 'compliance_risk', key, companyId, siteId);
  console.log(`[ladiaProactive] compliance_risk → chat ${chatId} — ${siteName} (crit=${criticalCount}, warn=${warnCount})`);
}

// ── Job principale ────────────────────────────────────────────

async function runProactiveEngine() {
  const started = Date.now();
  console.log('[ladiaProactive] avvio engine proattivo');

  const entries = await fetchActiveSiteUsers();
  if (!entries.length) {
    console.log('[ladiaProactive] nessun utente con cantiere attivo — skip');
    return;
  }

  let processed = 0;
  for (const entry of entries) {
    try {
      // Controlla e applica fatigue prima dei trigger
      await applyFatigueIfNeeded(entry);

      // In modalità quiet: salta tutti i trigger (briefing arriva da dailySummaryCron)
      if (entry.notificationLevel === 'quiet') {
        processed++;
        continue;
      }

      // Tutti i trigger in parallelo per ogni utente+cantiere
      await Promise.all([
        checkRainAlert(entry),
        checkHeatWarning(entry),
        checkNcStale(entry),
        checkBudgetAlert(entry),
        checkInactivity(entry),
        checkDocExpiry(entry),
        checkMidMorningPresences(entry),
        checkRepeatedNcPattern(entry),
        checkComplianceRisk(entry),
      ]);
      processed++;
    } catch (err) {
      console.error(`[ladiaProactive] errore entry chat=${entry.chatId} site=${entry.siteId}:`, err.message);
    }
  }

  // Pulizia log proattivi > 30 giorni (mantiene il DB pulito)
  const cutoff30d = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  supabase.from('ladia_proactive_log')
    .delete()
    .lt('sent_at', cutoff30d)
    .then(() => {})
    .catch(() => {});

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[ladiaProactive] completato — ${processed} entries, ${elapsed}s`);
}

// ── Registra il cron ──────────────────────────────────────────

function startLadiaProactiveCron() {
  // Ogni 30 minuti: 0 e 30 di ogni ora
  cron.schedule('0,30 * * * *', runProactiveEngine, { timezone: 'Europe/Rome' });
  console.log('[cron] ladia-proactive attivo — ogni 30min Europe/Rome');
}

module.exports = { startLadiaProactiveCron, runProactiveEngine };
