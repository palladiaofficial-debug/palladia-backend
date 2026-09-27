'use strict';
/**
 * lib/ladiaFrozenTools.js — F-229 (AUDIT.md, 2026-09-24), Inventario Palladia.
 *
 * Quali tool e quali tabelle Ladia NON può più usare, perché il modulo a cui
 * appartengono è stato ELIMINATO o CONGELATO su decisione del titolare dopo
 * aver misurato l'uso reale (zero o quasi per tutti).
 *
 * Vive fuori da routes/v1/chat.js per la regola "chat.js è congelato"
 * (CLAUDE.md): chat.js si limita a filtrare TOOLS e ad accodare
 * frozenModulesPromptNote() al prompt statico. I gestori dei tool tolti restano
 * in chat.js come codice irraggiungibile (il modello non può chiamare un tool
 * che non riceve nello schema) fino allo smontaggio post-lancio del file.
 *
 * Tutto è deciso UNA volta al boot (TOOLS_CACHED e SYSTEM_PROMPT sono statici
 * per la prompt cache): riaccendere un modulo congelato = impostare
 * FEATURE_<NOME>_DEFAULT=true su Railway e riavviare il servizio.
 */
const { isModuleEnabledGlobally } = require('./featureFlags');

// Moduli ELIMINATI — i loro tool non tornano con nessun flag.
const ELIMINATED_TOOLS = new Set([
  // Safety Copilot (punteggio di rischio + scudo ispezione)
  'get_risk_score', 'get_inspection_shield',
  // Non conformità (0 aperte in 4 mesi; restano solo lato CSE, congelato) —
  // le ultime due sono le gemelle di Ladia via Telegram (services/ladiaTools.js)
  'get_nonconformities', 'resolve_nonconformity', 'lista_nc_aperte', 'crea_non_conformita',
  // Fasi di "Ladia In Cantiere" (UI mai collegata, 0 configurazioni)
  'get_site_phases', 'create_phase', 'update_phase',
]);

// Moduli CONGELATI — tool per modulo (nome del flag in lib/featureFlags.js).
const FROZEN_TOOLS_BY_MODULE = {
  economia: [
    'get_economia', 'search_prezzario', 'get_company_prezzi', 'get_expenses_summary',
    'create_expense', 'get_sal_history', 'get_computo_voci', 'get_site_costs',
    'get_capitolato_voci', 'update_sal', 'create_economia_voce', 'update_economia_voce',
    'delete_economia_voce', 'update_sal_voce', 'update_prezzo_voce', 'emit_sal',
    'mark_sal_pagato', 'create_computo_voce', 'delete_computo_voce',
    'update_budget_cantiere', 'get_varianti', 'create_variante', 'update_variante',
    'create_site_cost', 'create_expense_from_image', 'create_ddt_from_image',
  ],
  subappaltatori: [
    'get_subcontractors', 'get_subcontractor_documents',
    'create_subcontractor', 'assign_subcontractor_to_site',
  ],
  coordinator_cse: ['get_coordinator_notes', 'get_coordinator_nonconformities'],
  ladia_safety_tools: ['get_pos_draft', 'generate_pos_risks', 'get_pos_defaults', 'search_lavorazioni'],
  formazione_marketplace: ['get_site_bookings'],
  subappalto_contract: ['draft_subappalto_contract'],
};

// Tabelle scrivibili dai tool generici (create_record/update_record/
// delete_record) che appartengono agli stessi moduli. Il registro
// (lib/ladiaSchemaRegistry.js) NON viene toccato: l'annullamento di
// un'azione già fatta in passato deve continuare a trovare la risorsa.
const ELIMINATED_RESOURCES = new Set(['site_phases']);
const FROZEN_RESOURCES_BY_MODULE = {
  economia: ['site_economia_voci', 'site_computo_voci', 'site_sal_history', 'site_costs', 'company_expenses', 'site_computo'],
  subappaltatori: ['subcontractors', 'site_subcontractors', 'subcontractor_documents'],
  formazione_marketplace: ['site_bookings'],
  ladia_safety_tools: ['pos_drafts'],
};

const MODULE_LABELS = {
  economia: 'Economia (costi, spese, SAL, computo, capitolato, varianti, prezzario, preventivi, DDT e fatture registrati come costo)',
  subappaltatori: 'Subappaltatori (anagrafica, documenti, assegnazione ai cantieri)',
  coordinator_cse: 'Coordinatore della sicurezza (CSE): note e non conformità del coordinatore',
  ladia_safety_tools: 'Compilazione del POS dentro la chat (il generatore POS resta nella pagina "Genera POS")',
  formazione_marketplace: 'Prenotazione corsi di formazione',
  subappalto_contract: 'Generazione del contratto di subappalto',
};

function disabledModules() {
  return Object.keys(FROZEN_TOOLS_BY_MODULE).filter(m => !isModuleEnabledGlobally(m));
}

function blockedToolNames() {
  const out = new Set(ELIMINATED_TOOLS);
  for (const m of disabledModules()) for (const t of FROZEN_TOOLS_BY_MODULE[m]) out.add(t);
  return out;
}

function blockedResourceNames() {
  const out = new Set(ELIMINATED_RESOURCES);
  for (const [m, tables] of Object.entries(FROZEN_RESOURCES_BY_MODULE)) {
    if (!isModuleEnabledGlobally(m)) for (const t of tables) out.add(t);
  }
  return out;
}

/** TOOLS filtrati: nessun tool di un modulo eliminato o congelato. */
function filterFrozenTools(tools) {
  const blocked = blockedToolNames();
  return tools.filter(t => !blocked.has(t.name));
}

/** true se create/update/delete_record su questa tabella va rifiutato. */
function isResourceFrozen(resourceName) {
  return blockedResourceNames().has(resourceName);
}

// Pagine del frontend che seguono un modulo congelato (FeatureGate → 404 in
// palladia/src/App.tsx): Ladia non deve mai aprirle da sola.
const FROZEN_PATHS_BY_MODULE = {
  economia: [/^\/economia(\/|\?|$)/, /^\/prezzario(\/|\?|$)/, /^\/cantieri\/[^/]+\/economia(\/|\?|$)/],
  subappaltatori: [/^\/subappaltatori\//],
};

/** true se Ladia non deve navigare verso questo path (modulo congelato). */
function isPathFrozen(path) {
  return Object.entries(FROZEN_PATHS_BY_MODULE).some(([m, res]) =>
    !isModuleEnabledGlobally(m) && res.some(re => re.test(String(path || ''))));
}

/**
 * Nota accodata al prompt statico. Il prompt di chat.js nomina ancora questi
 * tool in più punti (mappa dei tool, flussi POS/contratto/ricevute): questa
 * nota, essendo in coda, dice al modello di ignorarli e cosa fare invece.
 */
/**
 * F-245 (costo di Ladia): nel SYSTEM_PROMPT (chat.js) le sezioni che servono
 * a un solo modulo sono racchiuse tra ⟦modulo:NOME⟧ … ⟦/modulo:NOME⟧. Se il
 * modulo è spento la sezione viene tolta, se è acceso restano solo i marcatori
 * a sparire. Calcolato una volta all'avvio, come ACTIVE_TOOLS: il prompt resta
 * identico tra una richiesta e l'altra, quindi la cache non si rompe. Prima le
 * istruzioni di POS in chat, contratto di subappalto, economia ecc. venivano
 * rilette (e pagate) a ogni chiamata anche con i loro tool spenti.
 */
function stripDisabledPromptSections(text) {
  return String(text).replace(/⟦modulo:([a-z_]+)⟧\r?\n?([\s\S]*?)⟦\/modulo:\1⟧\r?\n?/g,
    (_, mod, body) => (isModuleEnabledGlobally(mod) ? body : ''));
}

function frozenModulesPromptNote() {
  const off = disabledModules();
  const lines = [
    '',
    '',
    '═══ FUNZIONI NON ATTIVE IN QUESTA VERSIONE — HA PRIORITÀ SU TUTTO QUANTO SOPRA ═══',
    'Alcune istruzioni più sopra citano tool o flussi che OGGI NON ESISTONO: non li hai nello',
    'schema dei tool e non devi provare a usarli, né a simularli, né a promettere che lo farai.',
    '- Rischio del cantiere / scudo ispezione (Safety Copilot), non conformità e fasi di lavoro: eliminati.',
    "- DVR e PIMUS: eliminati. Se l'utente li chiede, di' che in Palladia la generazione di DVR e PIMUS",
    '  non è disponibile — senza promettere percorsi alternativi. Leggere o cercare un DVR/PIMUS già',
    '  caricato tra i documenti resta possibile.',
    ...off.map(m => `- ${MODULE_LABELS[m]}: non attiva.`),
    'Se l\'utente chiede una di queste cose, digli in UNA frase che in Palladia oggi quella',
    'funzione non è attiva, e se esiste offrigli la cosa più vicina che puoi fare davvero.',
    ...(off.includes('economia') ? [
      'FOTO O PDF DI UNA FATTURA, SCONTRINO, RICEVUTA O DDT: non registrarla come costo o spesa.',
      'Trattala come qualunque altro documento — read_uploaded_document e poi archive_document —',
      'e dillo chiaramente: "l\'ho archiviata tra i documenti; il controllo dei costi non è attivo".',
    ] : []),
  ];
  return lines.join('\n');
}

module.exports = {
  stripDisabledPromptSections,
  ELIMINATED_TOOLS, FROZEN_TOOLS_BY_MODULE, ELIMINATED_RESOURCES, FROZEN_RESOURCES_BY_MODULE,
  filterFrozenTools, isResourceFrozen, isPathFrozen, frozenModulesPromptNote, blockedToolNames,
};
