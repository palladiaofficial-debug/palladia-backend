'use strict';
/**
 * services/telegramOwner.js
 * Bot Telegram privato per l'owner di Palladia.
 * Accessibile solo dal TELEGRAM_OWNER_CHAT_ID configurato in env.
 *
 * Comandi:
 *   /kpi     — KPI piattaforma (aziende, abbonati, MRR, cantieri, timbrature oggi)
 *   /stripe  — Incassi Stripe (oggi, mese, MRR, breakdown per piano)
 *   /db      — Statistiche database
 *   /status  — Stato sistema (uptime, memoria, versione)
 *   /help    — Lista comandi
 *   /ping    — Test bot attivo
 */

const tg       = require('./telegram');
const supabase = require('../lib/supabase');
const { getStripe } = require('./stripe');

// Chat ID dell'owner — configurato in env
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID
  ? parseInt(process.env.TELEGRAM_OWNER_CHAT_ID, 10)
  : null;

/** Restituisce true se il chatId appartiene all'owner. */
function isOwner(chatId) {
  return OWNER_CHAT_ID && chatId === OWNER_CHAT_ID;
}

/** Entry point — chiamato da telegramHandler.js PRIMA di qualsiasi altro routing. */
async function handleOwnerMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const cmd    = text.split(/\s+/)[0].toLowerCase();

  try {
    switch (cmd) {
      case '/ping':   return await cmdPing(chatId);
      case '/help':   return await cmdHelp(chatId);
      case '/kpi':    return await cmdKpi(chatId);
      case '/stripe': return await cmdStripe(chatId);
      case '/db':     return await cmdDb(chatId);
      case '/status': return await cmdStatus(chatId);
      default:
        return await tg.sendMessage(chatId,
          `❓ Comando non riconosciuto.\nUsa /help per la lista comandi.`
        );
    }
  } catch (err) {
    console.error('[telegramOwner] errore comando', cmd, err.message);
    return tg.sendMessage(chatId, `❌ Errore: <code>${err.message}</code>`);
  }
}

// ── /ping ─────────────────────────────────────────────────────────────────────
async function cmdPing(chatId) {
  const now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  return tg.sendMessage(chatId,
    `✅ <b>Palladia Bot attivo</b>\n🕐 ${now}`
  );
}

// ── /help ─────────────────────────────────────────────────────────────────────
async function cmdHelp(chatId) {
  return tg.sendMessage(chatId,
    `<b>🛠 Palladia Owner Panel</b>\n\n` +
    `/kpi — KPI piattaforma\n` +
    `/stripe — Incassi e abbonamenti Stripe\n` +
    `/db — Statistiche database\n` +
    `/status — Stato sistema e memoria\n` +
    `/ping — Test bot attivo\n` +
    `/help — Questo messaggio`
  );
}

// ── /kpi ──────────────────────────────────────────────────────────────────────
async function cmdKpi(chatId) {
  await tg.sendMessage(chatId, `⏳ Carico KPI…`);

  const todayRome = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const weekAgo   = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [
    companiesRes,
    subscriptionsRes,
    workersRes,
    sitesRes,
    presenceRes,
    newCompaniesRes,
  ] = await Promise.all([
    // Tutte le aziende
    supabase.from('companies').select('id', { count: 'exact', head: true }),
    // Abbonamenti per stato
    supabase.from('companies').select('subscription_status, subscription_plan'),
    // Totale lavoratori attivi
    supabase.from('workers').select('id', { count: 'exact', head: true }).eq('is_active', true),
    // Cantieri attivi
    supabase.from('sites').select('id', { count: 'exact', head: true }).eq('status', 'attivo'),
    // Timbrature oggi
    supabase
      .from('presence_logs')
      .select('id', { count: 'exact', head: true })
      .gte('timestamp_server', new Date(Date.now() - 30 * 3600_000).toISOString()),
    // Nuove aziende ultimi 7 giorni
    supabase.from('companies').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo),
  ]);

  const total      = companiesRes.count  ?? '?';
  const workers    = workersRes.count    ?? '?';
  const sites      = sitesRes.count      ?? '?';
  const punches    = presenceRes.count   ?? '?';
  const newCo      = newCompaniesRes.count ?? '?';
  const subs       = subscriptionsRes.data || [];

  const byStatus = {
    active:   subs.filter(s => s.subscription_status === 'active').length,
    trial:    subs.filter(s => s.subscription_status === 'trial').length,
    past_due: subs.filter(s => s.subscription_status === 'past_due').length,
    canceled: subs.filter(s => s.subscription_status === 'canceled').length,
  };

  const byPlan = {};
  for (const s of subs.filter(x => x.subscription_status === 'active')) {
    const p = s.subscription_plan || 'unknown';
    byPlan[p] = (byPlan[p] || 0) + 1;
  }

  const planLines = Object.entries(byPlan)
    .map(([p, n]) => `  • ${p}: ${n}`)
    .join('\n') || '  (nessuno)';

  return tg.sendMessage(chatId,
    `<b>📊 KPI Palladia — ${todayRome}</b>\n\n` +
    `<b>Aziende totali:</b> ${total}\n` +
    `<b>Nuove (7gg):</b> ${newCo}\n\n` +
    `<b>Abbonamenti:</b>\n` +
    `  ✅ Attivi: ${byStatus.active}\n` +
    `  🕐 Trial: ${byStatus.trial}\n` +
    `  ⚠️ Past due: ${byStatus.past_due}\n` +
    `  ❌ Cancellati: ${byStatus.canceled}\n\n` +
    `<b>Piani attivi:</b>\n${planLines}\n\n` +
    `<b>Cantieri attivi:</b> ${sites}\n` +
    `<b>Lavoratori attivi:</b> ${workers}\n` +
    `<b>Timbrature ultime 30h:</b> ${punches}`
  );
}

// ── /stripe ───────────────────────────────────────────────────────────────────
async function cmdStripe(chatId) {
  await tg.sendMessage(chatId, `⏳ Carico dati Stripe…`);

  const stripe = getStripe();

  // Periodo: inizio mese corrente (Unix timestamp)
  const now        = new Date();
  const startMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const startToday = Math.floor(new Date(now.toLocaleDateString('sv', { timeZone: 'Europe/Rome' }) + 'T00:00:00+01:00').getTime() / 1000);

  const [subsAll, chargesMonth, chargesToday] = await Promise.all([
    stripe.subscriptions.list({ status: 'active', limit: 100 }),
    stripe.charges.list({ created: { gte: startMonth }, limit: 100 }),
    stripe.charges.list({ created: { gte: startToday }, limit: 100 }),
  ]);

  // MRR: somma amount degli abbonamenti attivi (mensile)
  let mrr = 0;
  for (const sub of subsAll.data) {
    for (const item of sub.items.data) {
      const amount   = item.price.unit_amount || 0;
      const interval = item.price.recurring?.interval;
      if (interval === 'month') mrr += amount;
      else if (interval === 'year') mrr += Math.round(amount / 12);
    }
  }

  const totMonth = chargesMonth.data
    .filter(c => c.paid && !c.refunded)
    .reduce((s, c) => s + c.amount, 0);

  const totToday = chargesToday.data
    .filter(c => c.paid && !c.refunded)
    .reduce((s, c) => s + c.amount, 0);

  const fmt = (cents) => `€ ${(cents / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

  // Conteggio abbonamenti per piano (dal metadata o dal nickname del price)
  const planCount = {};
  for (const sub of subsAll.data) {
    const nick = sub.items.data[0]?.price?.nickname || 'unknown';
    planCount[nick] = (planCount[nick] || 0) + 1;
  }
  const planLines = Object.entries(planCount)
    .map(([p, n]) => `  • ${p}: ${n}`)
    .join('\n') || '  (nessuno)';

  const mese = now.toLocaleString('it-IT', { month: 'long', year: 'numeric' });

  return tg.sendMessage(chatId,
    `<b>💳 Stripe — ${mese}</b>\n\n` +
    `<b>MRR:</b> ${fmt(mrr)}\n` +
    `<b>Abbonamenti attivi:</b> ${subsAll.data.length}\n\n` +
    `<b>Incassato oggi:</b> ${fmt(totToday)}\n` +
    `<b>Incassato questo mese:</b> ${fmt(totMonth)}\n\n` +
    `<b>Breakdown piani:</b>\n${planLines}`
  );
}

// ── /db ───────────────────────────────────────────────────────────────────────
async function cmdDb(chatId) {
  await tg.sendMessage(chatId, `⏳ Carico statistiche DB…`);

  const [comp, workers, sites, logs, sessions, notes] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }),
    supabase.from('workers').select('id', { count: 'exact', head: true }),
    supabase.from('sites').select('id', { count: 'exact', head: true }).neq('status', 'eliminato'),
    supabase.from('presence_logs').select('id', { count: 'exact', head: true }),
    supabase.from('worker_device_sessions').select('id', { count: 'exact', head: true }).is('revoked_at', null),
    supabase.from('site_coordinator_notes').select('id', { count: 'exact', head: true }),
  ]);

  return tg.sendMessage(chatId,
    `<b>🗄 Database Palladia</b>\n\n` +
    `<b>Aziende:</b> ${comp.count ?? '?'}\n` +
    `<b>Lavoratori:</b> ${workers.count ?? '?'}\n` +
    `<b>Cantieri:</b> ${sites.count ?? '?'}\n` +
    `<b>Timbrature totali:</b> ${(logs.count ?? 0).toLocaleString('it-IT')}\n` +
    `<b>Sessioni badge attive:</b> ${sessions.count ?? '?'}\n` +
    `<b>Note coordinatori:</b> ${notes.count ?? '?'}`
  );
}

// ── /status ───────────────────────────────────────────────────────────────────
async function cmdStatus(chatId) {
  const uptimeSec  = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;

  const mem     = process.memoryUsage();
  const heapMb  = Math.round(mem.heapUsed  / 1024 / 1024);
  const rssМb   = Math.round(mem.rss       / 1024 / 1024);

  const now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  // Ping Supabase (query leggera)
  const t0 = Date.now();
  await supabase.from('companies').select('id').limit(1);
  const dbPing = Date.now() - t0;

  return tg.sendMessage(chatId,
    `<b>⚙️ Stato sistema</b>\n\n` +
    `<b>Ora:</b> ${now}\n` +
    `<b>Uptime:</b> ${uptime}\n\n` +
    `<b>Memoria heap:</b> ${heapMb} MB\n` +
    `<b>Memoria RSS:</b> ${rssМb} MB\n\n` +
    `<b>DB ping:</b> ${dbPing} ms\n` +
    `<b>Node:</b> ${process.version}\n` +
    `<b>Env:</b> ${process.env.NODE_ENV || 'development'}`
  );
}

module.exports = { isOwner, handleOwnerMessage };
