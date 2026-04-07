'use strict';
/**
 * services/telegramHandler.js
 * Logica principale del bot: riceve un update Telegram e lo gestisce.
 *
 * Flusso:
 *   handleUpdate(update)
 *     ├─ message → handleMessage(msg, tuUser)
 *     │    ├─ /start TOKEN → linkAccount()
 *     │    ├─ 📍 Cantieri  → showSiteSelector()
 *     │    ├─ 📋 Note rec. → showRecentNotes()
 *     │    ├─ 📊 Stato     → showStatus()
 *     │    ├─ ❓ Aiuto     → showHelp()
 *     │    ├─ /cantiere    → showSiteSelector()
 *     │    ├─ /note [n]    → showRecentNotes()
 *     │    ├─ /stato       → showStatus()
 *     │    ├─ /aiuto       → showHelp()
 *     │    ├─ /nc testo    → saveNote(non_conformita, alta)
 *     │    ├─ /presenze    → saveNote(presenza)
 *     │    ├─ foto         → handlePhoto()
 *     │    ├─ documento    → handleDocument()
 *     │    ├─ vocale       → handleVoice() → Whisper → classify → saveNote()
 *     │    └─ testo libero → handleText() → AI classify → saveNote()
 *     └─ callback_query → handleCallbackQuery()
 *          ├─ site:UUID      → setActiveSite()
 *          ├─ cmd:cantieri   → showSiteSelector()
 *          └─ cmd:prompt_photo → chiedi foto
 */

const tg             = require('./telegram');
const { classifyMessage } = require('./telegramAI');
const { askLadia, askLadiaCoordinator, resetLadiaHistory, coordUserId } = require('./telegramLadia');
const { logEvent }   = require('./telegramLog');
const supabase       = require('../lib/supabase');
const sharp          = require('sharp');
const { notifyNonConformita, notifyIncidente, notifyCompany } = require('./telegramNotifications');
const { isOwner, handleOwnerMessage, handleOwnerCallback } = require('./telegramOwner');
const { processLadiaPdf } = require('./ladiaDocumentProcessor');
const ladiaActions   = require('./ladiaActions');
const { runComplianceChecks, buildComplianceMessage } = require('./complianceEngine');

// ── Tastiere persistenti ──────────────────────────────────────

const MAIN_KEYBOARD = tg.buildReplyKeyboard([
  ['📍 Cantieri', '📋 Note recenti'],
  ['✅ OK',       '⚠️ Problema'],
  ['📊 Stato',    '❓ Aiuto'],
  ['🤖 Ladia'],
]);

// Tastiera modalità Ladia — testo libero va a Ladia, non al bot
const LADIA_KEYBOARD = tg.buildReplyKeyboard([
  ['⬅️ Menu', '🔄 Reset chat'],
]);

const COORDINATOR_KEYBOARD = tg.buildReplyKeyboard([
  ['📍 Cantieri', '📊 Stato'],
  ['🤖 Ladia',    '❓ Aiuto'],
]);

// Tastiera Ladia per coordinatori
const COORDINATOR_LADIA_KEYBOARD = tg.buildReplyKeyboard([
  ['⬅️ Menu', '🔄 Reset chat'],
]);

// ladia_mode coordinatori: in-memory (sufficiente — si ripristina con 1 tap)
const coordLadiaMode = new Map(); // chatId → bool

/** URL frontend webapp (per i link "Vedi su Palladia") */
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://palladia.net';

/** Invia un messaggio mantenendo la reply keyboard principale */
function sendMain(chatId, text) {
  return tg.sendMessage(chatId, text, { replyMarkup: MAIN_KEYBOARD });
}

/** Invia un messaggio mantenendo la reply keyboard di Ladia */
function sendLadia(chatId, text) {
  return tg.sendMessage(chatId, text, { replyMarkup: LADIA_KEYBOARD });
}

/**
 * Bottoni inline contestuali post-salvataggio.
 * - "Vedi su Palladia" → link diretto al cantiere sul web
 * - Per NC/Incidente: "Aggiungi foto" per documentare subito
 * - Per il resto: "Cambia cantiere" per cambio rapido
 */
function buildActionButtons(siteId, category) {
  const isUrgent = ['non_conformita', 'incidente'].includes(category);
  const buttons = [
    { text: '👁 Vedi su Palladia', url: `${FRONTEND_URL}/cantieri/${siteId}?tab=4` },
    isUrgent
      ? { text: '📸 Aggiungi foto NC', callbackData: 'cmd:prompt_photo' }
      : { text: '📍 Cambia cantiere',  callbackData: 'cmd:cantieri' },
  ];
  return tg.buildInlineKeyboard(buttons, 2);
}

/** Conferma azione con bottoni inline contestuali (la reply keyboard resta dal precedente) */
function sendAction(chatId, text, siteId, category) {
  return tg.sendMessage(chatId, text, { replyMarkup: buildActionButtons(siteId, category) });
}

// ── Entry point ──────────────────────────────────────────────

async function handleUpdate(update) {
  try {
    if (update.message) {
      const msg    = update.message;
      const chatId = msg.chat.id;

      // Owner panel — accessibile SOLO via /panel; tutto il resto passa al routing normale
      if (isOwner(chatId) && (msg.text || '').trim() === '/panel') {
        await handleOwnerMessage(msg);
        return;
      }


      // Cerca utente collegato (impresa) e coordinatore (paralleli)
      const [tuUser, tuCoord] = await Promise.all([
        getTelegramUser(chatId),
        getTelegramCoordinator(chatId),
      ]);

      // Aggiorna last_active_at (fire-and-forget)
      if (tuUser) {
        supabase.from('telegram_users')
          .update({ last_active_at: new Date().toISOString() })
          .eq('id', tuUser.id)
          .then(() => {});
      }

      await handleMessage(msg, tuUser, tuCoord);
    }

    if (update.callback_query) {
      const cbq = update.callback_query;
      if (isOwner(cbq.from.id) && (cbq.data || '').startsWith('owner:')) {
        await handleOwnerCallback(cbq);
        return;
      }
      await handleCallbackQuery(cbq);
    }
  } catch (err) {
    console.error('[telegramHandler] errore update:', err.message);
  }
}

// ── Gestione messaggi ────────────────────────────────────────

async function handleMessage(msg, tuUser, tuCoord) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  // Comando /start (anche senza essere collegati)
  if (text.startsWith('/start')) {
    return handleStart(msg, tuUser, tuCoord);
  }

  // Comando /pro CODE — collegamento coordinatore via codice OTP
  if (text.startsWith('/pro ') || text === '/pro') {
    const code = text.slice(5).trim();
    if (!code) {
      return tg.sendMessage(chatId,
        `🔗 Usa il comando così:\n<code>/pro IL_TUO_CODICE</code>\n\n` +
        `Ottieni il codice da <b>palladia.net/pro → Collega Telegram</b>.`
      );
    }
    return linkCoordinatorAccount(chatId, msg.chat, code);
  }

  // Coordinatore collegato — routing dedicato (ha precedenza su tuUser non collegato)
  if (tuCoord) {
    return handleCoordinatorMessage(msg, tuCoord);
  }

  // Utente non collegato → istruzioni link
  if (!tuUser) {
    return sendNotLinked(chatId);
  }

  // ── Bottoni tastiera principale ──────────────────────────
  if (text === '📍 Cantieri')     return showSiteSelector(chatId, tuUser);
  if (text === '📋 Note recenti') return showRecentNotes(chatId, tuUser, '/note');
  if (text === '📊 Stato')        return showStatus(chatId, tuUser);
  if (text === '❓ Aiuto')        return showHelp(chatId);
  if (text === '✅ OK')           return handleOkCommand(msg, tuUser);
  if (text === '⚠️ Problema')    return handleProblemaCommand(msg, tuUser);

  // ── Bottoni Ladia ────────────────────────────────────────
  if (text === '🤖 Ladia')       return handleLadiaButton(chatId, tuUser);
  if (text === '⬅️ Menu')        return handleLadiaExit(chatId, tuUser);
  if (text === '🔄 Reset chat')  return handleLadiaReset(chatId, tuUser);

  // ── Comandi slash ────────────────────────────────────────
  if (text.startsWith('/cantiere'))  return showSiteSelector(chatId, tuUser);
  if (text.startsWith('/note'))      return showRecentNotes(chatId, tuUser, text);
  if (text.startsWith('/stato'))     return showStatus(chatId, tuUser);
  if (text.startsWith('/aiuto') || text === '/help') return showHelp(chatId);
  if (text.startsWith('/nc ') || text === '/nc')     return handleNcCommand(msg, tuUser);
  if (text.startsWith('/problema') || text === '/problema') return handleProblemaCommand(msg, tuUser);
  if (text.startsWith('/ok'))                                return handleOkCommand(msg, tuUser);
  if (text.startsWith('/presenze'))  return handlePresenzeCommand(msg, tuUser);
  if (text.startsWith('/costo'))     return handleCostoCommand(msg, tuUser);
  if (text.startsWith('/ricavo'))    return handleRicavoCommand(msg, tuUser);
  if (text.startsWith('/sal ') || text === '/sal')   return handleSalCommand(msg, tuUser);
  if (text.startsWith('/ladia'))         return handleLadiaCommand(msg, tuUser);
  if (text.startsWith('/impostazioni')) return handleImpostazioniCommand(chatId, tuUser);
  if (text.startsWith('/ispezione'))   return handleIspezioneCommand(chatId, tuUser);
  if (text.startsWith('/i_miei_cantieri') || text === 'I miei cantieri') return handleMyCantieri(chatId, tuUser);

  // ── Ladia mode: testo → Ladia; PDF → elabora come template ──
  if (tuUser.ladia_mode && text) return handleLadiaMessage(msg, tuUser);
  if (tuUser.ladia_mode && msg.document && msg.document.mime_type === 'application/pdf') {
    return handleLadiaPdf(msg, tuUser);
  }

  // ── Media ────────────────────────────────────────────────
  if (msg.photo)    return handlePhoto(msg, tuUser);
  if (msg.document) return handleDocument(msg, tuUser);
  if (msg.voice)    return handleVoice(msg, tuUser);

  // ── Testo libero → classify + salva ─────────────────────
  if (text) return handleText(msg, tuUser);
}

// ── /start ───────────────────────────────────────────────────

async function handleStart(msg, existingUser, existingCoord) {
  const chatId    = msg.chat.id;
  const firstName = msg.chat.first_name || 'tecnico';
  const parts     = (msg.text || '').trim().split(/\s+/);
  const token     = parts[1] || null;

  // Token con prefisso "pro_" → collegamento coordinatore
  if (token && token.startsWith('pro_')) {
    return linkCoordinatorAccount(chatId, msg.chat, token.slice(4));
  }

  // Già collegato come coordinatore e nessun token impresa
  if (existingCoord && !token) {
    return tg.sendMessage(chatId,
      `Ciao <b>${firstName}</b>! Sei collegato come professionista su Palladia.\n\n` +
      `Scrivi /cantiere per scegliere il cantiere o inviami una nota.`
    );
  }

  // Già collegato come utente impresa
  if (existingUser && !token) {
    return sendMain(chatId,
      `Ciao <b>${firstName}</b>! Sei già collegato a Palladia.\n\n` +
      `Usa i bottoni in basso o scrivi /aiuto.`
    );
  }

  // Token fornito → collegamento impresa
  if (token) {
    return linkAccount(chatId, msg.chat, token);
  }

  // Nessun token → istruzioni
  await tg.sendMessage(chatId,
    `👷 <b>Benvenuto su Palladia Bot!</b>\n\n` +
    `Sei un tecnico d'impresa?\n` +
    `→ Vai su <b>palladia.net → Account → Telegram</b>\n\n` +
    `Sei un coordinatore (CSE/CSP/DL/RUP)?\n` +
    `→ Vai su <b>palladia.net/pro → Collega Telegram</b>\n\n` +
    `In alternativa usa il tuo codice personale:\n` +
    `<code>/start IL_TUO_CODICE</code>`
  );
}

async function linkAccount(chatId, chat, token) {
  // Verifica token
  const { data: tkn, error } = await supabase
    .from('telegram_link_tokens')
    .select('*')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error || !tkn) {
    return tg.sendMessage(chatId,
      `❌ <b>Codice non valido o scaduto.</b>\n\n` +
      `Genera un nuovo codice da <b>palladia.net → Account → Telegram</b>.`
    );
  }

  // Crea o aggiorna telegram_users
  const userData = {
    company_id:          tkn.company_id,
    user_id:             tkn.user_id,
    telegram_chat_id:    chatId,
    telegram_username:   chat.username  || null,
    telegram_first_name: chat.first_name || null,
    last_active_at:      new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('telegram_users')
    .upsert(userData, { onConflict: 'telegram_chat_id' });

  if (upsertErr) {
    console.error('[linkAccount] upsert error:', upsertErr.message);
    return tg.sendMessage(chatId, '❌ Errore interno. Riprova tra qualche minuto.');
  }

  // Marca token come usato
  await supabase.from('telegram_link_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('token', token);

  // Recupera utente per il selettore cantieri
  const tuUser = await getTelegramUser(chatId);
  const firstName = chat.first_name || 'tecnico';

  await tg.sendMessage(chatId,
    `✅ <b>Account collegato con successo!</b>\n\n` +
    `Ciao <b>${firstName}</b>, sono il tuo assistente di cantiere.\n\n` +
    `📱 Inviami qualsiasi cosa dal cantiere:\n` +
    `• Testo libero → classificato automaticamente dall'IA\n` +
    `• Foto → allegate al cantiere\n` +
    `• Documenti PDF/Excel → archiviati\n` +
    `• 🎙️ Vocali → trascritti e classificati\n\n` +
    `Usa i <b>bottoni in basso</b> o scrivi liberamente.\n\n` +
    `<b>Prima cosa: seleziona il cantiere attivo.</b>`,
    { replyMarkup: MAIN_KEYBOARD }
  );

  // Mostra selettore cantieri
  await showSiteSelector(chatId, tuUser);
}

// ── Selezione cantiere ───────────────────────────────────────

async function showSiteSelector(chatId, tuUser) {
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name, address, status')
    .eq('company_id', tuUser.company_id)
    .order('created_at', { ascending: false })
    .limit(20);

  console.log('[showSiteSelector] company_id:', tuUser.company_id, 'sites:', sites?.length, 'err:', sitesErr?.message);

  const activeSites = (sites || []).filter(s => s.status !== 'chiuso');

  if (activeSites.length === 0) {
    return tg.sendMessage(chatId,
      `⚠️ Nessun cantiere attivo trovato.\n` +
      `Crea un cantiere su <b>palladia.net</b> per continuare.`
    );
  }

  const buttons = activeSites.map(s => ({
    text: s.name || s.address || 'Cantiere senza nome',
    callbackData: `site:${s.id}`,
  }));

  const keyboard = tg.buildInlineKeyboard(buttons, 1);

  await tg.sendMessage(chatId,
    `📍 <b>Seleziona il cantiere attivo:</b>`,
    { replyMarkup: keyboard }
  );
}

// ── Callback query (tap su inline keyboard) ──────────────────

async function handleCallbackQuery(cbq) {
  const chatId = cbq.message.chat.id;
  const data   = cbq.data || '';

  // ── Aggiorna last_interaction_at su ogni tap (fatigue tracking) ──
  // Fire-and-forget: non blocca la risposta
  supabase.from('telegram_users')
    .update({ last_interaction_at: new Date().toISOString() })
    .eq('telegram_chat_id', String(chatId))
    .then(() => {}).catch(() => {});

  // ── Toggle assegnazione cantiere (sites:toggle:UUID) ────────
  if (data.startsWith('sites:toggle:')) {
    const siteId = data.slice(13);
    const tuUser = await getTelegramUser(chatId);
    if (!tuUser) { await tg.answerCallbackQuery(cbq.id, 'Account non collegato.'); return; }
    await tg.answerCallbackQuery(cbq.id, '').catch(() => {});
    await handleSiteToggle(chatId, tuUser, siteId, cbq.message?.message_id);
    return;
  }

  // ── Impostazioni notifiche (set:notif:*) ────────────────────
  if (data.startsWith('set:notif:')) {
    const level = data.slice(10); // 'quiet' | 'balanced' | 'full'
    if (!['quiet', 'balanced', 'full'].includes(level)) {
      await tg.answerCallbackQuery(cbq.id, '');
      return;
    }
    await tg.answerCallbackQuery(cbq.id, '').catch(() => {});
    if (cbq.message?.message_id) {
      await tg.editMessageReplyMarkup(chatId, cbq.message.message_id).catch(() => {});
    }
    await supabase.from('telegram_users')
      .update({ notification_level: level })
      .eq('telegram_chat_id', String(chatId));

    const confirmLabel = { quiet: '🤫 Solo briefing', balanced: '⚖️ Bilanciato', full: '🔔 Tutto' }[level];
    const confirmNote  = {
      quiet:    'Riceverai solo il briefing mattutino e il resoconto serale.',
      balanced: 'Riceverai alert aggregati per cantiere. Nessun messaggio ripetuto.',
      full:     'Riceverai ogni alert appena succede qualcosa.',
    }[level];
    await tg.sendMessage(chatId,
      `✅ <b>Notifiche impostate: ${confirmLabel}</b>\n\n${confirmNote}\n\n` +
      `Scrivi <code>/impostazioni</code> per cambiare di nuovo.`
    );
    return;
  }

  // ── Azioni Ladia (act:*) ────────────────────────────────────
  // Formato: act:{action}:{param1}[:{param2}]
  // Sicurezza: company_id sempre letto dal DB via chatId
  if (data.startsWith('act:')) {
    return handleActionCallback(cbq, chatId, data);
  }

  // Bottone "Cambia cantiere"
  if (data === 'cmd:cantieri') {
    const tuUser = await getTelegramUser(chatId);
    if (!tuUser) {
      await tg.answerCallbackQuery(cbq.id, 'Account non collegato.');
      return;
    }
    await tg.answerCallbackQuery(cbq.id, '');
    return showSiteSelector(chatId, tuUser);
  }

  // Bottone "Aggiungi foto NC"
  if (data === 'cmd:prompt_photo') {
    await tg.answerCallbackQuery(cbq.id, '');
    return tg.sendMessage(chatId,
      `📸 Invia ora la foto del problema.\n` +
      `Puoi aggiungere una didascalia per descriverla.`
    );
  }

  // Selezione cantiere (utente impresa)
  if (data.startsWith('site:')) {
    const siteId = data.slice(5);
    const tuUser = await getTelegramUser(chatId);
    if (!tuUser) {
      await tg.answerCallbackQuery(cbq.id, 'Account non collegato.');
      return;
    }
    await setActiveSite(chatId, tuUser, siteId, cbq.id);
    return;
  }

  // Selezione cantiere (coordinatore)
  if (data.startsWith('coord_site:')) {
    const siteId  = data.slice(11);
    const tuCoord = await getTelegramCoordinator(chatId);
    if (!tuCoord) {
      await tg.answerCallbackQuery(cbq.id, 'Account coordinatore non collegato.');
      return;
    }
    await setCoordinatorActiveSite(chatId, tuCoord, siteId, cbq.id);
    return;
  }

  // noop (bottone placeholder)
  if (data === 'noop') {
    await tg.answerCallbackQuery(cbq.id, '');
  }
}

// ── Gestore azioni Ladia (act:*) ─────────────────────────────

/**
 * Esegue un'azione Ladia confermata dal tecnico via tap su bottone inline.
 *
 * Flusso:
 *   1. Verifica account collegato (getTelegramUser)
 *   2. Risponde al callback SUBITO (toglie loading indicator)
 *   3. Rimuove i bottoni dal messaggio originale (anti-doppio-tap)
 *   4. Esegue l'azione nel servizio ladiaActions
 *   5. Invia messaggio di conferma risultato
 *
 * Sicurezza: company_id sempre letto dal DB, mai dal payload del bottone.
 */
async function handleActionCallback(cbq, chatId, data) {
  const parts  = data.split(':'); // ['act', 'close_nc', '{p1}', '{p2?}']
  const action = parts[1];
  const p1     = parts[2] || null;
  const p2     = parts[3] || null;

  const msgId = cbq.message?.message_id;

  // Verifica account (source of truth per company_id)
  const tuUser = await getTelegramUser(chatId);
  if (!tuUser) {
    await tg.answerCallbackQuery(cbq.id, '❌ Account non collegato. Usa /start per collegarlo.');
    return;
  }

  // 1. Risposta immediata al tap (rimuove spinner)
  await tg.answerCallbackQuery(cbq.id, '').catch(() => {});

  // 2. Rimuovi bottoni dal messaggio originale subito (anti-doppio-tap)
  if (msgId) {
    await tg.editMessageReplyMarkup(chatId, msgId).catch(() => {});
  }

  const company = tuUser.company_id;

  // 3. Esegui azione e rispondi
  try {
    switch (action) {

      // ── Chiudi NC ──────────────────────────────────────────
      case 'close_nc': {
        const res = await ladiaActions.closeNc(p1, chatId, company);
        if (res.alreadyResolved) {
          await tg.sendMessage(chatId,
            `✅ <b>Ladia</b> — Questa NC era già stata segnata come risolta.`);
        } else if (res.ok) {
          await tg.sendMessage(chatId,
            `✅ <b>NC segnata come risolta.</b>\n` +
            `Ottimo! Il problema è stato chiuso e tracciato nel sistema.\n` +
            `Continua a monitorare il cantiere con 🤖 Ladia.`);
        } else if (res.notFound) {
          await tg.sendMessage(chatId,
            `⚠️ <b>Ladia</b> — NC non trovata. Potrebbe essere già stata eliminata da Palladia.`);
        } else {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nella chiusura. Riprova aprendo Palladia.`);
        }
        break;
      }

      // ── Lascia NC aperta ──────────────────────────────────
      case 'skip_nc': {
        await tg.sendMessage(chatId,
          `📋 <b>Ladia</b> — NC lasciata aperta.\n` +
          `Ti ricorderò domani se non viene risolta.`);
        break;
      }

      // ── Registra uscite mancanti ──────────────────────────
      case 'reg_exits': {
        if (!p1 || !p2) {
          await tg.sendMessage(chatId, `❌ <b>Ladia</b> — Dati mancanti. Riprova da Palladia.`);
          break;
        }
        const res = await ladiaActions.registerMissingExits(p1, p2, company, chatId);
        if (!res.ok) {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nella registrazione. Riprova da Palladia.`);
        } else if (res.count === 0) {
          await tg.sendMessage(chatId,
            `✅ <b>Ladia</b> — Nessuna uscita mancante da registrare.\n` +
            `Probabilmente qualcuno le ha già sistemate.`);
        } else {
          await tg.sendMessage(chatId,
            `✅ <b>${res.count} uscit${res.count > 1 ? 'e registrate' : 'a registrata'} alle 18:00.</b>\n\n` +
            `I log sono visibili nel registro presenze su Palladia.\n` +
            `Le uscite sono marcate come <code>ladia_action</code> per distinguerle da quelle reali.`);
        }
        break;
      }

      // ── Ignora uscite mancanti ────────────────────────────
      case 'skip_exits': {
        await tg.sendMessage(chatId,
          `📋 <b>Ladia</b> — Ok, le uscite restano non registrate.\n` +
          `Ricordati di sistemarle manualmente se necessario.`);
        break;
      }

      // ── Avvisa squadra: meteo ─────────────────────────────
      case 'rain_notify': {
        const res = await ladiaActions.sendRainNotification(p1, company, chatId);
        if (!res.ok) {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nell'invio. Riprova tra poco.`);
        } else if (res.sent === 0) {
          await tg.sendMessage(chatId,
            `✅ <b>Ladia</b> — Sei l'unico membro del team collegato.\n` +
            `Avvisa la squadra direttamente.`);
        } else {
          await tg.sendMessage(chatId,
            `✅ <b>Allerta meteo inviata a ${res.sent} member${res.sent > 1 ? 'i' : 'o'} del team.</b>\n` +
            `Tutti sono stati avvisati di verificare opere esterne e ponteggi.`);
        }
        break;
      }

      // ── Meteo: gestisco io ────────────────────────────────
      case 'rain_skip': {
        await tg.sendMessage(chatId,
          `👍 <b>Ladia</b> — Perfetto, gestisci tu. Sono qui se hai bisogno.`);
        break;
      }

      // ── Avvisa squadra: caldo estremo ────────────────────
      case 'heat_notify': {
        const res = await ladiaActions.sendHeatNotification(p1, company, chatId);
        if (!res.ok) {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nell'invio. Riprova tra poco.`);
        } else if (res.sent === 0) {
          await tg.sendMessage(chatId,
            `✅ <b>Ladia</b> — Sei l'unico membro collegato. Avvisa la squadra direttamente.`);
        } else {
          await tg.sendMessage(chatId,
            `✅ <b>Allerta caldo inviata a ${res.sent} member${res.sent > 1 ? 'i' : 'o'} del team.</b>\n` +
            `Tutti sono stati avvisati delle misure obbligatorie D.Lgs. 81/2008.`);
        }
        break;
      }

      // ── Caldo: ho già gestito ─────────────────────────────
      case 'heat_skip': {
        await tg.sendMessage(chatId,
          `👍 <b>Ladia</b> — Ottimo, grazie per aver già provveduto. Buona giornata al cantiere!`);
        break;
      }

      // ── Analisi budget con Ladia ──────────────────────────
      case 'budget_ladia': {
        const siteId = p1;
        // Attiva ladia_mode e aggiorna cantiere attivo
        await supabase.from('telegram_users')
          .update({ active_site_id: siteId, ladia_mode: true })
          .eq('telegram_chat_id', chatId);

        // Indica typing e lancia analisi proattiva
        await tg.sendChatAction(chatId, 'typing').catch(() => {});
        await askLadia(
          chatId,
          'Fammi un\'analisi rapida della situazione economica di questo cantiere: ' +
          'budget consumato, SAL attuale, rischio sforamento e cosa mi consigli per rientrare.',
          tuUser
        ).catch(async err => {
          console.error('[handleActionCallback] budget_ladia askLadia error:', err.message);
          await tg.sendMessage(chatId,
            `🤖 <b>Ladia</b> è pronta per l'analisi economica.\n` +
            `Scrivimi per iniziare.`,
            { replyMarkup: LADIA_KEYBOARD }
          ).catch(() => {});
        });
        break;
      }

      // ── Check-in inattività: apri Ladia ──────────────────
      case 'open_ladia': {
        const siteId = p1;
        await ladiaActions.openLadiaMode(chatId, siteId);
        await tg.sendMessage(chatId,
          `🤖 <b>Ladia</b> è pronta.\n` +
          `Dimmi com'è la situazione al cantiere o chiedimi quello che vuoi.`,
          { replyMarkup: LADIA_KEYBOARD }
        );
        break;
      }

      // ── Check-in inattività: tutto ok ────────────────────
      case 'skip_inactive': {
        await tg.sendMessage(chatId,
          `👍 <b>Ladia</b> — Perfetto. Ti tengo d'occhio e ti avviso se serve!`);
        break;
      }

      // ── Batch NC: le vedo dopo ────────────────────────────
      case 'skip_nc_batch': {
        await tg.sendMessage(chatId,
          `📋 <b>Ladia</b> — Ok, ci torno domani se non vengono risolte.`);
        break;
      }

      // ── Batch scadenze: avvisa il team ────────────────────
      case 'expiry_remind_batch': {
        const siteId = p1;
        // Apre Ladia con il contesto di scadenze aperto
        await ladiaActions.openLadiaMode(chatId, siteId);
        await tg.sendMessage(chatId,
          `🤖 <b>Ladia</b> — Dimmi quali documenti vuoi che avvisi al team, o chiedimi un riepilogo.`,
          { replyMarkup: LADIA_KEYBOARD }
        );
        break;
      }

      // ── Batch scadenze: ho visto ──────────────────────────
      case 'expiry_skip_batch': {
        await tg.sendMessage(chatId,
          `📋 <b>Ladia</b> — Ok, visto. Ti ricordo se le scadenze si avvicinano ulteriormente.`);
        break;
      }

      // ── Report conformità on-demand ───────────────────────
      case 'compliance_report': {
        const siteId = p1;
        await tg.sendChatAction(chatId, 'typing').catch(() => {});
        let report;
        try {
          report = await runComplianceChecks(siteId, company);
        } catch (err) {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nell'analisi. Riprova con <code>/ispezione</code>.`);
          break;
        }
        const msg      = buildComplianceMessage(report);
        const keyboard = tg.buildInlineKeyboard([
          { text: '🤖 Chiedi a Ladia come risolvere', callbackData: `act:open_ladia:${siteId}` },
        ], 1);
        await tg.sendMessage(chatId, msg, { replyMarkup: keyboard });
        break;
      }

      // ── Rischio conformità: ho già gestito ───────────────
      case 'skip_compliance': {
        await tg.sendMessage(chatId,
          `👍 <b>Ladia</b> — Ok. Usa <code>/ispezione</code> se vuoi il report completo in qualsiasi momento.`);
        break;
      }

      // ── Invia promemoria scadenza documento ───────────────
      case 'expiry_remind': {
        const workerId = p1;
        const docType  = p2; // 'train' | 'fit'
        const res = await ladiaActions.sendExpiryReminder(workerId, docType, company, chatId);
        if (res.ok && res.sent > 0) {
          await tg.sendMessage(chatId,
            `✅ <b>Promemoria inviato a ${res.sent} member${res.sent > 1 ? 'i' : 'o'} del team.</b>\n` +
            `Tutti sono stati avvisati di aggiornare la documentazione.`);
        } else if (res.ok && res.sent === 0) {
          await tg.sendMessage(chatId,
            `⚠️ <b>Ladia</b> — Nessun membro del team collegato a Telegram.\n` +
            `Avvisa direttamente dall'app Palladia.`);
        } else {
          await tg.sendMessage(chatId,
            `❌ <b>Ladia</b> — Errore nell'invio. Riprova o gestisci da Palladia.`);
        }
        break;
      }

      // ── Ignora scadenza documento ─────────────────────────
      case 'expiry_skip': {
        await tg.sendMessage(chatId,
          `📋 <b>Ladia</b> — Ok, ignorato per oggi.\n` +
          `Ti ricorderò domani se la scadenza è ancora imminente.`);
        break;
      }

      default:
        // Azione non riconosciuta — ignora silenziosamente
        console.warn(`[handleActionCallback] azione sconosciuta: "${action}" da chat ${chatId}`);
        break;
    }
  } catch (err) {
    console.error(`[handleActionCallback] errore action="${action}" chat=${chatId}:`, err.message);
    await tg.sendMessage(chatId,
      `❌ <b>Ladia</b> — Si è verificato un errore. Riprova o usa Palladia direttamente.`
    ).catch(() => {});
  }
}

async function setActiveSite(chatId, tuUser, siteId, callbackQueryId) {
  // Verifica che il cantiere appartenga alla company dell'utente
  const { data: site } = await supabase
    .from('sites')
    .select('id, name, address')
    .eq('id', siteId)
    .eq('company_id', tuUser.company_id)
    .maybeSingle();

  if (!site) {
    await tg.answerCallbackQuery(callbackQueryId, 'Cantiere non trovato.');
    return;
  }

  // Cambia cantiere e torna al menu normale (esce da ladia_mode se attivo)
  await supabase.from('telegram_users')
    .update({ active_site_id: siteId, ladia_mode: false })
    .eq('id', tuUser.id);

  const siteName = site.name || site.address || 'Cantiere';
  await tg.answerCallbackQuery(callbackQueryId, `✅ ${siteName}`);
  await sendMain(chatId,
    `✅ <b>Cantiere attivo: ${siteName}</b>\n\n` +
    `Ora puoi inviarmi note, foto, documenti, vocali o segnalazioni.\n` +
    `Classifico tutto e lo trovi ordinato su Palladia.`
  );
}

// ── Gestione contenuti ───────────────────────────────────────

async function handleText(msg, tuUser) {
  const chatId = msg.chat.id;
  const text   = msg.text;

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  // Classificazione AI
  const ai = await classifyMessage(text, siteCtx.siteName);

  await saveNote(tuUser, siteCtx.siteId, {
    category:            ai.category,
    content:             text,
    ai_summary:          ai.summary,
    ai_category:         ai.category,
    urgency:             ai.urgency,
    telegram_message_id: msg.message_id,
  });

  const categoryLabel = CATEGORY_LABELS[ai.category] || ai.category;
  const urgencyTag    = ai.urgency === 'critica' ? ' 🔴' : ai.urgency === 'alta' ? ' 🟡' : '';

  await sendAction(chatId,
    `✅ <b>${categoryLabel}${urgencyTag}</b> salvata su <i>${siteCtx.siteName}</i>\n` +
    (ai.summary ? `\n📝 ${ai.summary}` : ''),
    siteCtx.siteId, ai.category
  );

  // Notifiche push solo per NC urgenti e incidenti — esclude il mittente
  const authorName = tuUser.telegram_first_name || tuUser.telegram_username;
  if (ai.category === 'incidente') {
    notifyIncidente(tuUser.company_id, siteCtx.siteId, siteCtx.siteName, ai.summary || text, authorName,
      tuUser.telegram_chat_id).catch(() => {});
  } else if (ai.category === 'non_conformita') {
    notifyNonConformita(tuUser.company_id, siteCtx.siteId, siteCtx.siteName,
      ai.summary || text, authorName, ai.urgency, tuUser.telegram_chat_id).catch(() => {});
  }
  // Tutte le altre categorie (nota, foto, verbale, presenza, documento): silenzioso
}

async function handlePhoto(msg, tuUser) {
  const chatId  = msg.chat.id;
  const caption = msg.caption || '';

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await tg.sendMessage(chatId, `📥 Ricevuta la foto, la salvo su <i>${siteCtx.siteName}</i>…`);

  // Prendi la qualità più alta (ultima nell'array photo)
  const photo  = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  let mediaPath = null;
  let mediaSizeBytes = null;
  try {
    const result = await uploadTelegramFile(fileId, tuUser.company_id, siteCtx.siteId, 'jpg');
    mediaPath      = result.storagePath;
    mediaSizeBytes = result.sizeBytes;
  } catch (err) {
    console.error('[handlePhoto] upload error:', err.message);
  }

  const textForAI = caption || 'Foto di cantiere';
  const ai = await classifyMessage(textForAI, siteCtx.siteName);
  const finalCategory = (ai.category === 'nota' || ai.category === 'altro') ? 'foto' : ai.category;

  await saveNote(tuUser, siteCtx.siteId, {
    category:            finalCategory,
    content:             caption || null,
    media_path:          mediaPath,
    media_type:          'image/jpeg',
    media_size_bytes:    mediaSizeBytes,
    ai_summary:          ai.summary || (caption ? null : 'Foto senza didascalia'),
    ai_category:         finalCategory,
    urgency:             ai.urgency,
    telegram_message_id: msg.message_id,
  });

  logEvent({ direction:'inbound', messageType:'photo', chatId: msg.chat.id,
    companyId: tuUser.company_id, siteId: siteCtx.siteId,
    contentPreview: caption || 'foto', mediaPath, status:'ok' });

  const urgencyTag = ai.urgency === 'critica' ? ' 🔴' : ai.urgency === 'alta' ? ' 🟡' : '';
  await sendAction(chatId,
    `✅ <b>Foto${urgencyTag}</b> salvata su <i>${siteCtx.siteName}</i>` +
    (caption ? `\n📝 ${caption.slice(0, 100)}` : ''),
    siteCtx.siteId, finalCategory
  );
}

async function handleDocument(msg, tuUser) {
  const chatId   = msg.chat.id;
  const doc      = msg.document;
  const caption  = msg.caption || '';
  const filename = doc.file_name || 'documento';
  const mimeType = doc.mime_type || 'application/octet-stream';

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await tg.sendMessage(chatId, `📥 Ricevuto <b>${filename}</b>, lo salvo su <i>${siteCtx.siteName}</i>…`);

  let mediaPath = null;
  let mediaSizeBytes = null;
  const ext = filename.split('.').pop() || 'bin';
  try {
    const result = await uploadTelegramFile(doc.file_id, tuUser.company_id, siteCtx.siteId, ext);
    mediaPath      = result.storagePath;
    mediaSizeBytes = result.sizeBytes;
  } catch (err) {
    console.error('[handleDocument] upload error:', err.message);
  }

  const textForAI = caption || `Documento: ${filename}`;
  const ai = await classifyMessage(textForAI, siteCtx.siteName);
  const finalCategory = (ai.category === 'nota' || ai.category === 'altro') ? 'documento' : ai.category;

  await saveNote(tuUser, siteCtx.siteId, {
    category:            finalCategory,
    content:             caption || null,
    media_path:          mediaPath,
    media_type:          mimeType,
    media_filename:      filename,
    media_size_bytes:    mediaSizeBytes,
    ai_summary:          ai.summary,
    ai_category:         finalCategory,
    urgency:             ai.urgency,
    telegram_message_id: msg.message_id,
  });

  logEvent({ direction:'inbound', messageType:'document', chatId: msg.chat.id,
    companyId: tuUser.company_id, siteId: siteCtx.siteId,
    contentPreview: `${filename} ${caption || ''}`.trim(), mediaPath, status:'ok' });

  await sendAction(chatId,
    `✅ <b>Documento</b> salvato su <i>${siteCtx.siteName}</i>\n` +
    `📎 ${filename}`,
    siteCtx.siteId, finalCategory
  );
}

/**
 * Gestione vocali: scarica il file OGG, trascrive con OpenAI Whisper,
 * poi processa il testo come un messaggio normale (classify + saveNote).
 * Richiede OPENAI_API_KEY nelle variabili d'ambiente.
 */
async function handleVoice(msg, tuUser) {
  const chatId = msg.chat.id;

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  // Whisper non disponibile → avvisa ma non blocca
  if (!process.env.GROQ_API_KEY) {
    return sendMain(chatId,
      `🎙️ Vocale ricevuto, ma la trascrizione automatica non è attiva.\n\n` +
      `Per abilitarla aggiungi <code>GROQ_API_KEY</code> nelle variabili d'ambiente (gratuita).\n` +
      `Nel frattempo puoi scrivere la nota come testo.`
    );
  }

  await tg.sendMessage(chatId, `🎙️ Sto trascrivendo il vocale…`);

  try {
    // Download
    const fileInfo = await tg.getFile(msg.voice.file_id);
    const buffer   = await tg.downloadFile(fileInfo.file_path);

    // Trascrizione Whisper
    const transcription = await transcribeWithWhisper(buffer);

    if (!transcription || transcription.trim().length < 3) {
      return sendMain(chatId,
        `🎙️ Non sono riuscito a capire il vocale.\n` +
        `Riprova con una voce più chiara o scrivi il testo direttamente.`
      );
    }

    // Classificazione AI (stesso flusso del testo)
    const ai = await classifyMessage(transcription, siteCtx.siteName);

    await saveNote(tuUser, siteCtx.siteId, {
      category:            ai.category,
      content:             transcription,
      ai_summary:          ai.summary,
      ai_category:         ai.category,
      urgency:             ai.urgency,
      telegram_message_id: msg.message_id,
    });

    logEvent({ direction:'inbound', messageType:'voice', chatId,
      companyId: tuUser.company_id, siteId: siteCtx.siteId,
      contentPreview: transcription.slice(0, 100), status:'ok' });

    const categoryLabel = CATEGORY_LABELS[ai.category] || ai.category;
    const urgencyTag    = ai.urgency === 'critica' ? ' 🔴' : ai.urgency === 'alta' ? ' 🟡' : '';

    await sendAction(chatId,
      `🎙️ <b>Vocale trascritto</b>\n` +
      `<i>"${transcription.slice(0, 200)}${transcription.length > 200 ? '…' : ''}"</i>\n\n` +
      `✅ <b>${categoryLabel}${urgencyTag}</b> salvata su <i>${siteCtx.siteName}</i>` +
      (ai.summary ? `\n📌 ${ai.summary}` : ''),
      siteCtx.siteId, ai.category
    );

    // Notifiche push solo per NC urgenti e incidenti — esclude il mittente
    const authorName = tuUser.telegram_first_name || tuUser.telegram_username;
    if (ai.category === 'incidente') {
      notifyIncidente(tuUser.company_id, siteCtx.siteId, siteCtx.siteName, ai.summary || transcription, authorName,
        tuUser.telegram_chat_id).catch(() => {});
    } else if (ai.category === 'non_conformita') {
      notifyNonConformita(tuUser.company_id, siteCtx.siteId, siteCtx.siteName,
        ai.summary || transcription, authorName, ai.urgency, tuUser.telegram_chat_id).catch(() => {});
    }

  } catch (err) {
    console.error('[handleVoice] error:', err.message);
    return sendMain(chatId,
      `❌ Errore nella trascrizione del vocale.\n` +
      `Riprova o scrivi la nota come testo.`
    );
  }
}

// ── Economia: /costo /ricavo /sal ────────────────────────────

/** Formatta un importo in euro per Telegram (non HTML, solo testo) */
function fmtEuroBot(n) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

/** Barra SAL testuale: █████░░░░░ */
function buildSalBar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/** Classifica la categoria di un costo da parole chiave (no API call) */
function classifyCostCategory(voce) {
  const v = (voce || '').toLowerCase();
  if (/cement|mattoni|laterizi|ferro|acciai|legname|calce|sabbia|ghiaia|piastrelle|intonaco|vernice|tubi|cavi|pannelli|isolante|guaina|cls|calcestruzzo|fornitura|acquisto materiali/.test(v)) return 'Materiali';
  if (/operai|manodopera|squadra|lavoratori|ore|giornate|muratore|carpentiere|elettricista|idraulico|imbianchino|stipendi|salari|prestazione/.test(v)) return 'Manodopera';
  if (/noleggio|nolo|escavatore|gru|ponteggio|macchina|mezzo|attrezzatura|macchinario|autocarro|pompa|betoniera/.test(v)) return 'Noli e macchinari';
  if (/subappalto|sub-appalto|impresa|ditta|appaltatore|terzi/.test(v)) return 'Subappalti';
  if (/assicurazione|visura|notaio|progetto|direzione lavori|utenze|spese generali|permesso|pratica|fidejussione|oneri/.test(v)) return 'Generali';
  return 'Altro';
}

/** Classifica la categoria di un ricavo da parole chiave */
function classifyRicavoCategory(voce) {
  const v = (voce || '').toLowerCase();
  if (/acconto|anticipo/.test(v)) return 'Acconto';
  if (/sal|avanzamento|stato avanzamento/.test(v)) return 'SAL';
  if (/saldo|finale|chiusura/.test(v)) return 'Saldo';
  if (/extra|aggiuntivo|variante|perizia/.test(v)) return 'Extra';
  return 'Altro';
}

async function handleCostoCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const parts  = msg.text.trim().split(/\s+/);

  if (parts.length < 2) {
    return sendMain(chatId,
      `❌ Sintassi: <code>/costo importo descrizione</code>\n\n` +
      `Esempi:\n` +
      `<code>/costo 800 cemento 30 sacchi</code>\n` +
      `<code>/costo 2500 noleggio escavatore</code>`
    );
  }

  const importo = parseFloat(parts[1].replace(/[€\s]/g, '').replace(',', '.'));
  if (isNaN(importo) || importo <= 0) {
    return sendMain(chatId, `❌ Importo non valido. Es: <code>/costo 800 cemento</code>`);
  }

  const voce    = parts.slice(2).join(' ').trim() || 'Costo cantiere';
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  const categoria = classifyCostCategory(voce);

  const { error } = await supabase.from('site_economia_voci').insert({
    company_id:      tuUser.company_id,
    site_id:         siteCtx.siteId,
    tipo:            'costo',
    categoria,
    voce,
    importo,
    data_competenza: new Date().toISOString().slice(0, 10),
    created_by:      tuUser.user_id,
  });

  if (error) {
    console.error('[handleCostoCommand]', error.message);
    return sendMain(chatId, `❌ Errore nel salvataggio. Riprova.`);
  }

  await sendMain(chatId,
    `✅ <b>Costo registrato</b>\n\n` +
    `💶 <b>${fmtEuroBot(importo)}</b>\n` +
    `📝 ${voce}\n` +
    `📂 Categoria: <i>${categoria}</i>\n` +
    `🏗 Cantiere: <i>${siteCtx.siteName}</i>\n` +
    `📅 ${new Date().toLocaleDateString('it-IT')}`
  );
}

async function handleRicavoCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const parts  = msg.text.trim().split(/\s+/);

  if (parts.length < 2) {
    return sendMain(chatId,
      `❌ Sintassi: <code>/ricavo importo descrizione</code>\n\n` +
      `Esempi:\n` +
      `<code>/ricavo 15000 SAL 1 approvato</code>\n` +
      `<code>/ricavo 5000 acconto iniziale</code>`
    );
  }

  const importo = parseFloat(parts[1].replace(/[€\s]/g, '').replace(',', '.'));
  if (isNaN(importo) || importo <= 0) {
    return sendMain(chatId, `❌ Importo non valido. Es: <code>/ricavo 15000 SAL 1</code>`);
  }

  const voce    = parts.slice(2).join(' ').trim() || 'Ricavo cantiere';
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  const categoria = classifyRicavoCategory(voce);

  const { error } = await supabase.from('site_economia_voci').insert({
    company_id:      tuUser.company_id,
    site_id:         siteCtx.siteId,
    tipo:            'ricavo',
    categoria,
    voce,
    importo,
    data_competenza: new Date().toISOString().slice(0, 10),
    created_by:      tuUser.user_id,
  });

  if (error) {
    console.error('[handleRicavoCommand]', error.message);
    return sendMain(chatId, `❌ Errore nel salvataggio. Riprova.`);
  }

  await sendMain(chatId,
    `✅ <b>Ricavo registrato</b>\n\n` +
    `💰 <b>${fmtEuroBot(importo)}</b>\n` +
    `📝 ${voce}\n` +
    `📂 Categoria: <i>${categoria}</i>\n` +
    `🏗 Cantiere: <i>${siteCtx.siteName}</i>\n` +
    `📅 ${new Date().toLocaleDateString('it-IT')}`
  );
}

async function handleSalCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const parts  = msg.text.trim().split(/\s+/);
  const val    = parseFloat(parts[1]);

  if (isNaN(val) || val < 0 || val > 100) {
    return sendMain(chatId,
      `❌ Sintassi: <code>/sal percentuale</code> (0-100)\n\n` +
      `Es: <code>/sal 65</code> → avanzamento al 65%`
    );
  }

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  // Leggi anche il budget per dare feedback contestuale
  const { data: site } = await supabase
    .from('sites')
    .select('budget_totale')
    .eq('id', siteCtx.siteId)
    .maybeSingle();

  const { error } = await supabase
    .from('sites')
    .update({ sal_percentuale: val })
    .eq('id', siteCtx.siteId)
    .eq('company_id', tuUser.company_id);

  if (error) return sendMain(chatId, `❌ Errore nel salvataggio. Riprova.`);

  // Se c'è budget, calcola anche la spesa attuale per dare un rischio
  let riskLine = '';
  if (site?.budget_totale) {
    const { data: voci } = await supabase
      .from('site_economia_voci')
      .select('importo')
      .eq('site_id', siteCtx.siteId)
      .eq('tipo', 'costo');
    const totCosti  = (voci || []).reduce((s, v) => s + Number(v.importo), 0);
    const budget    = Number(site.budget_totale);
    const spendPct  = budget > 0 ? Math.round((totCosti / budget) * 100) : 0;
    if (spendPct > val + 10) {
      riskLine = `\n⚠️ <b>Attenzione</b>: budget consumato al ${spendPct}% ma SAL al ${val}% — rischio sforamento.`;
    } else if (spendPct > 0) {
      riskLine = `\n📊 Budget consumato: ${spendPct}% (${fmtEuroBot(totCosti)} di ${fmtEuroBot(budget)})`;
    }
  }

  await sendMain(chatId,
    `✅ <b>SAL aggiornato</b>\n\n` +
    `🏗 <i>${siteCtx.siteName}</i>\n` +
    `${buildSalBar(val)} <b>${val}%</b>` +
    riskLine
  );
}

/**
 * Trascrive un buffer audio OGG con Groq Whisper-large-v3 (gratuito).
 * Groq usa la stessa API di OpenAI — stesso modello, più veloce, tier free 7200 min/giorno.
 * Usa native fetch + FormData (Node 18+).
 */
async function transcribeWithWhisper(audioBuffer) {
  const formData = new FormData();
  const blob     = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file', blob, 'voice.ogg');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'it');
  formData.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body:    formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq Whisper ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  return (json.text || '').trim();
}

// ── Comandi speciali ─────────────────────────────────────────

async function handleNcCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').replace(/^\/nc\s*/i, '').trim();

  if (!text) {
    return tg.sendMessage(chatId,
      `⚠️ <b>Non Conformità</b>\n\n` +
      `Uso: <code>/nc descrizione del problema</code>\n\n` +
      `Esempio:\n<code>/nc Operaio senza casco in zona B</code>`
    );
  }

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await saveNote(tuUser, siteCtx.siteId, {
    category:            'non_conformita',
    content:             text,
    ai_summary:          text.slice(0, 200),
    ai_category:         'non_conformita',
    urgency:             'alta',
    telegram_message_id: msg.message_id,
  });

  await sendAction(chatId,
    `🟡 <b>Non Conformità registrata</b> su <i>${siteCtx.siteName}</i>\n\n` +
    `📝 ${text}`,
    siteCtx.siteId, 'non_conformita'
  );

  // /nc è intento esplicito → notifica sempre, senza cooldown, esclude il mittente
  notifyNonConformita(tuUser.company_id, siteCtx.siteId, siteCtx.siteName, text,
    tuUser.telegram_first_name || tuUser.telegram_username, 'critica', tuUser.telegram_chat_id
  ).catch(() => {});
}

async function handleProblemaCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').replace(/^\/problema\s*/i, '').trim();

  if (!text) {
    return tg.sendMessage(chatId,
      `⚠️ <b>Segnala Problema</b>\n\n` +
      `Uso: <code>/problema descrizione del problema</code>\n\n` +
      `Esempi:\n` +
      `<code>/problema perdita d'acqua nel locale seminterrato</code>\n` +
      `<code>/problema operaio senza DPI in zona scavi</code>`
    );
  }

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await saveNote(tuUser, siteCtx.siteId, {
    category:            'non_conformita',
    content:             text,
    ai_summary:          text.slice(0, 200),
    ai_category:         'non_conformita',
    urgency:             'alta',
    telegram_message_id: msg.message_id,
  });

  await sendAction(chatId,
    `🟡 <b>Problema segnalato</b> su <i>${siteCtx.siteName}</i>\n\n` +
    `📝 ${text}\n\n` +
    `Urgenza: <b>Alta</b> — visibile in piattaforma`,
    siteCtx.siteId, 'non_conformita'
  );

  notifyNonConformita(tuUser.company_id, siteCtx.siteId, siteCtx.siteName, text,
    tuUser.telegram_first_name || tuUser.telegram_username, 'alta', tuUser.telegram_chat_id
  ).catch(() => {});
}

async function handleOkCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const extra  = (msg.text || '').replace(/^\/ok\s*/i, '').trim();
  const content = extra || 'Controllo effettuato — tutto regolare';

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  const now = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });

  await saveNote(tuUser, siteCtx.siteId, {
    category:            'nota',
    content,
    ai_summary:          `✅ ${content}`,
    ai_category:         'nota',
    urgency:             'normale',
    telegram_message_id: msg.message_id,
  });

  await sendAction(chatId,
    `✅ <b>Tutto OK</b> — <i>${siteCtx.siteName}</i>\n` +
    `🕐 ${now}\n` +
    (extra ? `📝 ${extra}` : `Registrato: tutto regolare`),
    siteCtx.siteId, 'nota'
  );
}

async function handlePresenzeCommand(msg, tuUser) {
  const chatId = msg.chat.id;
  const raw    = (msg.text || '').replace(/^\/presenze\s*/i, '').trim();

  if (!raw) {
    return tg.sendMessage(chatId,
      `👷 <b>Registra Presenze</b>\n\n` +
      `Uso: <code>/presenze Nome Cognome, Nome Cognome, ...</code>\n\n` +
      `Oppure scrivi liberamente:\n` +
      `<i>"Oggi presenti: Mario Rossi, Luigi Bianchi"</i>`
    );
  }

  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  // Conta i lavoratori menzionati (separati da virgola o newline)
  const names = raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);

  await saveNote(tuUser, siteCtx.siteId, {
    category:            'presenza',
    content:             raw,
    ai_summary:          `Presenti ${names.length} lavoratore/i: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`,
    ai_category:         'presenza',
    urgency:             'normale',
    telegram_message_id: msg.message_id,
  });

  await sendAction(chatId,
    `✅ <b>Presenze registrate</b> su <i>${siteCtx.siteName}</i>\n` +
    `👷 ${names.length} lavoratore/i: ${names.join(', ')}`,
    siteCtx.siteId, 'presenza'
  );
}

// ── Info e aiuto ─────────────────────────────────────────────

async function showRecentNotes(chatId, tuUser, text) {
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  const parts = text.trim().split(/\s+/);
  const limit = Math.min(parseInt(parts[1]) || 5, 20);

  const { data: notes } = await supabase
    .from('site_notes')
    .select('category, content, ai_summary, urgency, created_at')
    .eq('site_id', siteCtx.siteId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!notes || notes.length === 0) {
    return sendMain(chatId, `📋 Nessuna nota trovata per <i>${siteCtx.siteName}</i>.`);
  }

  const lines = notes.map(n => {
    const ico   = CATEGORY_ICONS[n.category] || '📌';
    const urg   = n.urgency === 'critica' ? '🔴 ' : n.urgency === 'alta' ? '🟡 ' : '';
    const date  = new Date(n.created_at).toLocaleDateString('it-IT', { day:'2-digit', month:'2-digit' });
    const label = n.ai_summary || (n.content || '').slice(0, 80);
    return `${urg}${ico} <b>${date}</b> — ${label}`;
  });

  await sendMain(chatId,
    `📋 <b>Ultime ${notes.length} note — ${siteCtx.siteName}</b>\n\n` +
    lines.join('\n')
  );
}

async function showStatus(chatId, tuUser) {
  // Cantiere attivo
  const siteInfo = tuUser.active_site_id
    ? await supabase.from('sites').select('id, name, address').eq('id', tuUser.active_site_id).maybeSingle()
    : { data: null };

  const site     = siteInfo.data;
  const siteName = site ? (site.name || site.address || 'senza nome') : 'nessuno';

  // Note di oggi
  const today = new Date(); today.setHours(0,0,0,0);
  const { count: notesToday } = await supabase
    .from('site_notes')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', tuUser.company_id)
    .gte('created_at', today.toISOString());

  // NC aperte sul cantiere attivo
  let openNc = 0;
  if (site?.id) {
    const { count } = await supabase
      .from('site_notes')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', site.id)
      .eq('category', 'non_conformita');
    openNc = count || 0;
  }

  // Dati economici del cantiere attivo
  let ecoLine = '';
  if (site?.id) {
    const { data: voci } = await supabase
      .from('site_economia_voci')
      .select('tipo, importo')
      .eq('site_id', site.id)
      .eq('company_id', tuUser.company_id);
    const { data: siteEco } = await supabase
      .from('sites')
      .select('budget_totale, sal_percentuale')
      .eq('id', site.id)
      .maybeSingle();

    if (voci && voci.length > 0) {
      const costi  = voci.filter(v => v.tipo === 'costo').reduce((s, v) => s + Number(v.importo), 0);
      const ricavi = voci.filter(v => v.tipo === 'ricavo').reduce((s, v) => s + Number(v.importo), 0);
      const utile  = ricavi - costi;
      ecoLine = `\n💶 Costi: <b>${fmtEuroBot(costi)}</b>  |  💰 Ricavi: <b>${fmtEuroBot(ricavi)}</b>\n` +
                `${utile >= 0 ? '✅' : '🔴'} Utile: <b>${fmtEuroBot(utile)}</b>`;
      if (siteEco?.budget_totale) {
        const budget   = Number(siteEco.budget_totale);
        const spendPct = Math.round((costi / budget) * 100);
        const sal      = Number(siteEco.sal_percentuale || 0);
        ecoLine += `\n${buildSalBar(sal)} SAL <b>${sal}%</b> | Budget consumato: <b>${spendPct}%</b>`;
        if (spendPct > sal + 10) ecoLine += `\n⚠️ <b>Rischio sforamento budget!</b>`;
      }
    }
  }

  await sendMain(chatId,
    `📊 <b>Stato cantiere</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 Note inviate oggi: <b>${notesToday || 0}</b>\n` +
    (openNc > 0 ? `⚠️ NC aperte: <b>${openNc}</b>\n` : '') +
    ecoLine +
    `\n\nTocca <b>📍 Cantieri</b> per cambiare cantiere.`
  );
}

async function showHelp(chatId) {
  await sendMain(chatId,
    `👷 <b>Guida Palladia Bot</b>\n\n` +
    `<b>Invia dal cantiere:</b>\n` +
    `📷 Foto → allegata con timestamp\n` +
    `🎙️ Vocale → trascritto dall'IA\n` +
    `📎 Documento → PDF/Excel archiviato\n` +
    `📝 Testo → nota classificata automaticamente\n\n` +
    `<b>Cantiere & Sicurezza:</b>\n` +
    `<code>/ok [nota]</code> — tutto regolare, check positivo\n` +
    `<code>/problema testo</code> — segnala problema urgente\n` +
    `<code>/nc testo</code> — non conformità (D.Lgs. 81)\n` +
    `<code>/presenze Mario, Luigi</code> — registra presenti\n\n` +
    `<b>Economia cantiere:</b>\n` +
    `<code>/costo 800 cemento portland</code> — registra spesa\n` +
    `<code>/ricavo 15000 SAL 1 approvato</code> — registra incasso\n` +
    `<code>/sal 65</code> — aggiorna avanzamento lavori al 65%\n\n` +
    `<b>Stato:</b>\n` +
    `<code>/stato</code> → riepilogo cantiere attivo + economia\n` +
    `<code>/note [n]</code> → ultime n note del cantiere\n\n` +
    `<b>🤖 Assistente AI Ladia:</b>\n` +
    `Premi <b>🤖 Ladia</b> per attivare l'assistente AI contestuale.\n` +
    `Conosce tutto del tuo cantiere e risponde a domande tecniche,\n` +
    `organizzative e gestionali. Solo su richiesta, non invadente.\n` +
    `<code>/ladia [domanda]</code> — chiedi direttamente\n\n` +
    `<b>Impostazioni:</b>\n` +
    `<code>/impostazioni</code> — gestisci le notifiche di Ladia\n` +
    `<code>/ispezione</code> — report conformità cantiere (NC, documenti, diario)`
  );
}

// ── Ladia — assistente AI contestuale ───────────────────────

async function handleLadiaButton(chatId, tuUser) {
  // Attiva modalità Ladia
  await supabase.from('telegram_users').update({ ladia_mode: true }).eq('id', tuUser.id);

  if (!tuUser.active_site_id) {
    return sendLadia(chatId,
      `🤖 <b>Ciao! Sono Ladia, la tua assistente di cantiere.</b>\n\n` +
      `Prima seleziona un <b>cantiere attivo</b> per darmi il contesto giusto.\n\n` +
      `Torna al <b>⬅️ Menu</b> e usa 📍 Cantieri.`
    );
  }

  await sendLadia(chatId,
    `🤖 <b>Ciao! Sono Ladia.</b>\n\n` +
    `Conosco tutto del tuo cantiere: lavoratori, note, economia, avanzamento.\n\n` +
    `Chiedimi qualsiasi cosa:\n` +
    `<i>"Hai già organizzato i preventivi con i subappaltatori?"</i>\n` +
    `<i>"Che stratigrafia consigli per la pavimentazione?"</i>\n` +
    `<i>"Cosa manca per chiudere il SAL?"</i>\n` +
    `<i>"Quali DPI servono per questa fase?"</i>\n\n` +
    `Scrivi pure — leggo tutto il contesto del cantiere prima di risponderti.\n` +
    `Premi <b>⬅️ Menu</b> per tornare al bot normale.`
  );
}

async function handleLadiaExit(chatId, tuUser) {
  await supabase.from('telegram_users').update({ ladia_mode: false }).eq('id', tuUser.id);
  await sendMain(chatId, `✅ Tornato al bot normale.`);
}

async function handleImpostazioniCommand(chatId, tuUser) {
  const level = tuUser.notification_level || 'balanced';
  const labels = {
    quiet:    '🤫 Solo briefing',
    balanced: '⚖️ Bilanciato',
    full:     '🔔 Tutto',
  };
  const descriptions = {
    quiet:    'Solo il recap mattutino e serale. Nessun alert durante la giornata.',
    balanced: 'Alert aggregati per cantiere (NC, budget, meteo, scadenze). Bilanciato.',
    full:     'Massima reattività. Ogni evento ha il suo messaggio.',
  };

  const currentLabel = labels[level] || labels.balanced;
  const currentDesc  = descriptions[level] || descriptions.balanced;

  const text =
    `⚙️ <b>Impostazioni Ladia</b>\n\n` +
    `Notifiche attuali: <b>${currentLabel}</b>\n` +
    `<i>${currentDesc}</i>\n\n` +
    `Scegli il livello che preferisci:`;

  const keyboard = tg.buildInlineKeyboard([
    { text: level === 'quiet'    ? '✅ Solo briefing' : '🤫 Solo briefing', callbackData: 'set:notif:quiet' },
    { text: level === 'balanced' ? '✅ Bilanciato'    : '⚖️ Bilanciato',    callbackData: 'set:notif:balanced' },
    { text: level === 'full'     ? '✅ Tutto'         : '🔔 Tutto',         callbackData: 'set:notif:full' },
  ], 1);

  await tg.sendMessage(chatId, text, { replyMarkup: keyboard });
}

async function handleIspezioneCommand(chatId, tuUser) {
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await tg.sendMessage(chatId, `🛡️ <i>Analisi conformità in corso…</i>`);
  tg.sendChatAction(chatId, 'typing').catch(() => {});

  let report;
  try {
    report = await runComplianceChecks(siteCtx.siteId, tuUser.company_id);
  } catch (err) {
    console.error('[handleIspezioneCommand] error:', err.message);
    await tg.sendMessage(chatId,
      `❌ <b>Ladia</b> — Errore nell'analisi. Riprova tra qualche secondo.`
    );
    return;
  }

  const msg      = buildComplianceMessage(report);
  const keyboard = tg.buildInlineKeyboard([
    { text: '🤖 Chiedi a Ladia come risolvere', callbackData: `act:open_ladia:${siteCtx.siteId}` },
  ], 1);

  await tg.sendMessage(chatId, msg, { replyMarkup: keyboard });
}

async function handleLadiaReset(chatId, tuUser) {
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await resetLadiaHistory(tuUser.company_id, tuUser.user_id, siteCtx.siteId);
  await sendLadia(chatId, `🔄 Conversazione azzerata. Riniziamo da capo!`);
}

async function handleLadiaCommand(msg, tuUser) {
  const chatId   = msg.chat.id;
  const question = (msg.text || '').replace(/^\/ladia\s*/i, '').trim();

  if (!question) {
    // Solo /ladia → attiva la modalità
    return handleLadiaButton(chatId, tuUser);
  }

  // /ladia [domanda] → attiva la modalità e risponde subito
  await supabase.from('telegram_users').update({ ladia_mode: true }).eq('id', tuUser.id);
  return handleLadiaText(chatId, tuUser, question);
}

async function handleLadiaMessage(msg, tuUser) {
  return handleLadiaText(msg.chat.id, tuUser, msg.text);
}

async function handleLadiaText(chatId, tuUser, question) {
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  // Typing indicator (best-effort)
  tg.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const reply = await askLadia(tuUser, siteCtx.siteId, siteCtx.siteName, question);
    await sendLadia(chatId, reply);
  } catch (err) {
    console.error('[handleLadiaText] error:', err.message);
    await sendLadia(chatId,
      `❌ Non riesco a rispondere in questo momento.\n\nRiprova tra qualche secondo.`
    );
  }
}

/**
 * Gestione PDF inviato in modalità Ladia.
 * Scarica il PDF, lo invia a Claude per analisi, salva come template di riferimento.
 */
async function handleLadiaPdf(msg, tuUser) {
  const chatId   = msg.chat.id;
  const doc      = msg.document;
  const filename = doc.file_name || 'documento.pdf';
  const caption  = msg.caption || '';

  // Limite dimensione: Telegram permette 20MB max per bot
  const MAX_PDF_MB = 20;
  if (doc.file_size && doc.file_size > MAX_PDF_MB * 1024 * 1024) {
    return sendLadia(chatId,
      `❌ PDF troppo grande (${Math.round(doc.file_size / 1_000_000)}MB).\n\nLimite: ${MAX_PDF_MB}MB.`
    );
  }

  await tg.sendMessage(chatId,
    `📄 Ricevuto <b>${filename}</b>.\n🔍 Sto leggendo e analizzando il documento…`
  );
  tg.sendChatAction(chatId, 'upload_document').catch(() => {});

  try {
    // Download da Telegram
    const fileInfo = await tg.getFile(doc.file_id);
    const buffer   = await tg.downloadFile(fileInfo.file_path);

    // Processa con Claude (analisi + storage + DB)
    const template = await processLadiaPdf(
      buffer,
      tuUser.company_id,
      chatId,
      filename
    );

    // Prepara risposta con riassunto
    const typeLabel = {
      contratto: 'Contratto', capitolato: 'Capitolato', POS: 'POS',
      PSC: 'PSC', computo: 'Computo metrico', fattura: 'Fattura',
      verbale: 'Verbale', preventivo: 'Preventivo', lettera: 'Lettera',
      relazione: 'Relazione', altro: 'Documento',
    }[template.document_type] || 'Documento';

    const sectionsPreview = template.key_sections?.length
      ? `\n\n<b>Sezioni chiave trovate (${template.key_sections.length}):</b>\n` +
        template.key_sections.slice(0, 5).map(s => `• ${s.titolo}`).join('\n')
      : '';

    const captionNote = caption
      ? `\n\n💬 Nota: "${caption}"`
      : '';

    const reply =
      `✅ <b>${typeLabel} archiviato nell'archivio Ladia.</b>\n\n` +
      `📄 <b>${filename}</b>\n\n` +
      `${template.summary}` +
      sectionsPreview +
      captionNote +
      `\n\n<i>Ora puoi chiedermi di redigere documenti simili, adattarlo o estrarne sezioni specifiche.</i>`;

    await sendLadia(chatId, reply);

    // Informa Ladia del documento appena caricato (contestualizza la conversazione)
    const followUp = caption
      ? `Ho appena caricato un ${template.document_type}: "${filename}". ${caption}. Cosa devo farne?`
      : `Ho appena caricato un ${template.document_type}: "${filename}". Cosa puoi farci?`;

    // Trigger conversazione Ladia sul documento (dopo 1s per non sovrapporre)
    setTimeout(async () => {
      try {
        const ladiaReply = await askLadia(
          tuUser,
          tuUser.active_site_id,
          '', // siteName non critico qui
          followUp
        );
        await sendLadia(chatId, ladiaReply);
      } catch {
        // Se Ladia non ha un cantiere attivo, non fa nulla — non è bloccante
      }
    }, 1200);

  } catch (err) {
    console.error('[handleLadiaPdf] error:', err.message);

    // Distingui errori Anthropic da altri
    const isApiErr = err.message.includes('Anthropic') || err.message.includes('Claude');
    await sendLadia(chatId,
      isApiErr
        ? `❌ Errore nell'analisi del PDF.\n\nIl documento potrebbe essere protetto da password, scansionato come immagine (testo non estraibile) o danneggiato.\n\nProva con un PDF con testo selezionabile.`
        : `❌ Errore nel processare il documento: ${err.message}`
    );
  }
}

async function sendNotLinked(chatId) {
  await tg.sendMessage(chatId,
    `🔒 <b>Account non ancora collegato.</b>\n\n` +
    `Per collegare Palladia:\n` +
    `1. Apri <b>palladia.net → Account → Telegram</b>\n` +
    `2. Clicca <b>"Collega Telegram"</b> — si apre automaticamente\n\n` +
    `In alternativa: <code>/start IL_TUO_CODICE</code>`
  );
}

// ── Helpers interni ──────────────────────────────────────────

async function getTelegramUser(chatId) {
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  return data || null;
}

async function requireActiveSite(chatId, tuUser) {
  if (!tuUser.active_site_id) {
    await tg.sendMessage(chatId,
      `📍 Nessun cantiere selezionato.\n\nUsa 📍 Cantieri per scegliere il cantiere attivo.`
    );
    await showSiteSelector(chatId, tuUser);
    return null;
  }

  const { data: site } = await supabase
    .from('sites')
    .select('id, name, address')
    .eq('id', tuUser.active_site_id)
    .maybeSingle();

  if (!site) {
    await tg.sendMessage(chatId, `⚠️ Cantiere non trovato. Selezionane un altro:`);
    await showSiteSelector(chatId, tuUser);
    return null;
  }

  return {
    siteId:   site.id,
    siteName: site.name || site.address || 'Cantiere',
  };
}

async function saveNote(tuUser, siteId, fields) {
  const row = {
    company_id:  tuUser.company_id,
    site_id:     siteId,
    author_id:   tuUser.user_id,
    author_name: tuUser.telegram_first_name || tuUser.telegram_username || 'Tecnico',
    source:      'telegram',
    telegram_chat_id: tuUser.telegram_chat_id,
    ...fields,
  };

  const { error } = await supabase.from('site_notes').insert(row);
  if (error) console.error('[saveNote] error:', error.message);
}

/**
 * Scarica il file da Telegram, comprime le immagini con sharp, carica su Supabase Storage.
 * Le foto vengono ridotte a max 1280px e JPEG 82% → da 2-5MB a ~150-400KB.
 * I documenti (PDF, Excel, ecc.) vengono caricati as-is.
 */
async function uploadTelegramFile(fileId, companyId, siteId, ext) {
  const fileInfo = await tg.getFile(fileId);
  let buffer     = await tg.downloadFile(fileInfo.file_path);

  const { randomBytes } = require('crypto');
  const uniqueId = randomBytes(8).toString('hex');
  const today    = new Date().toISOString().slice(0, 10);

  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
  const extLower   = ext.toLowerCase();
  let finalExt     = extLower;
  let contentType  = 'application/octet-stream';

  if (IMAGE_EXTS.has(extLower)) {
    // Comprimi: ridimensiona a max 1280px, converti in JPEG 82%
    buffer      = await sharp(buffer)
      .rotate()                          // rispetta l'orientamento EXIF
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
    finalExt    = 'jpg';
    contentType = 'image/jpeg';
  } else {
    const MIME_MAP = {
      pdf:  'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ogg:  'audio/ogg',
      mp3:  'audio/mpeg',
    };
    contentType = MIME_MAP[extLower] || 'application/octet-stream';
  }

  const storagePath = `${companyId}/${siteId}/${today}/${uniqueId}.${finalExt}`;

  const { error } = await supabase.storage
    .from('site-media')
    .upload(storagePath, buffer, { contentType, upsert: false });

  if (error) throw new Error(`Storage upload error: ${error.message}`);

  return { storagePath, sizeBytes: buffer.length };
}

// ── Label e icone ────────────────────────────────────────────

const CATEGORY_LABELS = {
  nota:             'Nota',
  foto:             'Foto',
  non_conformita:   'Non Conformità',
  verbale:          'Verbale',
  presenza:         'Presenze',
  incidente:        'Incidente',
  documento:        'Documento',
  altro:            'Altro',
};

const CATEGORY_ICONS = {
  nota:           '📝',
  foto:           '📷',
  non_conformita: '⚠️',
  verbale:        '📋',
  presenza:       '👷',
  incidente:      '🚨',
  documento:      '📎',
  altro:          '📌',
};

// ─────────────────────────────────────────────────────────────────────────────
// FLUSSO COORDINATORI PRO — Telegram
// I coordinatori (CSE/CSP/DL/RUP) si collegano tramite codice OTP generato
// dal Portale Professionisti (palladia.net/pro).
// ─────────────────────────────────────────────────────────────────────────────

async function getTelegramCoordinator(chatId) {
  const { data } = await supabase
    .from('telegram_coordinator_links')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  return data || null;
}

async function linkCoordinatorAccount(chatId, chat, code) {
  if (!code || code.length < 6) {
    return tg.sendMessage(chatId,
      `❌ <b>Codice non valido.</b>\n\n` +
      `Vai su <b>palladia.net/pro</b>, entra nel portale e clicca <b>"Collega Telegram"</b> per generare un codice.`
    );
  }

  const { data: codeRow } = await supabase
    .from('telegram_coordinator_link_codes')
    .select('email, expires_at, used_at')
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (!codeRow || codeRow.used_at || new Date(codeRow.expires_at) < new Date()) {
    return tg.sendMessage(chatId,
      `❌ <b>Codice scaduto o non valido.</b>\n\n` +
      `Torna su <b>palladia.net/pro</b> e genera un nuovo codice.`
    );
  }

  const { error: upsertErr } = await supabase
    .from('telegram_coordinator_links')
    .upsert({
      telegram_chat_id: chatId,
      email:            codeRow.email,
      telegram_username: chat.username  || null,
      telegram_name:     chat.first_name || null,
      last_active_at:    new Date().toISOString(),
    }, { onConflict: 'telegram_chat_id' });

  if (upsertErr) {
    console.error('[linkCoordinator] upsert error:', upsertErr.message);
    return tg.sendMessage(chatId, '❌ Errore interno. Riprova tra qualche minuto.');
  }

  await supabase
    .from('telegram_coordinator_link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code', code.toUpperCase());

  const firstName = chat.first_name || 'coordinatore';
  await tg.sendMessage(chatId,
    `✅ <b>Portale Pro collegato!</b>\n\n` +
    `Ciao <b>${firstName}</b>, sei collegato come professionista.\n\n` +
    `Da qui puoi:\n` +
    `• 📝 Inviare note e osservazioni\n` +
    `• ⚠️ Segnalare non conformità con <b>/nc testo</b>\n` +
    `• 📸 Scattare foto dal cantiere\n` +
    `• 🎙️ Inviare vocali — li trascrivo io\n\n` +
    `<b>Seleziona prima il cantiere su cui stai lavorando.</b>`,
    { replyMarkup: COORDINATOR_KEYBOARD }
  );

  const tuCoord = await getTelegramCoordinator(chatId);
  await showCoordinatorSiteSelector(chatId, tuCoord);
}

async function showCoordinatorSiteSelector(chatId, tuCoord) {
  const { data: invites } = await supabase
    .from('site_coordinator_invites')
    .select('site_id, sites(id, name, address, status)')
    .eq('coordinator_email', tuCoord.email)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .limit(20);

  const sites = (invites || [])
    .map(i => i.sites)
    .filter(s => s && s.status !== 'chiuso' && s.status !== 'eliminato');

  if (sites.length === 0) {
    return tg.sendMessage(chatId,
      `⚠️ <b>Nessun cantiere trovato.</b>\n\n` +
      `Non risulti ancora invitato su nessun cantiere attivo.\n` +
      `Chiedi all'impresa di inviarti l'accesso da <b>palladia.net</b>.`
    );
  }

  const buttons = sites.map(s => ({
    text: s.name || 'Cantiere',
    callbackData: `coord_site:${s.id}`,
  }));

  await tg.sendMessage(chatId,
    `📍 <b>Seleziona il cantiere attivo:</b>`,
    { replyMarkup: tg.buildInlineKeyboard(buttons, 1) }
  );
}

async function setCoordinatorActiveSite(chatId, tuCoord, siteId, callbackQueryId) {
  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, sites(name)')
    .eq('coordinator_email', tuCoord.email)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .maybeSingle();

  if (!invite) {
    await tg.answerCallbackQuery(callbackQueryId, 'Cantiere non trovato.');
    return;
  }

  await supabase
    .from('telegram_coordinator_links')
    .update({ active_site_id: siteId })
    .eq('telegram_chat_id', chatId);

  const siteName = invite.sites?.name || 'Cantiere';
  await tg.answerCallbackQuery(callbackQueryId, `✅ ${siteName}`);
  await tg.sendMessage(chatId,
    `✅ <b>Cantiere attivo: ${siteName}</b>\n\n` +
    `Inviami note, foto, vocali o usa /nc per le non conformità.\n` +
    `Per cambiare cantiere: /cantiere`,
    { replyMarkup: COORDINATOR_KEYBOARD }
  );
}

async function requireCoordinatorActiveSite(chatId, tuCoord) {
  if (!tuCoord.active_site_id) {
    await tg.sendMessage(chatId,
      `⚠️ <b>Nessun cantiere selezionato.</b>\n\n` +
      `Scrivi /cantiere per scegliere su quale cantiere stai lavorando.`
    );
    await showCoordinatorSiteSelector(chatId, tuCoord);
    return null;
  }

  const { data: invite } = await supabase
    .from('site_coordinator_invites')
    .select('id, sites(id, name)')
    .eq('coordinator_email', tuCoord.email)
    .eq('site_id', tuCoord.active_site_id)
    .eq('is_active', true)
    .maybeSingle();

  if (!invite) {
    await tg.sendMessage(chatId, '⚠️ Cantiere non più valido. Selezionane uno nuovo.');
    await supabase.from('telegram_coordinator_links').update({ active_site_id: null }).eq('telegram_chat_id', chatId);
    await showCoordinatorSiteSelector(chatId, tuCoord);
    return null;
  }

  return { inviteId: invite.id, siteId: tuCoord.active_site_id, siteName: invite.sites?.name || 'Cantiere' };
}

async function saveCoordinatorNote(tuCoord, siteCtx, noteType, content) {
  const profile = await supabase
    .from('coordinator_profiles')
    .select('full_name, qualifica')
    .eq('email', tuCoord.email)
    .maybeSingle();

  const coordName = profile.data?.full_name || tuCoord.email;

  await supabase.from('site_coordinator_notes').insert({
    invite_id:        siteCtx.inviteId,
    note_type:        noteType,
    content,
    coordinator_name: coordName,
    coordinator_qualifica: profile.data?.qualifica || null,
  });
}

async function handleCoordinatorMessage(msg, tuCoord) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  // Aggiorna last_active_at
  supabase.from('telegram_coordinator_links')
    .update({ last_active_at: new Date().toISOString() })
    .eq('telegram_chat_id', chatId)
    .then(() => {});

  // ── Navigazione ──────────────────────────────────────────
  if (text === '📍 Cantieri' || text.startsWith('/cantiere')) {
    coordLadiaMode.set(chatId, false); // esci da Ladia al cambio cantiere
    return showCoordinatorSiteSelector(chatId, tuCoord);
  }

  if (text === '📊 Stato' || text.startsWith('/stato')) {
    const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
    if (!siteCtx) return;
    return tg.sendMessage(chatId,
      `📊 <b>Cantiere attivo:</b> ${siteCtx.siteName}\n` +
      `Usa i bottoni o invia note, /nc, foto, vocali.`,
      { replyMarkup: COORDINATOR_KEYBOARD }
    );
  }

  if (text === '❓ Aiuto' || text.startsWith('/aiuto') || text === '/help') {
    return tg.sendMessage(chatId,
      `<b>Palladia Pro — Guida coordinatore</b>\n\n` +
      `<b>Dal cantiere:</b>\n` +
      `📷 Foto → documentazione fotografica\n` +
      `🎙️ Vocale → trascritto e salvato\n` +
      `📝 Testo libero → nota classificata\n\n` +
      `<b>Sicurezza:</b>\n` +
      `<code>/nc testo</code> — non conformità (notifica impresa)\n\n` +
      `<b>🤖 Ladia (AI sicurezza):</b>\n` +
      `Premi <b>🤖 Ladia</b> — ti aiuta su D.Lgs. 81, DPI,\n` +
      `PSC/POS, formazione, visite ispettive e molto altro.\n` +
      `<code>/ladia domanda</code> — chiedi direttamente\n\n` +
      `Vedi tutto su <b>palladia.net/pro</b>`,
      { replyMarkup: COORDINATOR_KEYBOARD }
    );
  }

  // ── Ladia ───────────────────────────────────────────────
  if (text === '🤖 Ladia') return handleCoordLadiaButton(chatId, tuCoord);
  if (text === '⬅️ Menu')   return handleCoordLadiaExit(chatId, tuCoord);
  if (text === '🔄 Reset chat') return handleCoordLadiaReset(chatId, tuCoord);
  if (text.startsWith('/ladia')) return handleCoordLadiaCommand(msg, tuCoord);

  // ── Non Conformità ───────────────────────────────────────
  if (text.startsWith('/nc ') || text === '/nc') {
    const ncText  = text.startsWith('/nc ') ? text.slice(4).trim() : '';
    const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
    if (!siteCtx) return;

    if (!ncText) {
      return tg.sendMessage(chatId,
        `⚠️ Descrivi la non conformità:\n<code>/nc descrizione del problema</code>`
      );
    }

    await saveCoordinatorNote(tuCoord, siteCtx, 'warning', `⚠️ NC: ${ncText}`);

    // Notifica l'impresa — recupera company_id dal cantiere
    const { data: siteData } = await supabase
      .from('sites').select('company_id').eq('id', siteCtx.siteId).maybeSingle();

    if (siteData?.company_id) {
      const coordName = tuCoord.telegram_name || tuCoord.telegram_username || 'Coordinatore';
      notifyCompany(siteData.company_id,
        `🚨 <b>NC dal coordinatore</b>\n\n` +
        `📍 <b>${siteCtx.siteName}</b>\n` +
        `📝 ${ncText}\n` +
        `👤 ${coordName}`,
        { excludeChatId: null }
      ).catch(() => {});
    }

    return tg.sendMessage(chatId,
      `🚨 <b>Non conformità registrata</b>\n\n` +
      `📍 ${siteCtx.siteName}\n` +
      `📝 ${ncText}\n\n` +
      `✅ Impresa notificata.`,
      { replyMarkup: tg.buildInlineKeyboard([
        { text: '👁 Vedi su Palladia', url: `${FRONTEND_URL}/pro` },
        { text: '📸 Aggiungi foto', callbackData: 'cmd:prompt_photo' },
      ], 2) }
    );
  }

  // ── Ladia mode: testo libero → Ladia ────────────────────
  if (coordLadiaMode.get(chatId) && text) {
    return handleCoordLadiaMessage(msg, tuCoord);
  }

  // ── Media ────────────────────────────────────────────────
  if (msg.photo) return handleCoordinatorPhoto(msg, tuCoord);
  if (msg.voice) return handleCoordinatorVoice(msg, tuCoord);

  // ── Testo libero → nota classificata ────────────────────
  if (text) {
    const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
    if (!siteCtx) return;

    const ai       = await classifyMessage(text, siteCtx.siteName);
    const noteType = ['non_conformita', 'incidente'].includes(ai.category) ? 'warning' : 'observation';

    await saveCoordinatorNote(tuCoord, siteCtx, noteType, text);

    const icon = CATEGORY_ICONS[ai.category] || '📝';
    return tg.sendMessage(chatId,
      `${icon} <b>${CATEGORY_LABELS[ai.category] || 'Nota'}</b> salvata\n📍 ${siteCtx.siteName}`,
      { replyMarkup: tg.buildInlineKeyboard([
        { text: '👁 Vedi su Palladia', url: `${FRONTEND_URL}/pro` },
      ], 1) }
    );
  }
}

// ── Ladia per coordinatori ────────────────────────────────────

async function handleCoordLadiaButton(chatId, tuCoord) {
  coordLadiaMode.set(chatId, true);

  if (!tuCoord.active_site_id) {
    return tg.sendMessage(chatId,
      `🤖 <b>Ciao! Sono Ladia, esperta di sicurezza cantieri.</b>\n\n` +
      `Prima seleziona un cantiere attivo con 📍 Cantieri.`,
      { replyMarkup: COORDINATOR_LADIA_KEYBOARD }
    );
  }

  return tg.sendMessage(chatId,
    `🤖 <b>Ciao! Sono Ladia, la tua consulente di sicurezza.</b>\n\n` +
    `Conosco i lavoratori del cantiere e le loro scadenze.\n\n` +
    `Chiedimi qualsiasi cosa su:\n` +
    `<i>"Quali DPI servono per lavori in quota oggi?"</i>\n` +
    `<i>"Il PSC va aggiornato se cambia la fase?"</i>\n` +
    `<i>"Mario Rossi ha la formazione a norma?"</i>\n` +
    `<i>"Cosa devo verbalizzare dopo la visita ASL?"</i>\n\n` +
    `Premi <b>⬅️ Menu</b> per tornare al bot normale.`,
    { replyMarkup: COORDINATOR_LADIA_KEYBOARD }
  );
}

async function handleCoordLadiaExit(chatId, tuCoord) {
  coordLadiaMode.set(chatId, false);
  return tg.sendMessage(chatId, `✅ Tornato al bot normale.`, { replyMarkup: COORDINATOR_KEYBOARD });
}

async function handleCoordLadiaReset(chatId, tuCoord) {
  const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
  if (!siteCtx) return;

  const { data: site } = await supabase.from('sites').select('company_id').eq('id', siteCtx.siteId).maybeSingle();
  if (site?.company_id) {
    await resetLadiaHistory(site.company_id, coordUserId(chatId), siteCtx.siteId).catch(() => {});
  }

  return tg.sendMessage(chatId, `🔄 Conversazione azzerata. Riniziamo!`, { replyMarkup: COORDINATOR_LADIA_KEYBOARD });
}

async function handleCoordLadiaCommand(msg, tuCoord) {
  const chatId   = msg.chat.id;
  const question = (msg.text || '').replace(/^\/ladia\s*/i, '').trim();

  if (!question) return handleCoordLadiaButton(chatId, tuCoord);

  coordLadiaMode.set(chatId, true);
  return handleCoordLadiaText(chatId, tuCoord, question);
}

async function handleCoordLadiaMessage(msg, tuCoord) {
  return handleCoordLadiaText(msg.chat.id, tuCoord, msg.text);
}

async function handleCoordLadiaText(chatId, tuCoord, question) {
  const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
  if (!siteCtx) return;

  tg.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const reply = await askLadiaCoordinator(tuCoord, siteCtx.siteId, siteCtx.siteName, question);
    return tg.sendMessage(chatId, reply, { replyMarkup: COORDINATOR_LADIA_KEYBOARD });
  } catch (err) {
    console.error('[handleCoordLadiaText] error:', err.message);
    return tg.sendMessage(chatId,
      `❌ Non riesco a rispondere ora. Riprova tra qualche secondo.`,
      { replyMarkup: COORDINATOR_LADIA_KEYBOARD }
    );
  }
}

async function handleCoordinatorPhoto(msg, tuCoord) {
  const chatId  = msg.chat.id;
  const caption = msg.caption || 'Foto dal cantiere';
  const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
  if (!siteCtx) return;

  try {
    const photo    = msg.photo[msg.photo.length - 1];
    const fileInfo = await tg.getFile(photo.file_id);
    const buffer   = await tg.downloadFile(fileInfo.file_path);
    const compressed = await sharp(buffer).jpeg({ quality: 80 }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).toBuffer();

    const fileName = `coordinator/${tuCoord.email.replace('@', '_')}/${siteCtx.siteId}/${Date.now()}.jpg`;
    const { data: uploaded } = await supabase.storage.from('site-media').upload(fileName, compressed, { contentType: 'image/jpeg', upsert: false });

    let photoUrl = null;
    if (uploaded) {
      const { data: { publicUrl } } = supabase.storage.from('site-media').getPublicUrl(fileName);
      photoUrl = publicUrl;
    }

    const content = photoUrl ? `${caption}\n📷 ${photoUrl}` : caption;
    await saveCoordinatorNote(tuCoord, siteCtx, 'observation', content);

    return tg.sendMessage(chatId,
      `📸 <b>Foto salvata</b>\n📍 ${siteCtx.siteName}`,
      { replyMarkup: tg.buildInlineKeyboard([{ text: '👁 Vedi su Palladia', url: `${FRONTEND_URL}/pro` }], 1) }
    );
  } catch (err) {
    console.error('[coordinator photo]', err.message);
    return tg.sendMessage(chatId, '❌ Errore salvataggio foto. Riprova.');
  }
}

async function handleCoordinatorVoice(msg, tuCoord) {
  const chatId  = msg.chat.id;
  const siteCtx = await requireCoordinatorActiveSite(chatId, tuCoord);
  if (!siteCtx) return;

  await tg.sendMessage(chatId, `🎙️ Trascrivo il vocale…`);

  try {
    const fileInfo  = await tg.getFile(msg.voice.file_id);
    const buffer    = await tg.downloadFile(fileInfo.file_path);
    const { transcribeOgg } = require('./telegramAI');
    const transcript = await transcribeOgg(buffer);

    if (!transcript) {
      return tg.sendMessage(chatId, '❌ Non sono riuscito a trascrivere il vocale. Riprova o scrivi il messaggio.');
    }

    const ai = await classifyMessage(transcript, siteCtx.siteName);
    const noteType = ['non_conformita', 'incidente'].includes(ai.category) ? 'warning' : 'observation';

    await saveCoordinatorNote(tuCoord, siteCtx, noteType, `🎙️ ${transcript}`);

    const icon = CATEGORY_ICONS[ai.category] || '📝';
    return tg.sendMessage(chatId,
      `${icon} <b>Vocale trascritto e salvato</b>\n` +
      `📍 ${siteCtx.siteName}\n\n` +
      `<i>"${transcript.slice(0, 200)}${transcript.length > 200 ? '…' : ''}"</i>`
    );
  } catch (err) {
    console.error('[coordinator voice]', err.message);
    return tg.sendMessage(chatId, '❌ Errore trascrizione. Scrivi il messaggio come testo.');
  }
}

// ── I miei cantieri ──────────────────────────────────────────

/**
 * Mostra la lista di cantieri della company con checkmark ✅/☐ in base alle assegnazioni.
 * owner/admin: ricevono un messaggio informativo (vedono tutto).
 * tech/viewer: vedono la lista con toggle tap-per-tap.
 */
async function handleMyCantieri(chatId, tuUser) {
  // Verifica ruolo
  const { data: cu } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', tuUser.company_id)
    .eq('user_id', tuUser.user_id)
    .single();

  const role = cu?.role || 'tech';

  if (role === 'owner' || role === 'admin') {
    return tg.sendMessage(chatId,
      `<b>I tuoi cantieri</b>\n\n` +
      `Sei ${role === 'owner' ? 'titolare' : 'admin'}: ricevi automaticamente le notifiche di <b>tutti i cantieri</b> dell'impresa.\n\n` +
      `Non è necessario configurare nulla.`
    );
  }

  // Fetch cantieri attivi e assegnazioni correnti
  const [sitesRes, assignRes] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address')
      .eq('company_id', tuUser.company_id)
      .neq('status', 'chiuso')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('user_site_assignments')
      .select('site_id')
      .eq('company_id', tuUser.company_id)
      .eq('user_id', tuUser.user_id),
  ]);

  const sites    = sitesRes.data || [];
  const assigned = new Set((assignRes.data || []).map(a => a.site_id));

  if (!sites.length) {
    return tg.sendMessage(chatId,
      `Nessun cantiere attivo trovato. Creane uno su <b>palladia.net</b>.`
    );
  }

  const buttons = sites.map(s => ({
    text:         (assigned.has(s.id) ? '✅ ' : '☐ ') + (s.name || s.address || 'Cantiere'),
    callbackData: `sites:toggle:${s.id}`,
  }));

  const assignedCount = assigned.size;
  const header = assignedCount === 0
    ? `<b>I miei cantieri</b>\n\nNessun cantiere selezionato — non riceverai notifiche.\nTocca per attivare:`
    : `<b>I miei cantieri</b>\n\n${assignedCount} su ${sites.length} selezionat${assignedCount > 1 ? 'i' : 'o'}.\nTocca per attivare/disattivare:`;

  await tg.sendMessage(chatId, header, { replyMarkup: tg.buildInlineKeyboard(buttons, 1) });
}

/**
 * Toggle un singolo cantiere nell'assegnazione dell'utente.
 * Se era assegnato → rimuove. Se non era assegnato → aggiunge.
 * Poi aggiorna il messaggio inline con i nuovi checkmark.
 */
async function handleSiteToggle(chatId, tuUser, siteId, messageId) {
  // Cerca assegnazione esistente
  const { data: existing } = await supabase
    .from('user_site_assignments')
    .select('id')
    .eq('company_id', tuUser.company_id)
    .eq('user_id', tuUser.user_id)
    .eq('site_id', siteId)
    .single();

  if (existing) {
    await supabase.from('user_site_assignments')
      .delete()
      .eq('id', existing.id);
  } else {
    await supabase.from('user_site_assignments')
      .insert({ company_id: tuUser.company_id, user_id: tuUser.user_id, site_id: siteId });
  }

  // Rigenera keyboard aggiornata
  const [sitesRes, assignRes] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address')
      .eq('company_id', tuUser.company_id)
      .neq('status', 'chiuso')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('user_site_assignments')
      .select('site_id')
      .eq('company_id', tuUser.company_id)
      .eq('user_id', tuUser.user_id),
  ]);

  const sites    = sitesRes.data || [];
  const assigned = new Set((assignRes.data || []).map(a => a.site_id));

  const buttons = sites.map(s => ({
    text:         (assigned.has(s.id) ? '✅ ' : '☐ ') + (s.name || s.address || 'Cantiere'),
    callbackData: `sites:toggle:${s.id}`,
  }));

  const assignedCount = assigned.size;
  const header = assignedCount === 0
    ? `<b>I miei cantieri</b>\n\nNessun cantiere selezionato — non riceverai notifiche.\nTocca per attivare:`
    : `<b>I miei cantieri</b>\n\n${assignedCount} su ${sites.length} selezionat${assignedCount > 1 ? 'i' : 'o'}.\nTocca per attivare/disattivare:`;

  if (messageId) {
    await tg.editMessageText(chatId, messageId, header, { replyMarkup: tg.buildInlineKeyboard(buttons, 1) })
      .catch(() => {
        // fallback: invia nuovo messaggio
        return tg.sendMessage(chatId, header, { replyMarkup: tg.buildInlineKeyboard(buttons, 1) });
      });
  } else {
    await tg.sendMessage(chatId, header, { replyMarkup: tg.buildInlineKeyboard(buttons, 1) });
  }
}

module.exports = { handleUpdate };
