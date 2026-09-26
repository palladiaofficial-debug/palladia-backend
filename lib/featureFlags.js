'use strict';
const supabase = require('./supabase');

/**
 * Feature flags — logica a tre livelli (priorità decrescente):
 *   1. MASTER_COMPANY_IDS env (comma-separated) → tutti i flag ON, TRANNE quelli
 *      in FROZEN_FEATURES (vedi sotto) — per quelli anche la master company
 *      passa dalla normale risoluzione DB-override/default.
 *   2. company_feature_flags table (override per-company dal DB)
 *   3. Variabili d'ambiente globali FEATURE_<NAME>_DEFAULT (true/false)
 *
 * Estratto da routes/v1/featureFlags.js per essere riusabile anche come guardia
 * server-side sugli endpoint di generazione (dvr/pimus), non solo dalla route
 * GET che il frontend legge per nascondere/mostrare i bottoni in UI.
 */

const FEATURES = {
  computo:                   process.env.FEATURE_COMPUTO_DEFAULT                    !== 'false',
  capitolato:                process.env.FEATURE_CAPITOLATO_DEFAULT                 !== 'false',
  // dvr/pimus: troppo delicati per essere generati dall'AI/offerti ai clienti in
  // questa fase — OFF di default finché non si decide di riattivarli.
  dvr:                       process.env.FEATURE_DVR_DEFAULT                        === 'true',
  pimus:                     process.env.FEATURE_PIMUS_DEFAULT                      === 'true',
  subcontractors_enterprise: process.env.FEATURE_SUBCONTRACTORS_ENTERPRISE_DEFAULT  !== 'false',
  // document_archive_* (6), document_hub_entry_* (6) e worker/subcontractor/
  // equipment_page_v1 RITIRATI (AUDIT.md F-229, 2026-09-24): rollout concluso,
  // accesi per tutti via env da agosto — l'archivio unificato, gli ingressi
  // verso /documenti e le pagine proprie di lavoratore/subappaltatore/mezzo
  // sono ora l'unico comportamento, senza flag e senza i vecchi modali dietro.
  // F-106 (AUDIT.md, 2026-09-01) → RISOLTO 2026-09-14: era sospeso perché il
  // wizard istruiva un inoltro AUTOMATICO su tutti i messaggi in arrivo — un
  // cliente l'ha impostato sulla casella principale e ha smesso di ricevere
  // ogni email per giorni. Causa profonda ora rimossa, non solo contenuta:
  // lib/emailIngestProviders.js non contiene più nessuna istruzione di
  // regola/filtro automatico, solo un inoltro MANUALE messaggio per messaggio
  // (stesso gesto già usato oggi per girare una fattura via WhatsApp) — non
  // può mai deviare il resto della posta per costruzione, quindi riattivato
  // di default. Resta un flag (non rimosso) per poter disattivare per una
  // singola company via company_feature_flags se mai servisse.
  email_ingest_manual_forward_setup: process.env.FEATURE_EMAIL_INGEST_MANUAL_FORWARD_SETUP_DEFAULT !== 'false',
  // Coordinatore della Sicurezza (CSE) — messo in standby il 2026-09-20 su
  // decisione esplicita del titolare: priorità sulla parte economica/DDT,
  // nessun CSE esterno reale ne fa uso oggi (verificato sul DB prima di
  // disattivarlo: i soli 2 inviti non-test esistenti appartengono alla
  // company QA/master, non a un cliente). Codice/route restano intatti e
  // testati — stesso trattamento "non ora, non mai buttato via" di dvr/pimus.
  coordinator_cse: process.env.FEATURE_COORDINATOR_CSE_DEFAULT === 'true',
  // F-229 (AUDIT.md, 2026-09-24) — Inventario Palladia: moduli CONGELATI su
  // decisione del titolare, voce per voce, dopo aver misurato l'uso reale nel
  // DB (zero o quasi per tutti). "Congelato" = sparisce dall'app (menu, rotte,
  // tool di Ladia, cron) ma il codice resta: si riattiva con
  // FEATURE_<NOME>_DEFAULT=true su Railway, oppure per una sola company con
  // una riga in company_feature_flags. Tutti anche in FROZEN_FEATURES qui
  // sotto: la master company di QA non li vede accesi per sbaglio.
  economia:                process.env.FEATURE_ECONOMIA_DEFAULT                === 'true',
  subappaltatori:          process.env.FEATURE_SUBAPPALTATORI_DEFAULT          === 'true',
  studio_cdl:              process.env.FEATURE_STUDIO_CDL_DEFAULT              === 'true',
  consulente:              process.env.FEATURE_CONSULENTE_DEFAULT              === 'true',
  formazione_marketplace:  process.env.FEATURE_FORMAZIONE_MARKETPLACE_DEFAULT  === 'true',
  worker_self_onboarding:  process.env.FEATURE_WORKER_SELF_ONBOARDING_DEFAULT  === 'true',
  share_target:            process.env.FEATURE_SHARE_TARGET_DEFAULT            === 'true',
  site_checklist:          process.env.FEATURE_SITE_CHECKLIST_DEFAULT          === 'true',
  ladia_memory:            process.env.FEATURE_LADIA_MEMORY_DEFAULT            === 'true',
  ladia_chat_folders:      process.env.FEATURE_LADIA_CHAT_FOLDERS_DEFAULT      === 'true',
  ladia_proactive:         process.env.FEATURE_LADIA_PROACTIVE_DEFAULT         === 'true',
  subappalto_contract:     process.env.FEATURE_SUBAPPALTO_CONTRACT_DEFAULT     === 'true',
  pos_signatures:          process.env.FEATURE_POS_SIGNATURES_DEFAULT          === 'true',
  ladia_safety_tools:      process.env.FEATURE_LADIA_SAFETY_TOOLS_DEFAULT      === 'true',
  note_reminders:          process.env.FEATURE_NOTE_REMINDERS_DEFAULT          === 'true',
  daily_digests:           process.env.FEATURE_DAILY_DIGESTS_DEFAULT           === 'true',
  demo_page:               process.env.FEATURE_DEMO_PAGE_DEFAULT               === 'true',
  // F-240 (Le quattro porte, passo 4): riepilogo unico delle 7:30 al posto dei
  // messaggi dei singoli automatismi del mattino (lib/alertDigest.js). Si
  // accende con FEATURE_ALERT_DIGEST_DEFAULT=true, o per una company in
  // company_feature_flags. Spegnendolo tornano subito i messaggi di prima.
  alert_digest:            process.env.FEATURE_ALERT_DIGEST_DEFAULT            === 'true',
};

// Feature che restano disattivate anche per la master company — niente
// eccezioni, nemmeno per test interni, finché non si decide di riattivarle.
// email_ingest_manual_forward_setup rimosso da qui il 2026-09-14 (F-106
// risolto, non solo contenuto — vedi commento sopra in FEATURES).
const FROZEN_FEATURES = new Set([
  'dvr', 'pimus', 'coordinator_cse',
  // F-229 — Inventario Palladia (vedi sopra)
  'subappaltatori', 'economia', 'studio_cdl', 'consulente', 'formazione_marketplace',
  'worker_self_onboarding', 'share_target', 'site_checklist',
  'ladia_memory', 'ladia_chat_folders', 'ladia_proactive',
  'subappalto_contract', 'pos_signatures', 'ladia_safety_tools', 'note_reminders',
  'daily_digests', 'demo_page',
  // Non è un modulo congelato: sta qui solo perché la master company non lo
  // accenda da sola. Il riepilogo cambia i messaggi che arrivano al titolare,
  // quindi si accende solo con una scelta esplicita (env o riga per company).
  'alert_digest',
]);

/**
 * Stato GLOBALE di un modulo congelato (non per-company) — per i cron e per
 * le decisioni prese una volta al boot (es. l'elenco dei tool di Ladia), dove
 * non c'è una company a cui chiedere. Vero solo se il default d'ambiente lo
 * riaccende esplicitamente.
 */
function isModuleEnabledGlobally(featureName) {
  return FEATURES[featureName] === true;
}

const MASTER_IDS = new Set(
  (process.env.MASTER_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

async function isFeatureEnabled(companyId, featureName) {
  if (!(featureName in FEATURES)) return false;
  if (MASTER_IDS.has(companyId) && !FROZEN_FEATURES.has(featureName)) return true;

  const { data } = await supabase
    .from('company_feature_flags')
    .select('enabled')
    .eq('company_id', companyId)
    .eq('feature', featureName)
    .maybeSingle();

  return data ? data.enabled : FEATURES[featureName];
}

module.exports = { FEATURES, FROZEN_FEATURES, MASTER_IDS, isFeatureEnabled, isModuleEnabledGlobally };
