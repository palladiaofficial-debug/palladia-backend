'use strict';
// ── Riepilogo unico delle 7:30 (F-240, Le quattro porte passo 4) ──────────────
// Prima: ogni mattina fino a 5 automatismi (documenti lavoratori 7:05, mezzi
// 7:10, documenti aziendali 7:12, suolo pubblico 7:20, compleanni) scrivevano
// ognuno per conto suo su Telegram e notifiche dell'app, più i "risolto".
// Dopo, con il flag `alert_digest` acceso:
//   - quegli automatismi continuano ad aggiornare i dati (notifiche, Da fare)
//     ma NON scrivono: il loro messaggio va in coda (alert_digest_queue);
//   - alle 7:30 un solo messaggio con le righe NUOVE di Da fare (scadute o di
//     questa settimana, mai comunicate prima) + i compleanni del giorno;
//   - rete di sicurezza: se il riepilogo va in errore, oppure alle 7:50 per
//     un'azienda non risulta partito, la coda viene spedita com'è (i messaggi
//     di sempre). Nel caso peggiore arrivano i vecchi avvisi, mai il silenzio.
// Gli avvisi urgenti (lavoratore bloccato alla timbratura, richiesta di aiuto,
// uscite dimenticate la sera) non passano da qui: restano immediati.
// Le email restano quelle di prima (report del lunedì, certificati).
// ──────────────────────────────────────────────────────────────────────────────
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');
const daFare = require('./daFare'); // via oggetto: i test possono simulare un guasto
const { romeDate } = daFare;

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'https://palladia.net';
const MAX_LINES = 10;

// Moduli di invio caricati al momento dell'uso: telegramNotifications usa
// questo modulo per mettere in coda, un require in testa creerebbe un ciclo.
function senders() {
  return {
    notifyCompany: require('../services/telegramNotifications').notifyCompany,
    sendPushToCompany: require('../services/pushNotifications').sendPushToCompany,
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function isDigestEnabled(companyId) {
  try { return await isFeatureEnabled(companyId, 'alert_digest'); } catch { return false; }
}

/**
 * Da chiamare al posto dell'invio immediato. Con il riepilogo acceso mette il
 * messaggio in coda; se il riepilogo è spento, o la coda non è scrivibile,
 * esegue `sendNow` (comportamento di prima) — mai perdere un avviso.
 */
async function queueOrSend(companyId, { kind, telegramText = null, push = null }, sendNow) {
  if (await isDigestEnabled(companyId)) {
    const { error } = await supabase.from('alert_digest_queue').insert({
      company_id: companyId, kind, telegram_text: telegramText, push,
    });
    if (!error) return { queued: true };
    console.error(`[alertDigest] coda non scrivibile per ${companyId}, invio subito:`, error.message);
  }
  await sendNow();
  return { queued: false };
}

function startOfRomeDayIso(dateStr) {
  // mezzanotte italiana di dateStr, in UTC (CET/CEST: -1h / -2h)
  const guess = new Date(`${dateStr}T00:00:00+02:00`);
  return romeDate(guess) === dateStr ? guess.toISOString() : new Date(`${dateStr}T00:00:00+01:00`).toISOString();
}

async function pendingQueue(companyId, todayStr) {
  const { data, error } = await supabase.from('alert_digest_queue')
    .select('id, kind, telegram_text, push, created_at')
    .eq('company_id', companyId).is('delivered_at', null)
    .gte('created_at', startOfRomeDayIso(todayStr))
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function markDelivered(ids, via) {
  if (!ids.length) return;
  await supabase.from('alert_digest_queue')
    .update({ delivered_at: new Date().toISOString(), delivered_via: via })
    .in('id', ids);
}

/**
 * Costruisce il testo del riepilogo senza inviare nulla (usato anche
 * dall'anteprima). Ritorna `null` se non c'è niente di nuovo da dire.
 */
async function buildDigest(companyId, { todayStr = romeDate(), queue = null } = {}) {
  const list = await daFare.buildDaFare(companyId, null, { todayStr });
  const attention = list.items.filter(i => i.bucket === 'scaduto' || i.bucket === 'settimana');

  const { data: sentRows, error } = await supabase.from('da_fare_digest_sent')
    .select('item_id').eq('company_id', companyId);
  if (error) throw new Error(error.message);
  const already = new Set((sentRows || []).map(r => r.item_id));
  // Primo riepilogo in assoluto per questa azienda: le righe aperte sono
  // arretrati, non novità. Si dice quante sono, le più urgenti, e da lì in
  // poi solo le novità (visto con l'anteprima sui dati reali: 52 righe).
  const firstEver = already.size === 0;
  // Urgenti (richiesta di aiuto dalla timbratura) sempre in cima.
  const fresh = attention.filter(i => !already.has(i.id))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));

  const q = queue ?? await pendingQueue(companyId, todayStr);
  const birthdays = q.filter(r => r.kind === 'birthday');

  if (!fresh.length && !birthdays.length) return null;

  const lines = [];
  const shown = firstEver ? 5 : MAX_LINES;
  if (fresh.length && firstEver) {
    const expired = fresh.filter(i => i.bucket === 'scaduto').length;
    lines.push('☀️ <b>Buongiorno — da oggi Palladia ti scrive una volta sola, alle 7:30</b>');
    lines.push('');
    lines.push(`In Da fare hai ${fresh.length === 1 ? '1 cosa aperta' : `${fresh.length} cose aperte`}${expired ? ` (${expired} scadute)` : ''}. Le più urgenti:`);
    lines.push('');
  } else if (fresh.length) {
    lines.push(`☀️ <b>Buongiorno — ${fresh.length === 1 ? '1 cosa nuova da fare' : `${fresh.length} cose nuove da fare`}</b>`);
    lines.push('');
  }
  if (fresh.length) {
    for (const it of fresh.slice(0, shown)) {
      const dot = it.urgent || it.bucket === 'scaduto' ? '🔴' : '🟠';
      lines.push(`${dot} ${esc(it.title)}${it.subtitle ? ` · <i>${esc(it.subtitle.split('\n')[0])}</i>` : ''}`);
    }
    if (fresh.length > shown) lines.push(`… e altre ${fresh.length - shown}`);
    if (firstEver) { lines.push(''); lines.push('Da domani ti scrivo solo le novità.'); }
  } else {
    lines.push('☀️ <b>Buongiorno</b>');
  }
  if (birthdays.length) {
    lines.push('');
    for (const b of birthdays) {
      const who = (b.telegram_text || '').replace(/<[^>]+>/g, '').split('\n').filter(l => l.startsWith('🎉')).map(l => l.replace('🎉', '').trim());
      lines.push(`🎂 Compleanno oggi: ${esc(who.join(', ') || 'un lavoratore')}`);
    }
  }
  if (!firstEver && list.attention > fresh.length) {
    lines.push('');
    lines.push(`In tutto ${list.attention} cose aperte tra scadute e di questa settimana.`);
  }
  lines.push('');
  lines.push(`Apri Da fare: ${APP_URL}/scadenze`);

  return {
    text: lines.join('\n'),
    push: {
      title: fresh.length
        ? (firstEver ? `Da fare: ${fresh.length} ${fresh.length === 1 ? 'cosa aperta' : 'cose aperte'}` : `Da fare: ${fresh.length} ${fresh.length === 1 ? 'cosa nuova' : 'cose nuove'}`)
        : 'Buongiorno',
      body: (fresh[0]?.title || (birthdays.length ? 'Compleanni di oggi' : '')).slice(0, 110),
      tag: 'palladia-digest',
      url: '/scadenze',
    },
    freshIds: fresh.map(i => i.id),
    queueIds: q.map(r => r.id),
    total: list.attention,
  };
}

/** Spedisce la coda del giorno così com'è (i messaggi di sempre). */
async function sendQueueAsIs(companyId, todayStr = romeDate()) {
  const { notifyCompany, sendPushToCompany } = senders();
  const q = await pendingQueue(companyId, todayStr);
  for (const r of q) {
    if (r.telegram_text) await notifyCompany(companyId, r.telegram_text).catch(() => {});
    if (r.push) await sendPushToCompany(companyId, r.push).catch(() => {});
  }
  await markDelivered(q.map(r => r.id), 'fallback');
  return q.length;
}

async function recordRun(companyId, todayStr, status, items, error = null) {
  await supabase.from('alert_digest_runs').upsert(
    { company_id: companyId, run_date: todayStr, status, items, error },
    { onConflict: 'company_id,run_date' },
  );
}

async function runDigestForCompany(companyId, { todayStr = romeDate() } = {}) {
  try {
    const queue = await pendingQueue(companyId, todayStr);
    const digest = await buildDigest(companyId, { todayStr, queue });
    if (!digest) {
      // Niente di nuovo: i messaggi in coda (scadenze già comunicate,
      // "risolto") restano come traccia, non si ripetono.
      await markDelivered(queue.map(r => r.id), 'digest');
      await recordRun(companyId, todayStr, 'empty', 0);
      return { status: 'empty' };
    }
    const { notifyCompany, sendPushToCompany } = senders();
    await notifyCompany(companyId, digest.text);
    await sendPushToCompany(companyId, digest.push).catch(() => {});
    if (digest.freshIds.length) {
      const { error } = await supabase.from('da_fare_digest_sent').upsert(
        digest.freshIds.map(id => ({ company_id: companyId, item_id: id, sent_on: todayStr })),
        { onConflict: 'company_id,item_id', ignoreDuplicates: true },
      );
      if (error) console.error(`[alertDigest] registro righe inviate non scritto (${companyId}):`, error.message);
    }
    await markDelivered(digest.queueIds, 'digest');
    await recordRun(companyId, todayStr, 'sent', digest.freshIds.length);
    return { status: 'sent', items: digest.freshIds.length };
  } catch (err) {
    console.error(`[alertDigest] riepilogo fallito per ${companyId}, invio i messaggi di sempre:`, err.message);
    let n = 0;
    try { n = await sendQueueAsIs(companyId, todayStr); } catch (e) { console.error('[alertDigest] anche la rete di sicurezza è fallita:', e.message); }
    await recordRun(companyId, todayStr, 'failed', n, String(err.message).slice(0, 500)).catch(() => {});
    return { status: 'failed', fallback: n };
  }
}

/** Aziende da considerare: chi può ricevere qualcosa, o ha messaggi in coda oggi. */
async function candidateCompanies(todayStr) {
  const [tg, push, queue] = await Promise.all([
    supabase.from('telegram_users').select('company_id'),
    supabase.from('push_subscriptions').select('company_id'),
    supabase.from('alert_digest_queue').select('company_id').is('delivered_at', null).gte('created_at', startOfRomeDayIso(todayStr)),
  ]);
  const ids = new Set();
  for (const r of [...(tg.data || []), ...(push.data || []), ...(queue.data || [])]) if (r.company_id) ids.add(r.company_id);
  return [...ids];
}

async function runDigest({ todayStr = romeDate() } = {}) {
  const companies = await candidateCompanies(todayStr);
  const summary = { sent: 0, empty: 0, failed: 0, skipped: 0 };
  for (const companyId of companies) {
    if (!(await isDigestEnabled(companyId))) { summary.skipped++; continue; }
    const r = await runDigestForCompany(companyId, { todayStr });
    summary[r.status]++;
  }
  console.log(`[alertDigest] riepilogo ${todayStr}: ${JSON.stringify(summary)}`);
  return summary;
}

/** 7:50 — chi ha messaggi in coda ma nessun giro registrato oggi li riceve comunque. */
async function runWatchdog({ todayStr = romeDate() } = {}) {
  const { data: pending } = await supabase.from('alert_digest_queue')
    .select('company_id').is('delivered_at', null).gte('created_at', startOfRomeDayIso(todayStr));
  const companies = [...new Set((pending || []).map(r => r.company_id))];
  let rescued = 0;
  for (const companyId of companies) {
    const { data: run } = await supabase.from('alert_digest_runs')
      .select('status').eq('company_id', companyId).eq('run_date', todayStr).maybeSingle();
    if (run && run.status !== 'failed') {
      // Il riepilogo è partito: messaggi arrivati in coda dopo le 7:30 si
      // spediscono subito, non devono aspettare domani.
      rescued += await sendQueueAsIs(companyId, todayStr);
      continue;
    }
    if (!run) {
      console.error(`[alertDigest] nessun riepilogo registrato oggi per ${companyId}: invio i messaggi di sempre`);
      rescued += await sendQueueAsIs(companyId, todayStr);
      await recordRun(companyId, todayStr, 'failed', 0, 'riepilogo non partito, rete di sicurezza delle 7:50');
    }
  }
  if (rescued) console.log(`[alertDigest] controllo 7:50: ${rescued} messaggi spediti dalla coda`);
  return rescued;
}

module.exports = {
  isDigestEnabled, queueOrSend, buildDigest, runDigestForCompany, runDigest, runWatchdog, sendQueueAsIs,
};
