'use strict';
/**
 * services/telegramHandler.js
 * Logica principale del bot: riceve un update Telegram e lo gestisce.
 *
 * Flusso:
 *   handleUpdate(update)
 *     ├─ message → handleMessage(msg, tuUser)
 *     │    ├─ /start TOKEN → linkAccount()
 *     │    ├─ /cantiere    → showSiteSelector()
 *     │    ├─ /note [n]    → showRecentNotes()
 *     │    ├─ /stato       → showStatus()
 *     │    ├─ /aiuto       → showHelp()
 *     │    ├─ /nc testo    → saveNote(non_conformita, critica)
 *     │    ├─ /presenze    → saveNote(presenza)
 *     │    ├─ foto         → handlePhoto()
 *     │    ├─ documento    → handleDocument()
 *     │    └─ testo libero → handleText() → AI classify → saveNote()
 *     └─ callback_query → handleCallbackQuery()
 *          └─ site:UUID → setActiveSite()
 */

const tg             = require('./telegram');
const { classifyMessage } = require('./telegramAI');
const { logEvent }   = require('./telegramLog');
const supabase       = require('../lib/supabase');

// ── Entry point ──────────────────────────────────────────────

async function handleUpdate(update) {
  try {
    if (update.message) {
      const msg    = update.message;
      const chatId = msg.chat.id;

      // Cerca utente collegato
      const tuUser = await getTelegramUser(chatId);

      // Aggiorna last_active_at (fire-and-forget)
      if (tuUser) {
        supabase.from('telegram_users')
          .update({ last_active_at: new Date().toISOString() })
          .eq('id', tuUser.id)
          .then(() => {});
      }

      await handleMessage(msg, tuUser);
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error('[telegramHandler] errore update:', err.message);
  }
}

// ── Gestione messaggi ────────────────────────────────────────

async function handleMessage(msg, tuUser) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  // Comando /start (anche senza essere collegati)
  if (text.startsWith('/start')) {
    return handleStart(msg, tuUser);
  }

  // Utente non collegato → istruzioni link
  if (!tuUser) {
    return sendNotLinked(chatId);
  }

  // Comandi autenticati
  if (text.startsWith('/cantiere')) return showSiteSelector(chatId, tuUser);
  if (text.startsWith('/note'))     return showRecentNotes(chatId, tuUser, text);
  if (text.startsWith('/stato'))    return showStatus(chatId, tuUser);
  if (text.startsWith('/aiuto') || text === '/help') return showHelp(chatId);
  if (text.startsWith('/nc ') || text === '/nc')     return handleNcCommand(msg, tuUser);
  if (text.startsWith('/presenze')) return handlePresenzeCommand(msg, tuUser);

  // Media
  if (msg.photo)    return handlePhoto(msg, tuUser);
  if (msg.document) return handleDocument(msg, tuUser);
  if (msg.voice)    return handleVoice(msg, tuUser);

  // Testo libero → classify + salva
  if (text) return handleText(msg, tuUser);
}

// ── /start ───────────────────────────────────────────────────

async function handleStart(msg, existingUser) {
  const chatId    = msg.chat.id;
  const firstName = msg.chat.first_name || 'tecnico';
  const parts     = (msg.text || '').trim().split(/\s+/);
  const token     = parts[1] || null;

  // Già collegato
  if (existingUser && !token) {
    return tg.sendMessage(chatId,
      `Ciao <b>${firstName}</b>! Sei già collegato a Palladia.\n\n` +
      `Digita /aiuto per vedere i comandi disponibili.`
    );
  }

  // Token fornito → collegamento
  if (token) {
    return linkAccount(chatId, msg.chat, token);
  }

  // Nessun token → istruzioni
  await tg.sendMessage(chatId,
    `👷 <b>Benvenuto su Palladia Bot!</b>\n\n` +
    `Per collegare il tuo account:\n` +
    `1. Vai su <b>Palladia → Account → Telegram</b>\n` +
    `2. Copia il tuo codice di collegamento\n` +
    `3. Incollalo qui: <code>/start IL_TUO_CODICE</code>`
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
      `Genera un nuovo codice da <b>Palladia → Account → Telegram</b>.`
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

  // Recupera utente per mostrare il selettore cantieri
  const tuUser = await getTelegramUser(chatId);

  const firstName = chat.first_name || 'tecnico';
  await tg.sendMessage(chatId,
    `✅ <b>Account collegato con successo!</b>\n\n` +
    `Ciao <b>${firstName}</b>, sono il tuo assistente di cantiere.\n\n` +
    `📱 Puoi inviarmi:\n` +
    `• Note e verbali (testo libero)\n` +
    `• Foto di cantiere\n` +
    `• Documenti PDF\n` +
    `• Segnalazioni di non conformità\n\n` +
    `Classifico tutto automaticamente e lo trovi ordinato su Palladia.\n\n` +
    `<b>Prima cosa: seleziona il cantiere su cui lavori oggi.</b>`
  );

  // Mostra selettore cantieri
  await showSiteSelector(chatId, tuUser);
}

// ── Selezione cantiere ───────────────────────────────────────

async function showSiteSelector(chatId, tuUser) {
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, site_name, address')
    .eq('company_id', tuUser.company_id)
    .neq('status', 'chiuso')
    .order('created_at', { ascending: false })
    .limit(20);

  if (!sites || sites.length === 0) {
    return tg.sendMessage(chatId,
      `⚠️ Nessun cantiere attivo trovato.\n` +
      `Crea un cantiere su <b>palladia.net</b> per continuare.`
    );
  }

  const buttons = sites.map(s => ({
    text: s.site_name || s.name || s.address || 'Cantiere senza nome',
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

  if (data.startsWith('site:')) {
    const siteId = data.slice(5);
    const tuUser = await getTelegramUser(chatId);
    if (!tuUser) {
      await tg.answerCallbackQuery(cbq.id, 'Account non collegato.');
      return;
    }
    await setActiveSite(chatId, tuUser, siteId, cbq.id);
  }

  // note_page: (paginazione futura) — ignore per ora
}

async function setActiveSite(chatId, tuUser, siteId, callbackQueryId) {
  // Verifica che il cantiere appartenga alla company dell'utente
  const { data: site } = await supabase
    .from('sites')
    .select('id, site_name, name, address')
    .eq('id', siteId)
    .eq('company_id', tuUser.company_id)
    .maybeSingle();

  if (!site) {
    await tg.answerCallbackQuery(callbackQueryId, 'Cantiere non trovato.');
    return;
  }

  await supabase.from('telegram_users')
    .update({ active_site_id: siteId })
    .eq('id', tuUser.id);

  const siteName = site.site_name || site.name || site.address || 'Cantiere';
  await tg.answerCallbackQuery(callbackQueryId, `✅ ${siteName}`);
  await tg.sendMessage(chatId,
    `✅ <b>Cantiere attivo: ${siteName}</b>\n\n` +
    `Ora puoi inviarmi note, foto, documenti o segnalazioni.\n` +
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
    category:           ai.category,
    content:            text,
    ai_summary:         ai.summary,
    ai_category:        ai.category,
    urgency:            ai.urgency,
    telegram_message_id: msg.message_id,
  });

  const categoryLabel = CATEGORY_LABELS[ai.category] || ai.category;
  const urgencyTag    = ai.urgency === 'critica' ? ' 🔴' : ai.urgency === 'alta' ? ' 🟡' : '';

  await tg.sendMessage(chatId,
    `✅ <b>${categoryLabel}${urgencyTag}</b> salvata su <i>${siteCtx.siteName}</i>\n` +
    (ai.summary ? `\n📝 ${ai.summary}` : '')
  );
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
  await tg.sendMessage(chatId,
    `✅ <b>Foto${urgencyTag}</b> salvata su <i>${siteCtx.siteName}</i>` +
    (caption ? `\n📝 ${caption.slice(0, 100)}` : '')
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

  await tg.sendMessage(chatId,
    `✅ <b>Documento</b> salvato su <i>${siteCtx.siteName}</i>\n` +
    `📎 ${filename}`
  );
}

async function handleVoice(msg, tuUser) {
  const chatId = msg.chat.id;
  // v1: non trascriviamo, salviamo solo il riferimento
  const siteCtx = await requireActiveSite(chatId, tuUser);
  if (!siteCtx) return;

  await tg.sendMessage(chatId,
    `🎙️ Messaggio vocale ricevuto.\n\n` +
    `<i>La trascrizione automatica sarà disponibile nella prossima versione.</i>\n` +
    `Se vuoi registrare questa nota, riscrivila come testo.`
  );
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

  await tg.sendMessage(chatId,
    `🟡 <b>Non Conformità registrata</b> su <i>${siteCtx.siteName}</i>\n\n` +
    `📝 ${text}`
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
    ai_summary:          `Presenti ${names.length} lavoratore/i: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`,
    ai_category:         'presenza',
    urgency:             'normale',
    telegram_message_id: msg.message_id,
  });

  await tg.sendMessage(chatId,
    `✅ <b>Presenze registrate</b> su <i>${siteCtx.siteName}</i>\n` +
    `👷 ${names.length} lavoratore/i: ${names.join(', ')}`
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
    return tg.sendMessage(chatId, `📋 Nessuna nota trovata per <i>${siteCtx.siteName}</i>.`);
  }

  const lines = notes.map(n => {
    const ico   = CATEGORY_ICONS[n.category] || '📌';
    const urg   = n.urgency === 'critica' ? '🔴 ' : n.urgency === 'alta' ? '🟡 ' : '';
    const date  = new Date(n.created_at).toLocaleDateString('it-IT', { day:'2-digit', month:'2-digit' });
    const label = n.ai_summary || (n.content || '').slice(0, 80);
    return `${urg}${ico} <b>${date}</b> — ${label}`;
  });

  await tg.sendMessage(chatId,
    `📋 <b>Ultime ${notes.length} note — ${siteCtx.siteName}</b>\n\n` +
    lines.join('\n')
  );
}

async function showStatus(chatId, tuUser) {
  // Cantiere attivo
  const siteInfo = tuUser.active_site_id
    ? await supabase.from('sites').select('site_name, name, address').eq('id', tuUser.active_site_id).maybeSingle()
    : { data: null };

  const siteName = siteInfo.data
    ? (siteInfo.data.site_name || siteInfo.data.name || siteInfo.data.address || 'senza nome')
    : 'nessuno';

  // Conteggio note di oggi
  const today = new Date(); today.setHours(0,0,0,0);
  const { count } = await supabase
    .from('site_notes')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', tuUser.company_id)
    .gte('created_at', today.toISOString());

  await tg.sendMessage(chatId,
    `📊 <b>Stato attuale</b>\n\n` +
    `📍 Cantiere attivo: <b>${siteName}</b>\n` +
    `📝 Note inviate oggi: <b>${count || 0}</b>\n\n` +
    `Digita /cantiere per cambiare cantiere.`
  );
}

async function showHelp(chatId) {
  await tg.sendMessage(chatId,
    `👷 <b>Guida Palladia Bot</b>\n\n` +
    `<b>Comandi rapidi:</b>\n` +
    `/cantiere — seleziona cantiere attivo\n` +
    `/nc <i>testo</i> — segnala non conformità\n` +
    `/presenze <i>nomi</i> — registra presenze\n` +
    `/note [n] — ultime n note (default 5)\n` +
    `/stato — cantiere attivo + riepilogo\n\n` +
    `<b>Invio libero:</b>\n` +
    `📝 Testo → nota classificata automaticamente\n` +
    `📷 Foto → allegata al cantiere\n` +
    `📎 Documento → PDF/Excel salvato\n\n` +
    `<b>Categorie riconosciute:</b>\n` +
    `${Object.entries(CATEGORY_ICONS).map(([k,v]) => `${v} ${CATEGORY_LABELS[k]||k}`).join('  ')}\n\n` +
    `Tutto finisce ordinato su <b>palladia.net</b>`
  );
}

async function sendNotLinked(chatId) {
  await tg.sendMessage(chatId,
    `🔒 <b>Account non collegato.</b>\n\n` +
    `Per usare Palladia Bot:\n` +
    `1. Vai su <b>palladia.net → Account → Telegram</b>\n` +
    `2. Copia il tuo codice personale\n` +
    `3. Incollalo qui: <code>/start IL_TUO_CODICE</code>`
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
      `📍 Nessun cantiere selezionato.\n\nUsa /cantiere per scegliere il cantiere attivo.`
    );
    await showSiteSelector(chatId, tuUser);
    return null;
  }

  const { data: site } = await supabase
    .from('sites')
    .select('id, site_name, name, address')
    .eq('id', tuUser.active_site_id)
    .maybeSingle();

  if (!site) {
    await tg.sendMessage(chatId, `⚠️ Cantiere non trovato. Selezionane un altro:`);
    await showSiteSelector(chatId, tuUser);
    return null;
  }

  return {
    siteId:   site.id,
    siteName: site.site_name || site.name || site.address || 'Cantiere',
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
 * Scarica il file da Telegram e lo carica su Supabase Storage (bucket privato).
 * Ritorna il path relativo (es. "company/site/2026-03-26/abc123.jpg").
 * NON ritorna un URL pubblico — usare signed URL per visualizzare.
 */
async function uploadTelegramFile(fileId, companyId, siteId, ext) {
  const fileInfo = await require('./telegram').getFile(fileId);
  const buffer   = await require('./telegram').downloadFile(fileInfo.file_path);

  const { randomBytes } = require('crypto');
  const uniqueId = randomBytes(8).toString('hex');
  const today    = new Date().toISOString().slice(0, 10);
  const storagePath = `${companyId}/${siteId}/${today}/${uniqueId}.${ext}`;

  const contentTypeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  const contentType = contentTypeMap[ext.toLowerCase()] || 'application/octet-stream';

  const { error } = await supabase.storage
    .from('site-media')
    .upload(storagePath, buffer, { contentType, upsert: false });

  if (error) throw new Error(`Storage upload error: ${error.message}`);

  // Ritorna il PATH (non URL pubblico) — bucket è privato
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

module.exports = { handleUpdate };
