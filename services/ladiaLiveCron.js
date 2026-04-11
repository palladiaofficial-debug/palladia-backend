'use strict';
/**
 * services/ladiaLiveCron.js
 * Briefing mattutino di Ladia In Cantiere.
 *
 * Schedule: ogni giorno alle 07:30 (Lun-Sab), fuso Europe/Rome.
 * Per ogni cantiere con Ladia attiva, genera un briefing personalizzato
 * con Claude Sonnet e lo invia via Telegram agli utenti abilitati.
 *
 * Anti-spam: usa ladia_proactive_log per dedup giornaliero.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');
const { buildEnrichedContext }  = require('./ladiaEngine');
const { getLinkedChatIdsForSite } = require('./telegramNotifications');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BRIEFING_SYSTEM = `Sei Ladia, l'assistente AI per cantieri edili.
Genera un briefing mattutino CONCISO (max 280 parole) per il responsabile del cantiere.

Struttura OBBLIGATORIA:
1. Riga di apertura con data e nome cantiere
2. 📊 Stato avanzamento: fasi in corso con % e eventuali alert
3. 💶 Situazione economica: se ci sono sforamenti segnalali, altrimenti scrivi solo se rilevante
4. ⚠️ Priorità del giorno: massimo 2-3 punti d'azione concreti
5. 🌤️ Meteo: solo se impatta i lavori
6. Firma: "— Ladia"

Tono: diretto, da collega esperto. Usa HTML Telegram: <b>grassetto</b>.
Se non ci sono criticità, sii incoraggiante e breve.
NON inventare dati non presenti nel contesto. Se mancano dati, dillo chiaramente.`;

/**
 * Dedup check: evita di mandare più briefing nella stessa giornata.
 */
async function alreadySentToday(siteId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ladia_proactive_log')
    .select('id')
    .eq('site_id', siteId)
    .eq('trigger_type', 'morning_briefing')
    .eq('trigger_key', `briefing_${today}`)
    .limit(1);
  return (data?.length || 0) > 0;
}

async function markSent(companyId, siteId) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('ladia_proactive_log').insert({
    company_id:   companyId,
    site_id:      siteId,
    chat_id:      '0',  // sentinel per briefing (non legato a un singolo chat)
    trigger_type: 'morning_briefing',
    trigger_key:  `briefing_${today}`,
  }).catch(() => {});
}

/**
 * Genera e invia il briefing per un singolo cantiere.
 */
async function sendBriefingForSite(cfg) {
  const { site_id, company_id } = cfg;

  try {
    // 1. Costruisci contesto arricchito
    const context = await buildEnrichedContext(company_id, site_id);

    // 2. Genera briefing con Claude
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      system:     BRIEFING_SYSTEM,
      messages:   [{ role: 'user', content: `Genera il briefing mattutino per questo cantiere:\n\n${context}` }],
    });
    const briefingText = msg.content[0]?.text?.trim();
    if (!briefingText) return;

    // 3. Recupera destinatari (rispetta filtri per cantiere e notification_level)
    const chatIds = await getLinkedChatIdsForSite(company_id, site_id).catch(() => []);
    if (!chatIds.length) return;

    // 4. Invia a tutti i destinatari
    const results = await Promise.allSettled(
      chatIds.map(chatId => tg.sendMessage(chatId, briefingText))
    );
    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // 5. Log audit
    await supabase.from('ladia_action_log').insert({
      company_id,
      site_id,
      chat_id:      String(chatIds[0] || '0'),
      action_type:  'morning_briefing',
      action_params: { recipients: sent, failed, briefing_preview: briefingText.slice(0, 200) },
      result:       failed === chatIds.length ? 'error' : 'ok',
    }).catch(() => {});

    console.log(`[ladiaLiveCron] briefing ${site_id}: ${sent} inviati, ${failed} falliti`);

  } catch (err) {
    console.error(`[ladiaLiveCron] errore cantiere ${site_id}:`, err.message);
  }
}

/**
 * Esegue i briefing per tutti i cantieri attivi.
 */
async function runMorningBriefings() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.ANTHROPIC_API_KEY) return;

  const { data: configs, error } = await supabase
    .from('ladia_site_config')
    .select('site_id, company_id, briefing_time')
    .eq('is_active', true);

  if (error || !configs?.length) return;

  console.log(`[ladiaLiveCron] briefing per ${configs.length} cantieri attivi`);

  for (const cfg of configs) {
    if (await alreadySentToday(cfg.site_id)) continue;
    await sendBriefingForSite(cfg);
    await markSent(cfg.company_id, cfg.site_id);
    // Pausa tra cantieri per non sovraccaricare l'API
    await new Promise(r => setTimeout(r, 2000));
  }
}

/**
 * Avvia il cron del briefing mattutino.
 * Chiamato da server.js al boot.
 */
function startLadiaLiveCron() {
  // 07:30 Lun-Sab — timezone Europe/Rome
  cron.schedule('30 7 * * 1-6', () => {
    runMorningBriefings().catch(e =>
      console.error('[ladiaLiveCron] runMorningBriefings error:', e.message)
    );
  }, { timezone: 'Europe/Rome' });

  console.log('[ladiaLiveCron] avviato — briefing alle 07:30 Lun-Sab');
}

module.exports = { startLadiaLiveCron, runMorningBriefings };
