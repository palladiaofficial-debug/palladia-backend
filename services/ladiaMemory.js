'use strict';
/**
 * services/ladiaMemory.js
 *
 * Memoria persistente di Ladia:
 *  - getMemory()                      → restituisce contesto per il system prompt
 *  - updateMemoryAfterConversation()  → estrae fatti dalla conversazione e li salva (asincrono, non bloccante)
 *  - analyzeDiaryNote()               → analizza nota diario e crea notifica se trova aggiornamenti candidati
 */

const supabase  = require('../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-haiku-4-5-20251001'; // modello leggero: bassa latenza, basso costo

// ── Leggi memoria (lato system prompt) ───────────────────────────────────────
async function getMemory(companyId, { siteId, userId } = {}) {
  const parts = [];

  if (siteId) {
    const { data } = await supabase
      .from('ladia_memory')
      .select('content, updated_at')
      .eq('company_id', companyId)
      .eq('entity_type', 'site')
      .eq('entity_id', siteId)
      .maybeSingle();
    if (data?.content) {
      const date = new Date(data.updated_at).toLocaleDateString('it-IT');
      parts.push(`[Memoria cantiere — aggiornata il ${date}]\n${data.content}`);
    }
  }

  if (userId) {
    const { data } = await supabase
      .from('ladia_memory')
      .select('content')
      .eq('company_id', companyId)
      .eq('entity_type', 'user')
      .eq('entity_id', userId)
      .maybeSingle();
    if (data?.content) {
      parts.push(`[Profilo utente]\n${data.content}`);
    }
  }

  return parts.join('\n\n');
}

// ── Aggiorna memoria del cantiere dopo conversazione ─────────────────────────
async function updateMemoryAfterConversation(companyId, { siteId, userId }, messages) {
  // Prendi solo le ultime 12 coppie per limitare i token
  const recent = messages.slice(-12);
  const transcript = recent
    .map(m => {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
          : '';
      return `${m.role === 'user' ? 'Utente' : 'Ladia'}: ${text.slice(0, 500)}`;
    })
    .filter(s => s.length > 10)
    .join('\n');

  if (!transcript) return;

  await Promise.allSettled([
    siteId  ? _updateSiteMemory(companyId, siteId, transcript)  : Promise.resolve(),
    userId  ? _updateUserMemory(companyId, userId, transcript)  : Promise.resolve(),
  ]);
}

async function _updateSiteMemory(companyId, siteId, transcript) {
  const { data: existing } = await supabase
    .from('ladia_memory')
    .select('content')
    .eq('company_id', companyId)
    .eq('entity_type', 'site')
    .eq('entity_id', siteId)
    .maybeSingle();

  const prompt = `Sei il sistema di memoria di Ladia, assistente per la gestione cantieri edili.

Memoria attuale del cantiere:
${existing?.content || '(vuota)'}

Conversazione appena conclusa:
${transcript}

Aggiorna la memoria del cantiere estraendo SOLO fatti concreti e verificati emersi dalla conversazione: date, nomi, importi, stati, problemi ricorrenti, subappaltatori, referenti, scadenze. Mantieni i fatti precedenti non smentiti. Rimuovi informazioni superate. Formato: elenco puntato in italiano, massimo 15 voci, tono neutro e sintetico. Se non emergono fatti nuovi, riscrivi la memoria attuale invariata.`;

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = res.content[0]?.text?.trim();
  if (!content) return;

  await supabase.from('ladia_memory').upsert({
    company_id: companyId, entity_type: 'site', entity_id: siteId,
    content, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id' });
}

async function _updateUserMemory(companyId, userId, transcript) {
  const { data: existing } = await supabase
    .from('ladia_memory')
    .select('content')
    .eq('company_id', companyId)
    .eq('entity_type', 'user')
    .eq('entity_id', userId)
    .maybeSingle();

  const prompt = `Sei il sistema di memoria di Ladia, assistente per la gestione cantieri edili.

Profilo attuale dell'utente:
${existing?.content || '(vuoto)'}

Conversazione:
${transcript}

Aggiorna il profilo dell'utente con preferenze, stile comunicativo, competenze tecniche, termini specifici che usa, come preferisce ricevere le risposte. Ignora contenuto irrilevante per il profilo. Formato: elenco puntato in italiano, massimo 8 voci.`;

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 250,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = res.content[0]?.text?.trim();
  if (!content) return;

  await supabase.from('ladia_memory').upsert({
    company_id: companyId, entity_type: 'user', entity_id: userId,
    content, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id' });
}

// ── Analizza nota diario — propone aggiornamenti al cantiere ─────────────────
async function analyzeDiaryNote(companyId, siteId, noteContent, siteData) {
  if (!noteContent || noteContent.length < 15) return;

  const siteCtx = siteData
    ? `Cantiere "${siteData.name}" — inizio: ${siteData.start_date || '?'}, fine contratto: ${siteData.end_date || '?'}, committente: ${siteData.client || '?'}`
    : '';

  const prompt = `Analizza questa nota di cantiere e determina se contiene informazioni che potrebbero aggiornare i dati strutturati del cantiere.

${siteCtx}

Nota: "${noteContent}"

Rispondi ESCLUSIVAMENTE con JSON valido (zero testo fuori dal JSON):
{"aggiornamenti":[{"campo":"end_date","valore":"2026-09-15","confidenza":0.9,"motivo":"Il tecnico ha indicato una nuova data di fine"}]}

Campi aggiornabili:
- end_date: nuova data fine lavori (formato YYYY-MM-DD)
- start_date: nuova data inizio (formato YYYY-MM-DD)
- client: nome committente/cliente

Regole:
- Includi solo aggiornamenti con confidenza >= 0.75
- Se la nota non contiene aggiornamenti certi, rispondi: {"aggiornamenti":[]}
- Non inventare informazioni non presenti nella nota`;

  try {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw  = res.content[0]?.text?.trim() ?? '';
    const text = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const json = JSON.parse(text);
    if (!json.aggiornamenti?.length) return;

    const buoni = json.aggiornamenti.filter(u => u.confidenza >= 0.75);
    if (!buoni.length) return;

    const campiLabel = { end_date: 'data fine lavori', start_date: 'data inizio', client: 'committente' };
    const descrizione = buoni.map(u => `${campiLabel[u.campo] || u.campo}: ${u.valore}`).join(', ');

    await supabase.from('notifications').upsert({
      company_id:  companyId,
      type:        'ladia_suggestion',
      severity:    'info',
      title:       'Ladia ha rilevato un possibile aggiornamento',
      body:        `Dal diario: "${noteContent.slice(0, 100)}${noteContent.length > 100 ? '…' : ''}"\n→ Aggiornamento suggerito: ${descrizione}`,
      entity_type: 'site',
      entity_id:   siteId,
      metadata:    { aggiornamenti: buoni, nota: noteContent.slice(0, 300) },
      updated_at:  new Date().toISOString(),
    }, { onConflict: 'company_id,entity_type,entity_id,type' });

    console.log(`[ladiaMemory] nota analizzata — ${buoni.length} aggiornamento/i suggerito/i per cantiere ${siteId}`);
  } catch (err) {
    // Errore di parsing JSON o API — non blocca il salvataggio della nota
    if (err instanceof SyntaxError) return;
    console.error('[ladiaMemory] analyzeDiaryNote:', err.message);
  }
}

module.exports = { getMemory, updateMemoryAfterConversation, analyzeDiaryNote };
