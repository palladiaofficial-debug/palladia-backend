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
const { getForecast } = require('./weatherService');

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
    .select('telegram_chat_id, company_id, active_site_id')
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
        chatId:        u.telegram_chat_id,
        companyId:     u.company_id,
        siteId:        site.id,
        siteName:      site.name || site.address || 'Cantiere',
        latitude:      site.latitude,
        longitude:     site.longitude,
        budgetTotale:  Number(site.budget_totale || 0),
        salPct:        Number(site.sal_percentuale || 0),
      };
    })
    .filter(Boolean);
}

// ── Invio sicuro (non blocca il cron se Telegram fallisce) ────

async function safeSend(chatId, text) {
  try {
    await tg.sendMessage(chatId, text);
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
    `Se hai gettate, opere esterne o ponteggi, valuta uno spostamento.\n` +
    `Scrivi a 🤖 <b>Ladia</b> per pianificare.`;

  await safeSend(chatId, text);
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
    .lt('created_at', cutoff)
    .order('urgency', { ascending: false }) // critiche prima
    .limit(5);

  if (!staleNcs?.length) return;

  for (const nc of staleNcs) {
    const key = `nc_stale_${nc.id}_${today}`;
    if (await alreadySent(chatId, 'nc_stale', key)) continue;

    const ageHours = Math.round((Date.now() - new Date(nc.created_at).getTime()) / 3_600_000);
    const ageDays  = Math.floor(ageHours / 24);
    const ageLabel = ageDays >= 1 ? `${ageDays} giorn${ageDays > 1 ? 'i' : 'o'}` : `${ageHours}h`;
    const icon     = nc.urgency === 'critica' ? '🔴' : '🟠';
    const text_nc  = (nc.ai_summary || nc.content || '').slice(0, 120);

    const text =
      `${icon} <b>Ladia — NC non risolta</b>\n\n` +
      `Su <b>${siteName}</b> c'è una NC <b>${nc.urgency}</b> aperta da <b>${ageLabel}</b>:\n\n` +
      `<i>${text_nc}</i>\n\n` +
      `Scrivi a 🤖 <b>Ladia</b> per gestirla.`;

    await safeSend(chatId, text);
    await markSent(chatId, 'nc_stale', key, companyId, siteId);
    console.log(`[ladiaProactive] nc_stale → chat ${chatId} — ${siteName} (${ageLabel})`);
  }
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
  const costiStr   = fmtEur(costi);
  const budgetStr  = fmtEur(budgetTotale);

  const text =
    `📊 <b>Ladia — Allerta budget</b>\n\n` +
    `<b>${siteName}</b> ha consumato il <b>${spendPct}%</b> del budget ` +
    `(${costiStr} su ${budgetStr}) con SAL al <b>${salPct}%</b>.\n\n` +
    `⚠️ Rischio sforamento. Scrivi a 🤖 <b>Ladia</b> per un'analisi economica.`;

  await safeSend(chatId, text);
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
    `Tutto ok? Scrivimi se hai bisogno di aiuto o vuoi registrare un aggiornamento. 🤖`;

  await safeSend(chatId, text);
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

  for (const w of workers) {
    const trainDays = w.safety_training_expiry
      ? Math.round((new Date(w.safety_training_expiry) - today) / 86_400_000) : null;
    const fitDays   = w.health_fitness_expiry
      ? Math.round((new Date(w.health_fitness_expiry)  - today) / 86_400_000) : null;

    // Formazione
    if (trainDays !== null && trainDays <= DOC_EXPIRY_DAYS) {
      const key = `expiry_${w.id}_train_${w.safety_training_expiry}`;
      if (!(await alreadySent(chatId, 'doc_expiry', key))) {
        const icon = trainDays <= 0 ? '🔴' : trainDays <= 3 ? '🟠' : '🟡';
        const label = trainDays <= 0 ? `SCADUTA ${Math.abs(trainDays)}gg fa` : `scade tra ${trainDays}gg`;
        const text =
          `${icon} <b>Ladia — Scadenza documenti</b>\n\n` +
          `<b>${w.full_name}</b> su <b>${siteName}</b>:\n` +
          `Formazione sicurezza ${label}.\n\n` +
          `Aggiorna prima di mandarlo in cantiere (D.Lgs. 81/2008 art. 37).`;

        await safeSend(chatId, text);
        await markSent(chatId, 'doc_expiry', key, companyId, siteId);
        console.log(`[ladiaProactive] doc_expiry(train) → chat ${chatId} — ${w.full_name}`);
      }
    }

    // Idoneità sanitaria
    if (fitDays !== null && fitDays <= DOC_EXPIRY_DAYS) {
      const key = `expiry_${w.id}_fit_${w.health_fitness_expiry}`;
      if (!(await alreadySent(chatId, 'doc_expiry', key))) {
        const icon = fitDays <= 0 ? '🔴' : fitDays <= 3 ? '🟠' : '🟡';
        const label = fitDays <= 0 ? `SCADUTA ${Math.abs(fitDays)}gg fa` : `scade tra ${fitDays}gg`;
        const text =
          `${icon} <b>Ladia — Scadenza documenti</b>\n\n` +
          `<b>${w.full_name}</b> su <b>${siteName}</b>:\n` +
          `Idoneità sanitaria ${label}.\n\n` +
          `Aggiorna visita medica (art. 41 D.Lgs. 81/2008).`;

        await safeSend(chatId, text);
        await markSent(chatId, 'doc_expiry', key, companyId, siteId);
        console.log(`[ladiaProactive] doc_expiry(fit) → chat ${chatId} — ${w.full_name}`);
      }
    }
  }
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

  // Raggruppa per siteId per evitare fetch duplicate di NC/budget
  // (più utenti sullo stesso cantiere → stessi trigger, ma ognuno riceve il suo messaggio)
  let processed = 0;
  for (const entry of entries) {
    try {
      // Tutti i trigger in parallelo per ogni utente+cantiere
      await Promise.all([
        checkRainAlert(entry),
        checkNcStale(entry),
        checkBudgetAlert(entry),
        checkInactivity(entry),
        checkDocExpiry(entry),
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
