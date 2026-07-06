'use strict';
/**
 * services/posRisksGenerator.js
 * Prompt per la Sezione 5 del POS ("Lavorazioni, Rischi e Misure") — l'UNICA
 * sezione del documento generata realmente dall'AI (le altre 13 sono
 * template statici interpolati da dati form, vedi pos-template.js).
 *
 * Estratta da server.js (era locale, usata solo dai 2 endpoint POS-template)
 * così può essere richiamata anche dal tool bespoke generate_pos_risks in
 * routes/v1/chat.js — funzione pura, nessun side-effect, nessuna chiamata AI
 * qui dentro (quella resta separata: server.js usa callAnthropicHaiku,
 * chat.js usa l'SDK Anthropic già configurato lì).
 */

function buildRisksPrompt(posData) {
  const works = posData.selectedWorks?.join('\n- ') || 'Da definire';
  return `Sei un Coordinatore per la Sicurezza esperto. Genera SOLO la sezione "Lavorazioni e Rischi" di un POS per le seguenti lavorazioni di cantiere.

CANTIERE: ${posData.siteAddress || 'N/A'}
NATURA LAVORI: ${posData.workType || 'N/A'}

LAVORAZIONI PREVISTE:
- ${works}

Per OGNI lavorazione genera:

### [Nome Lavorazione]

**Descrizione tecnica:** descrizione dettagliata della lavorazione e delle fasi operative.

**Rischi identificati e valutazione (matrice P x D):**

| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |
|---------|---------|---------|---------|---------|
(elenca tutti i rischi con probabilita', danno, indice di rischio e livello: Basso/Medio/Alto/Molto Alto)

Legenda: P=Probabilita' (1=Improbabile, 2=Poco probabile, 3=Probabile, 4=Molto probabile), D=Danno (1=Lieve, 2=Medio, 3=Grave, 4=Molto grave), R=PxD

**Misure di prevenzione e protezione:**
- (elenco dettagliato misure specifiche)

**DPI obbligatori:**
| DPI | Norma UNI EN | Note |
|-----|-------------|------|
(tabella DPI specifici con norme di riferimento)

**Attrezzature e verifiche:**
| Attrezzatura | Verifica richiesta | Frequenza |
|-------------|-------------------|-----------|
(tabella attrezzature con verifiche)

---

Rispondi SOLO con il contenuto delle lavorazioni, senza intestazioni di sezione o preamboli. Sii tecnico, preciso e conforme al D.lgs 81/2008.`;
}

module.exports = { buildRisksPrompt };
