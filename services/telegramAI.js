'use strict';
/**
 * services/telegramAI.js
 * Classificazione AI dei messaggi Telegram via Claude Haiku (veloce, economico).
 * Ritorna categoria, riepilogo breve, urgenza.
 */

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sei un assistente che analizza messaggi di tecnici di cantiere.
Rispondi SEMPRE e SOLO con un oggetto JSON valido, senza markdown, senza backtick.

Analizza il messaggio e restituisci:
{
  "category": "<una di: nota | foto | non_conformita | verbale | presenza | incidente | documento | altro>",
  "summary": "<riepilogo in 1-2 frasi, max 200 caratteri>",
  "urgency": "<normale | alta | critica>",
  "detected_workers": ["<nome>", ...],
  "keywords": ["<keyword>", ...]
}

Regole categoria:
- "non_conformita": problemi di sicurezza, irregolarità, violazioni, pericoli
- "incidente": infortuni, quasi-incidenti, mancati infortuni
- "presenza": elenco lavoratori presenti, timbrature, appelli
- "verbale": riunioni, sopralluoghi, visite ispettive
- "documento": riferimenti a documenti, certificati, DPI, attestati
- "foto": se il messaggio riguarda prevalentemente una foto (testo descrittivo di immagine)
- "nota": tutto il resto

Regole urgenza:
- "critica": incidente, infortunio, pericolo imminente, stop lavori
- "alta": non conformità di sicurezza, problema che richiede azione entro oggi
- "normale": tutto il resto`;

/**
 * Classifica un messaggio Telegram.
 * @param {string} text - testo del messaggio (o descrizione foto/doc)
 * @param {string} siteName - nome cantiere (per contesto)
 * @returns {Promise<{category,summary,urgency,detected_workers,keywords}>}
 */
async function classifyMessage(text, siteName = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback senza AI: categoria generica
    return { category: 'nota', summary: text?.slice(0, 200) || '', urgency: 'normale', detected_workers: [], keywords: [] };
  }

  const userMsg = siteName
    ? `[Cantiere: ${siteName}]\n\n${text}`
    : text;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!res.ok) {
      console.error('[telegramAI] Anthropic error:', res.status);
      return fallback(text);
    }

    const data = await res.json();
    const raw = data?.content?.[0]?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[telegramAI] JSON parse error, raw:', raw.slice(0, 100));
      return fallback(text);
    }

    return {
      category:         validCategory(parsed.category),
      summary:          (parsed.summary || text?.slice(0, 200) || '').slice(0, 300),
      urgency:          validUrgency(parsed.urgency),
      detected_workers: Array.isArray(parsed.detected_workers) ? parsed.detected_workers : [],
      keywords:         Array.isArray(parsed.keywords) ? parsed.keywords : [],
    };

  } catch (err) {
    console.error('[telegramAI] errore:', err.message);
    return fallback(text);
  }
}

function fallback(text) {
  return { category: 'nota', summary: text?.slice(0, 200) || '', urgency: 'normale', detected_workers: [], keywords: [] };
}

const VALID_CATEGORIES = ['nota','foto','non_conformita','verbale','presenza','incidente','documento','altro'];
const VALID_URGENCIES  = ['normale','alta','critica'];

function validCategory(v) { return VALID_CATEGORIES.includes(v) ? v : 'nota'; }
function validUrgency(v)  { return VALID_URGENCIES.includes(v)  ? v : 'normale'; }

module.exports = { classifyMessage };
