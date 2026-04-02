'use strict';
/**
 * services/telegramLadia.js
 * Ladia — assistente AI contestuale per cantieri, accessibile via Telegram.
 *
 * Funzionamento:
 * - Carica il contesto completo del cantiere attivo (sito, lavoratori, note, economia, meteo)
 * - Mantiene lo storico conversazione in chat_conversations + chat_messages
 * - Risponde con Claude Sonnet con tool use (crea NC, aggiungi nota, meteo, stato, lista NC)
 * - Non invadente: attivato solo su richiesta esplicita dell'utente
 */

const supabase = require('../lib/supabase');
const { getWeatherSummary } = require('./weatherService');
const { LADIA_TOOL_DEFINITIONS, executeTool } = require('./ladiaTools');
const { getTemplateIndex } = require('./ladiaDocumentProcessor');

const SONNET_MODEL    = 'claude-sonnet-4-6';
const MAX_HISTORY     = 20;   // messaggi mantenuti per sessione (10 scambi)
const MAX_TOKENS      = 1400; // leggermente aumentato per risposta + tool planning
const MAX_TOOL_LOOPS  = 4;    // max iterazioni tool use per singola risposta

// ── System prompt ──────────────────────────────────────────────

function buildSystemPrompt(siteContext) {
  const now = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });

  return `Sei Ladia, l'assistente AI di Palladia per la gestione dei cantieri edili italiani.
Sei concisa, pratica e diretta. Rispondi sempre in italiano.
Usa formattazione Telegram HTML: <b>grassetto</b>, <i>corsivo</i>, <code>codice</code>.
Risposte brevi (max 400 parole) salvo se l'utente chiede dettagli.

Hai piena conoscenza di:
- D.Lgs. 81/2008 (sicurezza cantieri), PSC, POS, DVR
- Direzione Lavori, CSE/CSP, RUP, collaudi
- Contabilità cantieri: SAL, computo metrico, capitolato, varianti
- Prezziari regionali italiani, analisi prezzi, offerta a base d'asta
- Subappalti, DURC, idoneità tecnico-professionale
- Materiali edili, stratigrafie, fondazioni, strutture
- Normativa urbanistica, titoli edilizi, SCIA, permessi di costruire
- Gestione budget, pianificazione, programma lavori, gantt

Hai accesso a questi strumenti per AGIRE direttamente (non solo rispondere):
- <b>meteo_cantiere</b>: previsioni 3gg per il cantiere
- <b>lista_nc_aperte</b>: elenca NC aperte filtrate per urgenza
- <b>stato_cantiere</b>: riepilogo live di presenze, NC, budget
- <b>crea_non_conformita</b>: registra una NC nel sistema
- <b>aggiungi_nota</b>: salva una nota nel diario del cantiere
- <b>cerca_template_documento</b>: cerca tra i PDF caricati dall'impresa (contratti, capitolati, POS, ecc.) per usarli come modello

Usa i tool quando è utile, non sistematicamente. Preferisci rispondere dal contesto
già caricato se l'informazione è già lì. Usa i tool solo per dati freschi o azioni.

DOCUMENTI DI RIFERIMENTO:
Quando l'utente chiede di redigere, adattare o replicare un documento, usa SEMPRE
cerca_template_documento per trovare i modelli caricati dall'impresa e basati su quelli.
Non inventare strutture contrattuali — usa i template reali dell'impresa.

Data attuale: ${now}

━━━ DATI CANTIERE ATTIVO ━━━
${siteContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Comportamento:
- Rispondi a domande tecniche, organizzative e gestionali
- Quando il contesto mostra un rischio (budget, NC critiche, scadenze) segnalalo con tatto
- Suggerisci il prossimo passo logico se è ovvio dal contesto
- Tono da collega esperto, mai da chatbot generico
- Se crei una NC o nota, conferma con un messaggio chiaro all'utente`;
}

// ── Caricamento contesto cantiere ─────────────────────────────

async function buildSiteContext(companyId, siteId) {
  const [
    siteRes,
    workersRes,
    notesRes,
    vociRes,
    worksiteWorkersRes,
    ncCountRes,
  ] = await Promise.all([
    supabase.from('sites')
      .select('name, address, status, budget_totale, sal_percentuale, descrizione, latitude, longitude')
      .eq('id', siteId)
      .maybeSingle(),

    supabase.from('workers')
      .select('id, full_name, qualification, role')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .limit(60),

    supabase.from('site_notes')
      .select('category, content, ai_summary, urgency, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(12),

    supabase.from('site_economia_voci')
      .select('tipo, categoria, voce, importo')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(30),

    supabase.from('worksite_workers')
      .select('worker_id')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('status', 'active'),

    // Conta NC aperte (tutte, non solo ultime 12)
    supabase.from('site_notes')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId)
      .eq('category', 'non_conformita'),
  ]);

  const site            = siteRes.data;
  const allWorkers      = workersRes.data  || [];
  const notes           = notesRes.data    || [];
  const voci            = vociRes.data     || [];
  const worksiteWorkers = worksiteWorkersRes.data || [];
  const ncTotal         = ncCountRes.count || 0;

  if (!site) return 'Dati cantiere non disponibili.';

  const fmtEur = n => new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(n);

  // ── Dati generali ──
  let ctx = `Nome: ${site.name || 'N/D'}
Indirizzo: ${site.address || 'N/D'}
Stato: ${site.status || 'N/D'}
SAL avanzamento: ${site.sal_percentuale ?? 0}%`;

  if (site.budget_totale) ctx += `\nBudget: ${fmtEur(site.budget_totale)}`;
  if (site.descrizione)   ctx += `\nDescrizione: ${site.descrizione}`;

  // ── Meteo (se GPS disponibile) ──
  if (site.latitude && site.longitude) {
    const weatherSummary = await getWeatherSummary(site.latitude, site.longitude).catch(() => null);
    if (weatherSummary) ctx += `\n\nMeteo cantiere:\n${weatherSummary}`;
  }

  // ── Template documenti disponibili ──
  const templates = await getTemplateIndex(companyId, 15).catch(() => []);
  if (templates.length > 0) {
    ctx += `\n\nDocumenti di riferimento caricati (${templates.length}) — usa cerca_template_documento per il contenuto:`;
    templates.forEach(t => {
      const d = new Date(t.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
      ctx += `\n- [${t.id.slice(0, 8)}] ${t.original_filename} (${t.document_type}) — ${d}`;
    });
  }

  // ── Lavoratori ──
  const assignedIds = new Set(worksiteWorkers.map(ww => ww.worker_id));
  const assigned    = allWorkers.filter(w => assignedIds.has(w.id));
  const workers     = assigned.length > 0 ? assigned : allWorkers;

  if (workers.length > 0) {
    ctx += `\n\nLavoratori assegnati (${workers.length}):`;
    workers.slice(0, 15).forEach(w => {
      ctx += `\n- ${w.full_name}`;
      if (w.qualification) ctx += ` (${w.qualification})`;
      if (w.role)          ctx += `, ${w.role}`;
    });
    if (workers.length > 15) ctx += `\n... e altri ${workers.length - 15}`;
  } else {
    ctx += `\n\nLavoratori: nessuno assegnato`;
  }

  // ── Economia ──
  const costiList  = voci.filter(v => v.tipo === 'costo');
  const ricaviList = voci.filter(v => v.tipo === 'ricavo');
  const costi      = costiList.reduce((s, v)  => s + Number(v.importo), 0);
  const ricavi     = ricaviList.reduce((s, v) => s + Number(v.importo), 0);
  const utile      = ricavi - costi;

  if (voci.length > 0) {
    ctx += `\n\nEconomia:`;
    ctx += `\n- Costi registrati: ${fmtEur(costi)}`;
    ctx += `\n- Ricavi registrati: ${fmtEur(ricavi)}`;
    ctx += `\n- Utile attuale: ${fmtEur(utile)}`;
    if (site.budget_totale) {
      const budget   = Number(site.budget_totale);
      const spendPct = Math.round((costi / budget) * 100);
      ctx += `\n- Budget consumato: ${spendPct}%`;
      if (spendPct > (site.sal_percentuale ?? 0) + 10) {
        ctx += ` ⚠️ RISCHIO SFORAMENTO`;
      }
    }
    const recenti = voci.slice(0, 6);
    if (recenti.length > 0) {
      ctx += `\nUltimi movimenti economici:`;
      recenti.forEach(v => {
        ctx += `\n  ${v.tipo === 'costo' ? 'Costo' : 'Ricavo'} ${fmtEur(v.importo)} — ${v.voce} [${v.categoria}]`;
      });
    }
  } else {
    ctx += `\n\nEconomia: nessun movimento registrato`;
  }

  // ── Note recenti ──
  if (notes.length > 0) {
    const urgent = notes.filter(n => n.urgency !== 'normale');
    const normal = notes.filter(n => n.urgency === 'normale');
    const sorted = [...urgent, ...normal].slice(0, 8);

    ctx += `\n\nNote cantiere recenti (${sorted.length} mostrate su ${notes.length} caricate):`;
    sorted.forEach(n => {
      const d   = new Date(n.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      const urg = n.urgency === 'critica' ? '[CRITICA] ' : n.urgency === 'alta' ? '[ALTA] ' : '';
      const txt = n.ai_summary || (n.content || '').slice(0, 100);
      ctx += `\n- ${d} ${urg}[${n.category}] ${txt}`;
    });

    if (ncTotal > 0) {
      const ncCrit = notes.filter(n => n.category === 'non_conformita' && n.urgency === 'critica').length;
      const ncAlte = notes.filter(n => n.category === 'non_conformita' && n.urgency === 'alta').length;
      ctx += `\n⚠️ ${ncTotal} non conformità totali nel cantiere`;
      if (ncCrit > 0) ctx += ` (di cui ${ncCrit} critiche)`;
      if (ncAlte > 0) ctx += ` (${ncAlte} alte)`;
    }
  } else {
    ctx += `\n\nNote cantiere: nessuna nota ancora`;
  }

  return ctx;
}

// ── Gestione conversazione ─────────────────────────────────────

async function getOrCreateConversation(companyId, userId, siteId, siteName) {
  const { data: existing } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .eq('context_type', 'cantiere')
    .eq('context_id', siteId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('chat_conversations')
    .insert({
      company_id:   companyId,
      user_id:      userId,
      title:        `Ladia — ${siteName}`,
      context_type: 'cantiere',
      context_id:   siteId,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[telegramLadia] create conversation error:', error.message);
    return null;
  }
  return created.id;
}

async function getHistory(conversationId) {
  const { data } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);

  return (data || []).reverse();
}

async function appendMessages(conversationId, userMsg, assistantMsg) {
  await supabase.from('chat_messages').insert([
    { conversation_id: conversationId, role: 'user',      content: userMsg },
    { conversation_id: conversationId, role: 'assistant', content: assistantMsg },
  ]);
}

// ── Chiamata Claude Sonnet con tool use ────────────────────────

async function callClaudeWithTools(systemPrompt, messages, toolCtx) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata');

  let currentMessages = [...messages];

  for (let iteration = 0; iteration < MAX_TOOL_LOOPS; iteration++) {
    const body = {
      model:      SONNET_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   currentMessages,
      tools:      LADIA_TOOL_DEFINITIONS,
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // Risposta testuale finale — nessun tool call
    if (data.stop_reason !== 'tool_use') {
      const textBlock = data.content?.find(b => b.type === 'text');
      return (textBlock?.text || '').trim();
    }

    // Tool call: esegui tutti i tool in parallelo
    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');

    // Aggiungi il messaggio dell'assistant con tutti i blocchi (incluso tool_use)
    currentMessages.push({ role: 'assistant', content: data.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async block => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     await executeTool(block.name, block.input || {}, toolCtx),
      }))
    );

    // Aggiungi i risultati come messaggio utente
    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Fallback: chiedi risposta finale senza tool (loop esaurito)
  const fallbackRes = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      SONNET_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   currentMessages,
    }),
  });

  const fallbackData = await fallbackRes.json();
  return (fallbackData?.content?.[0]?.text || '').trim();
}

// ── Entry point ────────────────────────────────────────────────

/**
 * Chiede a Ladia una risposta contestuale al cantiere.
 * @param {object} tuUser - riga telegram_users (company_id, user_id, telegram_first_name)
 * @param {string} siteId
 * @param {string} siteName
 * @param {string} userMessage
 * @returns {Promise<string>} risposta HTML per Telegram
 */
async function askLadia(tuUser, siteId, siteName, userMessage) {
  const [siteContext, convId] = await Promise.all([
    buildSiteContext(tuUser.company_id, siteId),
    getOrCreateConversation(tuUser.company_id, tuUser.user_id, siteId, siteName),
  ]);

  if (!convId) throw new Error('Impossibile creare la conversazione');

  const systemPrompt = buildSystemPrompt(siteContext);
  const history      = await getHistory(convId);

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Context per i tool (permette a Ladia di creare note/NC nel cantiere corretto)
  const toolCtx = {
    companyId:  tuUser.company_id,
    siteId,
    authorId:   tuUser.user_id,
    authorName: tuUser.telegram_first_name || tuUser.telegram_username || 'Ladia',
  };

  const reply = await callClaudeWithTools(systemPrompt, messages, toolCtx);

  appendMessages(convId, userMessage, reply).catch(err =>
    console.error('[telegramLadia] appendMessages error:', err.message)
  );

  return reply;
}

/**
 * Azzera la cronologia Ladia per un cantiere specifico.
 */
async function resetLadiaHistory(companyId, userId, siteId) {
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .eq('context_type', 'cantiere')
    .eq('context_id', siteId)
    .maybeSingle();

  if (conv?.id) {
    await supabase.from('chat_messages').delete().eq('conversation_id', conv.id);
  }
}

// ── Versione coordinatore (focus sicurezza e compliance) ───────

function coordUserId(chatId) {
  const hex = Math.abs(Number(chatId)).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function buildCoordinatorSystemPrompt(siteContext) {
  const now = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });

  return `Sei Ladia, l'assistente AI di Palladia Pro per coordinatori della sicurezza.
Sei concisa, precisa, normativa. Rispondi sempre in italiano.
Usa formattazione Telegram HTML: <b>grassetto</b>, <i>corsivo</i>, <code>codice</code>.
Risposte brevi (max 350 parole) salvo richiesta esplicita di dettagli.

Sei esperta di:
- D.Lgs. 81/2008 e s.m.i. — articoli specifici, obblighi, sanzioni
- PSC (Piano di Sicurezza e Coordinamento) — contenuti, aggiornamenti
- POS (Piano Operativo di Sicurezza) — verifica imprese
- DVR — contenuti e obblighi del datore di lavoro
- DPI: norme EN, scelta, manutenzione, sostituzione
- Verifiche idoneità tecnico-professionale (DURC, DUVRI, patente a crediti)
- Procedure di emergenza, primo soccorso, antincendio in cantiere
- Visite ispettive ASL/ITL — documentazione richiesta
- Formazione obbligatoria lavoratori, preposti, dirigenti (Accordo Stato-Regioni)
- Norme sui ponteggi (D.Lgs. 81 Titolo IV, UNI EN 12811), scavi, demolizioni
- Idoneità sanitaria (art. 41 D.Lgs. 81) — frequenza visite, sorveglianza sanitaria

Data attuale: ${now}

━━━ CANTIERE IN ANALISI ━━━
${siteContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━

Comportamento:
- Sei il consulente di sicurezza del coordinatore, non il gestore economico
- Per domande su budget/costi rispondi brevemente che non è il tuo dominio
- Cita sempre l'articolo di legge pertinente quando è rilevante
- Segnala proattivamente rischi di non conformità evidenti dal contesto
- Tono professionale, da collega esperto CSE/CSP`;
}

async function buildCoordinatorSiteContext(siteId) {
  const [siteRes, ncsRes, wwRes] = await Promise.all([
    supabase.from('sites')
      .select('name, address, status, sal_percentuale, descrizione')
      .eq('id', siteId)
      .maybeSingle(),

    supabase.from('site_coordinator_notes')
      .select('note_type, content, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(8),

    supabase.from('worksite_workers')
      .select('worker_id')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .limit(30),
  ]);

  const site  = siteRes.data;
  const notes = ncsRes.data || [];
  const wws   = wwRes.data  || [];

  if (!site) return 'Dati cantiere non disponibili.';

  const workerIds = wws.map(ww => ww.worker_id).filter(Boolean);
  let workers = [];
  if (workerIds.length > 0) {
    const { data: workerData } = await supabase
      .from('workers')
      .select('full_name, qualification, safety_training_expiry, health_fitness_expiry')
      .in('id', workerIds);
    workers = workerData || [];
  }

  let ctx = `Nome: ${site.name || 'N/D'}
Indirizzo: ${site.address || 'N/D'}
Stato: ${site.status || 'N/D'}
Avanzamento SAL: ${site.sal_percentuale ?? 0}%`;

  if (site.descrizione) ctx += `\nDescrizione: ${site.descrizione}`;
  if (workers.length > 0) {
    ctx += `\n\nLavoratori in cantiere (${workers.length}):`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    workers.forEach(w => {
      let line = `\n- ${w.full_name}`;
      if (w.qualification) line += ` (${w.qualification})`;
      const trainDays = w.safety_training_expiry
        ? Math.round((new Date(w.safety_training_expiry) - today) / 86_400_000) : null;
      const fitDays   = w.health_fitness_expiry
        ? Math.round((new Date(w.health_fitness_expiry)  - today) / 86_400_000) : null;
      if (trainDays !== null && trainDays <= 30) line += ` ⚠️ formazione scade tra ${trainDays}gg`;
      if (fitDays   !== null && fitDays   <= 30) line += ` ⚠️ idoneità scade tra ${fitDays}gg`;
      ctx += line;
    });
  }

  if (notes.length > 0) {
    ctx += `\n\nNote coordinatore recenti:`;
    notes.forEach(n => {
      const d    = new Date(n.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      const type = n.note_type === 'warning' ? '⚠️' : '📋';
      ctx += `\n- ${d} ${type} ${(n.content || '').slice(0, 100)}`;
    });
  }

  return ctx;
}

async function askLadiaCoordinator(tuCoord, siteId, siteName, userMessage) {
  const { data: site } = await supabase
    .from('sites').select('company_id').eq('id', siteId).maybeSingle();
  const companyId = site?.company_id || '00000000-0000-0000-0000-000000000000';
  const userId    = coordUserId(tuCoord.telegram_chat_id);

  const [siteContext, convId] = await Promise.all([
    buildCoordinatorSiteContext(siteId),
    getOrCreateConversation(companyId, userId, siteId, `[CSE] ${siteName}`),
  ]);

  if (!convId) throw new Error('Impossibile creare la conversazione');

  const systemPrompt = buildCoordinatorSystemPrompt(siteContext);
  const history      = await getHistory(convId);
  const messages     = [...history, { role: 'user', content: userMessage }];

  // Coordinator usa callClaude senza tool (solo Q&A normativa)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      SONNET_MODEL,
      max_tokens: 1200,
      system:     systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data  = await res.json();
  const reply = (data?.content?.[0]?.text || '').trim();

  appendMessages(convId, userMessage, reply).catch(err =>
    console.error('[telegramLadia] coordinator appendMessages error:', err.message)
  );

  return reply;
}

module.exports = { askLadia, askLadiaCoordinator, resetLadiaHistory, coordUserId };
