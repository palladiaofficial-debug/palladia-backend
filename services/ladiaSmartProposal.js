'use strict';
/**
 * services/ladiaSmartProposal.js
 *
 * Genera proposte contestualizzate per gli alert proattivi di Ladia,
 * usando Claude Haiku per analizzare il contesto specifico invece di
 * mandare template generici.
 *
 * Il risultato è una stringa di 2-3 frasi (max 80 parole) che:
 *  1. Descrive la situazione con dati reali (età NC, % budget, nome lavoratore)
 *  2. Identifica il rischio principale
 *  3. Formula una proposta d'azione concreta
 *
 * Modello: claude-haiku-4-5-20251001 (veloce, <1s, costo trascurabile)
 * Fallback: se Claude fallisce → ritorna null → il chiamante usa il template
 *
 * Esportazioni:
 *  generateNcProposal(nc, siteName, ageLabel)
 *  generateBudgetProposal(siteName, spendPct, salPct, costiStr, budgetStr)
 */

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU_MODEL   = 'claude-haiku-4-5-20251001';
const MAX_TOKENS    = 120; // 80 parole ca. — breve e denso

/**
 * Chiama Claude Haiku con un prompt focalizzato.
 * Ritorna il testo generato oppure null in caso di errore.
 * Non lancia mai eccezioni verso il chiamante.
 */
async function callHaiku(prompt) {
  if (!ANTHROPIC_KEY) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':     'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      HAIKU_MODEL,
        max_tokens: MAX_TOKENS,
        system:
          'Sei Ladia, assistente AI per cantieri edili italiani. ' +
          'Rispondi SOLO con il testo della proposta, senza prefissi come "Proposta:" o "Ladia:". ' +
          'Usa formattazione Telegram HTML solo se strettamente necessario. ' +
          'Massimo 3 frasi, tono diretto e professionale.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const json = await res.json();
    const text = json?.content?.[0]?.text?.trim();
    return text || null;

  } catch {
    return null;
  }
}

// ── NC stale: proposta contestualizzata ───────────────────────

/**
 * Genera una proposta specifica per una NC non risolta da > 48h.
 *
 * Considera: urgency, età, testo NC, nome cantiere.
 * Output: 2-3 frasi che descrivono situazione + proposta concreta.
 *
 * @param {{ id, urgency, content, ai_summary, created_at }} nc
 * @param {string} siteName
 * @param {string} ageLabel  es. "2 giorni", "5 giorni"
 * @returns {Promise<string|null>}
 */
async function generateNcProposal(nc, siteName, ageLabel) {
  const ncText = (nc.ai_summary || nc.content || '').slice(0, 180);
  const urgLabel = nc.urgency === 'critica' ? 'CRITICA' : 'ALTA';

  const prompt =
    `NC ${urgLabel} su cantiere "${siteName}" aperta da ${ageLabel}:\n` +
    `"${ncText}"\n\n` +
    `In 2 frasi: spiega la situazione con i dati reali e proponi UN'azione concreta ` +
    `(chiudere, scalare, diffida, sopralluogo, ecc.). ` +
    `Sii specifico, non generico. Termina con la proposta.`;

  return callHaiku(prompt);
}

// ── Budget alert: proposta contestualizzata ───────────────────

/**
 * Genera una proposta specifica per un alert di sforamento budget.
 *
 * Considera: % consumata, SAL, importi reali.
 * Output: diagnosi del rischio + azione concreta raccomandata.
 *
 * @param {string} siteName
 * @param {number} spendPct    % budget consumato (es. 92)
 * @param {number} salPct      SAL % (es. 58)
 * @param {string} costiStr    es. "€ 184.000"
 * @param {string} budgetStr   es. "€ 200.000"
 * @returns {Promise<string|null>}
 */
async function generateBudgetProposal(siteName, spendPct, salPct, costiStr, budgetStr) {
  const gap = spendPct - salPct; // quanto i costi superano l'avanzamento lavori

  const prompt =
    `Cantiere "${siteName}": budget consumato ${spendPct}% (${costiStr} su ${budgetStr}), ` +
    `SAL ${salPct}% — gap costi/avanzamento: ${gap > 0 ? '+' : ''}${gap} punti.\n\n` +
    `In 2 frasi: identifica il rischio principale (es. margine a rischio, eccesso manodopera, ecc.) ` +
    `e proponi UN'azione concreta e realistica. Usa i numeri reali.`;

  return callHaiku(prompt);
}

module.exports = { generateNcProposal, generateBudgetProposal };
