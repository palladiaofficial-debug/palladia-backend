'use strict';
/**
 * services/telegramOwner.js
 * Pannello owner Palladia — accessibile solo dal TELEGRAM_OWNER_CHAT_ID.
 *
 * Interfaccia a bottoni: nessun comando da ricordare.
 * Scrivi qualsiasi cosa → appare il menu principale.
 * Ogni pannello ha [🔄 Aggiorna] e [🏠 Menu] per navigare.
 */

const tg          = require('./telegram');
const supabase    = require('../lib/supabase');
const errorBuffer = require('../lib/errorBuffer');
const { getStripe } = require('./stripe');

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID
  ? parseInt(process.env.TELEGRAM_OWNER_CHAT_ID, 10)
  : null;

function isOwner(chatId) {
  return OWNER_CHAT_ID && chatId === OWNER_CHAT_ID;
}

// ── Tastiera menu principale ──────────────────────────────────

const MAIN_MENU = tg.buildInlineKeyboard([
  { text: '📊 KPI Piattaforma',   callbackData: 'owner:kpi'     },
  { text: '💳 Stripe & Incassi',  callbackData: 'owner:stripe'  },
  { text: '👥 Ultimi Iscritti',   callbackData: 'owner:users'   },
  { text: '🗄 Database',          callbackData: 'owner:db'      },
  { text: '🐛 Errori Recenti',    callbackData: 'owner:errors'  },
  { text: '⚙️ Stato Sistema',     callbackData: 'owner:status'  },
], 2);

const NAV_BUTTONS = tg.buildInlineKeyboard([
  { text: '🔄 Aggiorna', callbackData: '__REFRESH__' }, // placeholder, sostituito dinamicamente
  { text: '🏠 Menu',     callbackData: 'owner:menu'  },
], 2);

function navButtons(refreshCallback) {
  return tg.buildInlineKeyboard([
    { text: '🔄 Aggiorna', callbackData: refreshCallback },
    { text: '🏠 Menu',     callbackData: 'owner:menu'   },
  ], 2);
}

// ── Entry point messaggi ──────────────────────────────────────

async function handleOwnerMessage(msg) {
  const chatId = msg.chat.id;

  // Guard assoluto — doppio controllo anche se chiamato dall'handler esterno
  if (!isOwner(chatId)) return;

  await tg.sendMessage(chatId,
    `<b>🛠 Palladia Owner Panel</b>\n\nCosa vuoi vedere?`,
    { replyMarkup: MAIN_MENU }
  );
}

// ── Entry point callback (bottoni) ───────────────────────────

async function handleOwnerCallback(cbq) {
  const chatId    = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  const data      = cbq.data;

  // Guard assoluto — verifica che sia l'owner sia sul messaggio che sul mittente del tap
  if (!isOwner(cbq.from.id) || !isOwner(chatId)) {
    await tg.answerCallbackQuery(cbq.id, '');
    return;
  }

  // Rispondi subito al tap (toglie il loading)
  await tg.answerCallbackQuery(cbq.id, '');

  try {
    switch (data) {
      case 'owner:menu':
        return await tg.editMessageText(chatId, messageId,
          `<b>🛠 Palladia Owner Panel</b>\n\nCosa vuoi vedere?`,
          { replyMarkup: MAIN_MENU }
        );

      case 'owner:kpi':
        return await showKpi(chatId, messageId);

      case 'owner:stripe':
        return await showStripe(chatId, messageId);

      case 'owner:users':
        return await showUsers(chatId, messageId);

      case 'owner:db':
        return await showDb(chatId, messageId);

      case 'owner:errors':
        return await showErrors(chatId, messageId);

      case 'owner:status':
        return await showStatus(chatId, messageId);
    }
  } catch (err) {
    console.error('[telegramOwner] callback error:', err.message);
    await tg.editMessageText(chatId, messageId,
      `❌ <b>Errore</b>\n<code>${err.message}</code>`,
      { replyMarkup: navButtons('owner:menu') }
    );
  }
}

// ── 📊 KPI Piattaforma ────────────────────────────────────────

async function showKpi(chatId, messageId) {
  await tg.editMessageText(chatId, messageId, `⏳ Carico KPI…`);

  const todayRome = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const weekAgo   = new Date(Date.now() - 7  * 86400_000).toISOString();
  const monthAgo  = new Date(Date.now() - 30 * 86400_000).toISOString();

  const [companiesRes, subsRes, workersRes, sitesRes, presenceRes, newWeekRes, newMonthRes] =
    await Promise.all([
      supabase.from('companies').select('id', { count: 'exact', head: true }),
      supabase.from('companies').select('subscription_status, subscription_plan'),
      supabase.from('workers').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('sites').select('id', { count: 'exact', head: true }).eq('status', 'attivo'),
      supabase.from('presence_logs').select('id', { count: 'exact', head: true })
        .gte('timestamp_server', new Date(Date.now() - 30 * 3600_000).toISOString()),
      supabase.from('companies').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo),
      supabase.from('companies').select('id', { count: 'exact', head: true }).gte('created_at', monthAgo),
    ]);

  const subs     = subsRes.data || [];
  const active   = subs.filter(s => s.subscription_status === 'active').length;
  const trial    = subs.filter(s => s.subscription_status === 'trial').length;
  const pastDue  = subs.filter(s => s.subscription_status === 'past_due').length;
  const canceled = subs.filter(s => s.subscription_status === 'canceled').length;

  const byPlan = {};
  for (const s of subs.filter(x => x.subscription_status === 'active')) {
    const p = s.subscription_plan || '?';
    byPlan[p] = (byPlan[p] || 0) + 1;
  }
  const planLines = Object.entries(byPlan).map(([p, n]) => `  • ${p}: ${n}`).join('\n') || '  —';

  const text =
    `<b>📊 KPI Palladia — ${todayRome}</b>\n\n` +
    `<b>Aziende totali:</b> ${companiesRes.count ?? '?'}\n` +
    `<b>Nuove ultimi 7gg:</b> ${newWeekRes.count ?? '?'}\n` +
    `<b>Nuove ultimi 30gg:</b> ${newMonthRes.count ?? '?'}\n\n` +
    `<b>Abbonamenti:</b>\n` +
    `  ✅ Attivi: <b>${active}</b>\n` +
    `  🕐 Trial: ${trial}\n` +
    `  ⚠️ Past due: ${pastDue}\n` +
    `  ❌ Cancellati: ${canceled}\n\n` +
    `<b>Piani attivi:</b>\n${planLines}\n\n` +
    `<b>Cantieri attivi:</b> ${sitesRes.count ?? '?'}\n` +
    `<b>Lavoratori attivi:</b> ${workersRes.count ?? '?'}\n` +
    `<b>Timbrature ultime 30h:</b> ${presenceRes.count ?? '?'}`;

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:kpi') });
}

// ── 💳 Stripe & Incassi ───────────────────────────────────────

async function showStripe(chatId, messageId) {
  await tg.editMessageText(chatId, messageId, `⏳ Carico dati Stripe…`);

  let text;
  try {
    const stripe = getStripe();
    const now        = new Date();
    const startMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const startToday = Math.floor(new Date(
      now.toLocaleDateString('sv', { timeZone: 'Europe/Rome' }) + 'T00:00:00+01:00'
    ).getTime() / 1000);

    const [subsAll, chargesMonth, chargesToday] = await Promise.all([
      stripe.subscriptions.list({ status: 'active', limit: 100 }),
      stripe.charges.list({ created: { gte: startMonth }, limit: 100 }),
      stripe.charges.list({ created: { gte: startToday }, limit: 100 }),
    ]);

    let mrr = 0;
    for (const sub of subsAll.data) {
      for (const item of sub.items.data) {
        const amount = item.price.unit_amount || 0;
        const interval = item.price.recurring?.interval;
        if (interval === 'month') mrr += amount;
        else if (interval === 'year') mrr += Math.round(amount / 12);
      }
    }

    const totMonth = chargesMonth.data.filter(c => c.paid && !c.refunded).reduce((s, c) => s + c.amount, 0);
    const totToday = chargesToday.data.filter(c => c.paid && !c.refunded).reduce((s, c) => s + c.amount, 0);
    const fmt = (c) => `€ ${(c / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

    const planCount = {};
    for (const sub of subsAll.data) {
      const nick = sub.items.data[0]?.price?.nickname || sub.items.data[0]?.price?.id || '?';
      planCount[nick] = (planCount[nick] || 0) + 1;
    }
    const planLines = Object.entries(planCount).map(([p, n]) => `  • ${p}: ${n}`).join('\n') || '  —';

    const mese = now.toLocaleString('it-IT', { month: 'long', year: 'numeric' });
    text =
      `<b>💳 Stripe — ${mese}</b>\n\n` +
      `<b>MRR:</b> <b>${fmt(mrr)}</b>\n` +
      `<b>Abbonamenti attivi:</b> ${subsAll.data.length}\n\n` +
      `<b>Incassato oggi:</b> ${fmt(totToday)}\n` +
      `<b>Incassato questo mese:</b> ${fmt(totMonth)}\n\n` +
      `<b>Breakdown piani:</b>\n${planLines}`;
  } catch (err) {
    text = `<b>💳 Stripe</b>\n\n⚠️ ${err.message}`;
  }

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:stripe') });
}

// ── 👥 Ultimi Iscritti ────────────────────────────────────────

async function showUsers(chatId, messageId) {
  await tg.editMessageText(chatId, messageId, `⏳ Carico iscritti…`);

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, subscription_status, subscription_plan, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  // Prende gli user_id owner per ogni azienda
  const companyIds = (companies || []).map(c => c.id);
  const { data: members } = companyIds.length > 0
    ? await supabase
        .from('company_users')
        .select('company_id, user_id, role')
        .in('company_id', companyIds)
        .eq('role', 'owner')
    : { data: [] };

  // Prende le email da auth.users
  const userIds = [...new Set((members || []).map(m => m.user_id))];
  const emailMap = {};
  for (const uid of userIds) {
    try {
      const { data } = await supabase.auth.admin.getUserById(uid);
      if (data?.user?.email) emailMap[uid] = data.user.email;
    } catch { /* ignora */ }
  }

  const ownerByCompany = {};
  for (const m of (members || [])) {
    ownerByCompany[m.company_id] = emailMap[m.user_id] || '—';
  }

  const statusEmoji = { active: '✅', trial: '🕐', past_due: '⚠️', canceled: '❌' };
  const rows = (companies || []).map(c => {
    const d    = new Date(c.created_at);
    const date = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    const st   = statusEmoji[c.subscription_status] || '?';
    const email = ownerByCompany[c.id] || '—';
    return `${st} <b>${c.name || 'N/A'}</b>\n   ${email}\n   ${date} · ${c.subscription_plan || 'trial'}`;
  }).join('\n\n');

  const text =
    `<b>👥 Ultimi 10 iscritti</b>\n\n` +
    (rows || '  Nessuna azienda registrata.');

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:users') });
}

// ── 🗄 Database ───────────────────────────────────────────────

async function showDb(chatId, messageId) {
  await tg.editMessageText(chatId, messageId, `⏳ Carico statistiche DB…`);

  const [comp, workers, sites, logs, sessions, notes, prezzario] = await Promise.all([
    supabase.from('companies').select('id', { count: 'exact', head: true }),
    supabase.from('workers').select('id', { count: 'exact', head: true }),
    supabase.from('sites').select('id', { count: 'exact', head: true }).neq('status', 'eliminato'),
    supabase.from('presence_logs').select('id', { count: 'exact', head: true }),
    supabase.from('worker_device_sessions').select('id', { count: 'exact', head: true }).is('revoked_at', null),
    supabase.from('site_coordinator_notes').select('id', { count: 'exact', head: true }),
    supabase.from('prezzario_voci').select('id', { count: 'exact', head: true }),
  ]);

  const text =
    `<b>🗄 Database Palladia</b>\n\n` +
    `<b>Aziende:</b> ${comp.count ?? '?'}\n` +
    `<b>Lavoratori:</b> ${workers.count ?? '?'}\n` +
    `<b>Cantieri:</b> ${sites.count ?? '?'}\n` +
    `<b>Timbrature totali:</b> ${(logs.count ?? 0).toLocaleString('it-IT')}\n` +
    `<b>Sessioni badge attive:</b> ${sessions.count ?? '?'}\n` +
    `<b>Note coordinatori:</b> ${notes.count ?? '?'}\n` +
    `<b>Voci prezzario:</b> ${prezzario.count ?? '?'}`;

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:db') });
}

// ── 🐛 Errori Recenti ─────────────────────────────────────────

async function showErrors(chatId, messageId) {
  const errors = errorBuffer.recent(8);

  let text;
  if (errors.length === 0) {
    text = `<b>🐛 Errori Recenti</b>\n\n✅ Nessun errore dal boot.`;
  } else {
    const rows = errors.map((e, i) => {
      const ts   = new Date(e.ts).toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const path = e.path ? ` [${e.path}]` : '';
      return `<b>${i + 1}.</b> ${ts}${path}\n<code>${e.message.slice(0, 120)}</code>`;
    }).join('\n\n');

    text = `<b>🐛 Ultimi ${errors.length} errori</b>\n\n${rows}`;
  }

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:errors') });
}

// ── ⚙️ Stato Sistema ──────────────────────────────────────────

async function showStatus(chatId, messageId) {
  const upSec = process.uptime();
  const h = Math.floor(upSec / 3600);
  const m = Math.floor((upSec % 3600) / 60);
  const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;

  const mem    = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb  = Math.round(mem.rss      / 1024 / 1024);
  const now    = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  const t0 = Date.now();
  await supabase.from('companies').select('id').limit(1);
  const dbPing = Date.now() - t0;

  const dbStatus = dbPing < 300 ? '🟢' : dbPing < 800 ? '🟡' : '🔴';

  const text =
    `<b>⚙️ Stato Sistema</b>\n\n` +
    `<b>Ora:</b> ${now}\n` +
    `<b>Uptime:</b> ${uptime}\n\n` +
    `<b>Memoria heap:</b> ${heapMb} MB\n` +
    `<b>Memoria RSS:</b> ${rssMb} MB\n\n` +
    `${dbStatus} <b>DB ping:</b> ${dbPing} ms\n` +
    `<b>Node:</b> ${process.version}\n` +
    `<b>Env:</b> ${process.env.NODE_ENV || 'development'}`;

  return tg.editMessageText(chatId, messageId, text, { replyMarkup: navButtons('owner:status') });
}

module.exports = { isOwner, handleOwnerMessage, handleOwnerCallback };
