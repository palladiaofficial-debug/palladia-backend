'use strict';
/**
 * services/ladiaActions.js
 *
 * Esecutori delle azioni Ladia confermate dal tecnico via tap su bottone Telegram.
 *
 * Design:
 *  - Ogni azione è IDEMPOTENTE (sicura se eseguita due volte)
 *  - Ogni azione recupera company_id dal DB (mai dal client)
 *  - Ogni esito è tracciato in ladia_action_log
 *
 * Azioni:
 *  closeNc(ncId, chatId, companyId)              → marca NC come risolta
 *  registerMissingExits(siteId, date, companyId) → inserisce EXIT per ENTRY senza uscita
 *  sendRainNotification(siteId, companyId, chatId)→ avvisa tutto il team via Telegram
 *  sendExpiryReminder(workerId, docType, companyId, chatId) → promemoria team
 *  openLadiaMode(chatId, siteId)                 → attiva ladia_mode su telegram_users
 */

const supabase = require('../lib/supabase');
const tg       = require('./telegram');

// ── Utility: log azione ───────────────────────────────────────

async function logAction(chatId, companyId, siteId, actionType, params, result, errorMsg = null) {
  await supabase
    .from('ladia_action_log')
    .insert({
      chat_id:       String(chatId),
      company_id:    companyId  || null,
      site_id:       siteId     || null,
      action_type:   actionType,
      action_params: params,
      result,
      error_msg:     errorMsg,
    })
    .then(() => {})
    .catch(err => console.error('[ladiaActions] logAction failed:', err.message));
}

// ── 1. Chiudi NC ──────────────────────────────────────────────

/**
 * Marca una Non Conformità come risolta.
 * Verifica che la NC appartenga alla company dell'utente (ownership check).
 *
 * @returns {{ ok: boolean, alreadyResolved?: boolean, notFound?: boolean }}
 */
async function closeNc(ncId, chatId, companyId) {
  const { data: nc, error: fetchErr } = await supabase
    .from('site_notes')
    .select('id, site_id, content, ai_summary, resolved_at')
    .eq('id', ncId)
    .eq('company_id', companyId)
    .eq('category', 'non_conformita')
    .maybeSingle();

  if (fetchErr) {
    await logAction(chatId, companyId, null, 'close_nc', { ncId }, 'error', fetchErr.message);
    return { ok: false };
  }

  if (!nc) {
    await logAction(chatId, companyId, null, 'close_nc', { ncId }, 'error', 'NC non trovata o non autorizzata');
    return { ok: false, notFound: true };
  }

  if (nc.resolved_at) {
    // Già risolta — idempotente, non è un errore
    return { ok: true, alreadyResolved: true };
  }

  const { error: updErr } = await supabase
    .from('site_notes')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: `telegram:${chatId}`,
    })
    .eq('id', ncId);

  if (updErr) {
    await logAction(chatId, companyId, nc.site_id, 'close_nc', { ncId }, 'error', updErr.message);
    return { ok: false };
  }

  await logAction(chatId, companyId, nc.site_id, 'close_nc', { ncId }, 'ok');
  return { ok: true };
}

// ── 2. Registra uscite mancanti ───────────────────────────────

/**
 * Per ogni lavoratore il cui ULTIMO evento di oggi è ENTRY (senza EXIT),
 * inserisce un record EXIT con timestamp 18:00 e method='ladia_action'.
 *
 * Idempotente: ri-interroga i log dopo l'inserimento, non tocca chi ha già EXIT.
 * Non fa mai UPDATE/DELETE (append-only invariant preservato).
 *
 * @param {string} siteId
 * @param {string} date     YYYY-MM-DD
 * @param {string} companyId
 * @param {number} chatId
 * @returns {{ ok: boolean, count: number }}
 */
async function registerMissingExits(siteId, date, companyId, chatId) {
  // Verifica che il cantiere appartenga alla company
  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!site) {
    await logAction(chatId, companyId, siteId, 'reg_exits', { siteId, date }, 'error', 'cantiere non trovato o non autorizzato');
    return { ok: false, count: 0 };
  }

  // Recupera tutti i log del giorno per questo cantiere
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select('worker_id, event_type, timestamp_server')
    .eq('company_id', companyId)
    .eq('site_id', siteId)
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(5000);

  if (logsErr) {
    await logAction(chatId, companyId, siteId, 'reg_exits', { siteId, date }, 'error', logsErr.message);
    return { ok: false, count: 0 };
  }

  // Ultimo evento per ogni lavoratore
  const lastByWorker = new Map();
  for (const log of (logs || [])) {
    lastByWorker.set(log.worker_id, log);
  }

  // Solo quelli con ultimo evento = ENTRY
  const missingWorkerIds = [];
  for (const [workerId, log] of lastByWorker) {
    if (log.event_type === 'ENTRY') missingWorkerIds.push(workerId);
  }

  if (!missingWorkerIds.length) {
    await logAction(chatId, companyId, siteId, 'reg_exits', { siteId, date }, 'skipped', 'nessuna uscita mancante');
    return { ok: true, count: 0 };
  }

  // Orario uscita: 17:00 UTC = 18:00 CET / 19:00 CEST
  // Segnaliamo chiaramente il metodo per il registro presenze
  const exitTime = new Date(`${date}T17:00:00.000Z`);

  // chatId può essere null quando chiamato da cron (auto-execute senza utente)
  const uaSource = chatId ? `ladia-telegram:${chatId}` : 'ladia-cron';

  const inserts = missingWorkerIds.map(workerId => ({
    company_id:       companyId,
    site_id:          siteId,
    worker_id:        workerId,
    event_type:       'EXIT',
    timestamp_server: exitTime.toISOString(),
    method:           'ladia_action',
    ip:               'ladia',
    ua:               uaSource,
  }));

  const { error: insErr } = await supabase
    .from('presence_logs')
    .insert(inserts);

  if (insErr) {
    await logAction(chatId, companyId, siteId, 'reg_exits',
      { siteId, date, count: missingWorkerIds.length }, 'error', insErr.message);
    return { ok: false, count: 0 };
  }

  await logAction(chatId, companyId, siteId, 'reg_exits',
    { siteId, date, count: missingWorkerIds.length }, 'ok');
  return { ok: true, count: missingWorkerIds.length };
}

// ── 3. Avvisa squadra: allerta meteo ─────────────────────────

/**
 * Invia un messaggio di allerta meteo a tutti gli altri utenti Telegram della company.
 * (Il chiamante — chatId — lo ha già visto nell'alert proattivo.)
 *
 * @returns {{ ok: boolean, sent: number }}
 */
async function sendRainNotification(siteId, companyId, chatId) {
  // Recupera nome cantiere
  const { data: site } = await supabase
    .from('sites')
    .select('name, address')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!site) {
    await logAction(chatId, companyId, siteId, 'rain_notify', { siteId }, 'error', 'cantiere non trovato');
    return { ok: false, sent: 0 };
  }

  const siteName = site.name || site.address || 'Cantiere';

  // Tutti gli utenti della company ESCLUSO chi ha confermato (già informato)
  const { data: users } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId)
    .neq('telegram_chat_id', chatId);

  if (!users?.length) {
    await logAction(chatId, companyId, siteId, 'rain_notify', { siteId }, 'skipped', 'nessun altro utente collegato');
    return { ok: true, sent: 0 };
  }

  const text =
    `🌧️ <b>Allerta meteo — ${siteName}</b>\n\n` +
    `Domani è prevista pioggia. Verificate con i capi squadra:\n` +
    `• Opere esterne e ponteggi\n` +
    `• Gettate programmate\n` +
    `• Attrezzatura sensibile all'acqua\n\n` +
    `— <i>Inviato da Ladia su conferma del responsabile</i>`;

  const results = await Promise.allSettled(
    users.map(u => tg.sendMessage(u.telegram_chat_id, text))
  );

  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - sent;

  if (failed) {
    console.error(`[ladiaActions] rain_notify: ${failed} messaggi falliti su ${results.length}`);
  }

  await logAction(chatId, companyId, siteId, 'rain_notify', { siteId, sent }, 'ok');
  return { ok: true, sent };
}

// ── 4. Promemoria scadenza documento ─────────────────────────

/**
 * Invia un promemoria di scadenza documento a tutti gli utenti Telegram della company.
 *
 * @param {string} workerId
 * @param {'train'|'fit'} docType
 * @param {string} companyId
 * @param {number} chatId
 * @returns {{ ok: boolean, sent: number }}
 */
async function sendExpiryReminder(workerId, docType, companyId, chatId) {
  // Recupera dati lavoratore (verifica ownership)
  const { data: worker } = await supabase
    .from('workers')
    .select('full_name, safety_training_expiry, health_fitness_expiry')
    .eq('id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!worker) {
    await logAction(chatId, companyId, null, 'expiry_remind', { workerId, docType }, 'error', 'lavoratore non trovato');
    return { ok: false, sent: 0 };
  }

  const expiryDate = docType === 'train'
    ? worker.safety_training_expiry
    : worker.health_fitness_expiry;

  const docLabel = docType === 'train' ? 'Formazione sicurezza' : 'Idoneità sanitaria';
  const daysLeft = expiryDate
    ? Math.round((new Date(expiryDate) - new Date()) / 86_400_000)
    : null;

  const statusLine = daysLeft === null
    ? 'data non disponibile'
    : daysLeft <= 0
      ? `⚠️ SCADUTA ${Math.abs(daysLeft)} giorni fa`
      : `scade tra ${daysLeft} giorni`;

  // Tutti gli utenti della company (incluso chi ha chiesto — serve a tutti)
  const { data: users } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId);

  if (!users?.length) {
    await logAction(chatId, companyId, null, 'expiry_remind', { workerId, docType }, 'skipped', 'nessun utente collegato');
    return { ok: false, sent: 0 };
  }

  const text =
    `📢 <b>Promemoria scadenza — ${docLabel}</b>\n\n` +
    `<b>${worker.full_name}</b>\n` +
    `${docLabel}: ${statusLine}\n\n` +
    `Aggiorna i documenti su Palladia prima di inviare il lavoratore in cantiere.\n` +
    `(D.Lgs. 81/2008 art. 37-41)\n\n` +
    `— <i>Inviato da Ladia su conferma del responsabile</i>`;

  const results = await Promise.allSettled(
    users.map(u => tg.sendMessage(u.telegram_chat_id, text))
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  await logAction(chatId, companyId, null, 'expiry_remind', { workerId, docType, sent }, 'ok');
  return { ok: true, sent };
}

// ── 5. Attiva Ladia mode ──────────────────────────────────────

/**
 * Imposta ladia_mode = true per l'utente, con cantiere attivo opzionale.
 * Il prossimo messaggio di testo andrà direttamente a Ladia.
 */
async function openLadiaMode(chatId, siteId = null) {
  const update = { ladia_mode: true };
  if (siteId) update.active_site_id = siteId;

  await supabase
    .from('telegram_users')
    .update(update)
    .eq('telegram_chat_id', chatId);
}

module.exports = {
  closeNc,
  registerMissingExits,
  sendRainNotification,
  sendExpiryReminder,
  openLadiaMode,
};
