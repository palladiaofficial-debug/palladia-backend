'use strict';
const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const crypto    = require('crypto');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt }    = require('../../middleware/verifyJwt');
const { renderHtmlToPdf }      = require('../../pdf-renderer');
const { validate } = require('../../middleware/validate');
const { complianceStatus, overallStatus } = require('../../lib/compliance');
const { computeRiskScore, generateInspectionShield } = require('../../services/safetyCopilot');
const { getCompanyBrain } = require('../../lib/companyBrain');
const {
  chatMessageSchema,
  chatExportSchema,
  createConversationSchema,
  patchConversationTitleSchema,
} = require('../../lib/schemas/chat');

// Lazy init — evita crash al boot se ANTHROPIC_API_KEY non è configurata
let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Modelli ───────────────────────────────────────────────────────────────────
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';   // query dati, KPI, presenze
const MODEL_SONNET = 'claude-sonnet-4-6';            // normativa, sicurezza, analisi tecnica

// ── Classificatore query (zero costo API — keyword matching) ─────────────────
// Restituisce 'sonnet' se la query richiede ragionamento tecnico/normativo,
// altrimenti 'haiku' per query dati operative.
const SONNET_KEYWORDS = [
  // normativa
  'd.lgs','dlgs','decreto','normativ','legge','articolo','comma','allegato',
  'sanzione','multa','violazione','reato','penale','responsabilit',
  // sicurezza tecnica
  'dpi','dvr','psc','pos','piano','rischio','valutazione','misur',
  'ponteggio','trabattello','scala','lavori in quota','caduta','scavo','sbancamento',
  'demolizion','esplosiv','fuoco','incendio','atex','spazio confinato',
  'rumore','vibrazion','chimico','biologico','cancerogen','amianto',
  'rspp','rls','cse','csp','preposto','datore','medico competen','sorveglianza sanitaria',
  'formazione','corso','attestato','abilitazione','patente a punti',
  'primo soccorso','evacuazione','antincendio',
  // appalti / contratti
  'soa','qualificazion','categoria og','categoria os','ati','rti','subappalto',
  'durc','antimafia','white list','cam costruzioni',
  'ccnl','contratto collettivo','inquadramento','mansione','retribuzion','tfr',
  'sal','stato avanzamento','contabilità lavori','collaudo',
  'codice dei contratti','d.lgs 36','appalto pubblico',
  // analisi / consiglio
  'come si fa','cosa prevede','cosa dice','è obbligatorio','sono obbligato',
  'procedura','checklist','linee guida','best practice','consiglio','suggerisci',
  'spiega','spiegami','differenza','confronto','quando scade','frequenza',
  // fasi e cronoprogramma
  'fase','fasi','cronoprogramma',
  // computo e capitolato
  'computo','capitolato','metrico','voce','voci',
  // diario
  'diario','giornale',
  // meteo e sospensioni
  'sospensione','pioggia','meteo','tempo','neve','vento',
  // coordinatore
  'coordinatore','verbale',
  // NC e ispezioni
  'non conformità','nc','ispezione','asl',
  // costi e documenti
  'certificato','costi','fattura','fatture','ddt','acconto',
  // cedolini e buste paga
  'cedolino','cedolini','busta paga','buste paga',
  // prenotazioni e logistica
  'prenotazion','consegna','consegne','fornitura','forniture',
  // mezzi e attrezzature
  'escavatore','gru','autocarro','betoniera','mezzo','mezzi','attrezzatura','attrezzature',
];

const WRITE_KEYWORDS = [
  'registra','crea','aggiungi','inserisci','assegna','aggiorna','modifica',
  'cambia','segna','scrivi','annota','apri un cantiere','nuovo cantiere',
  'nuova fase','chiudi','sospendi','nuovo lavoratore','nuova spesa',
  'rimuovi','togli','disassegna','risolvi','nuovo sub','nuovo mezzo',
  'fattura','ddt','acconto','sposta','nuovo subappaltatore','nuova attrezzatura',
];

function classifyQuery(message) {
  const lower = message.toLowerCase();
  if (WRITE_KEYWORDS.some(kw => lower.includes(kw))) return MODEL_SONNET;
  return SONNET_KEYWORDS.some(kw => lower.includes(kw)) ? MODEL_SONNET : MODEL_HAIKU;
}

// ── HTML escape (per template PDF) ───────────────────────────────────────────
function esc(s) {
  if (s == null) return '—';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── System prompt principale ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `Sei Ladia, l'assistente IA di Palladia — la piattaforma italiana per la gestione professionale dei cantieri edili.

Hai la competenza combinata di un ingegnere civile senior con 20+ anni di cantieri, un Coordinatore della Sicurezza (CSE/CSP) di alto livello, un esperto di diritto del lavoro e appalti pubblici italiani. Sei il punto di riferimento tecnico più affidabile nel settore edilizio italiano: preciso, autorevole, diretto. Citi sempre l'articolo e il decreto esatto. Non dici mai "dipende" senza spiegare da cosa dipende.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AMBITI DI COMPETENZA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① DATI CANTIERE (usa i tool — dati reali dal database)
   Presenze in tempo reale, timbrature, lavoratori assegnati, cantieri attivi/chiusi, KPI, storico presenze.
   Economia per cantiere: budget, costi sostenuti, ricavi, utile lordo, SAL%, rischio sforamento, proiezioni.

② SICUREZZA SUL LAVORO — massima profondità tecnica
   D.Lgs. 81/2008 (T.U. Sicurezza) e tutti i decreti attuativi — conosci ogni articolo
   DPI Cat. I/II/III (D.Lgs. 81 Titolo III, Reg. UE 2016/425) — scelta, marcatura CE, manutenzione, sostituzione
   DVR, PSC, POS — contenuti obbligatori, redazione, aggiornamento, sanzioni per omissione
   Lavori in quota (art. 107-111 D.Lgs. 81) — obbligo > 2m, sistemi anticaduta, linee vita
   Ponteggi (D.M. 23/3/2000, all. XXII D.Lgs. 81) — PIMUS, abilitazione montatori, calcolo di resistenza
   Scavi e sbancamenti (art. 118-121) — armature, distanze, segnalazione
   Demolizioni (art. 150-155) — piano demolizione, amianto (D.M. 06/09/1994), bonifica
   Rischio chimico (Titolo IX D.Lgs. 81), biologico, cancerogeni — VLE, misure tecniche
   Rumore (art. 180-198), vibrazioni (art. 199-205) — LEX, misurazioni, sorveglianza sanitaria
   Primo soccorso (D.M. 388/2003) — classificazione aziende, presidi, formazione addetti
   Antincendio (D.M. 2/9/2021) — categorie rischio, estintori, vie di esodo, segnaletica
   ATEX (Dir. 2014/34/UE, D.Lgs. 81 Titolo XI) — classificazione zone, apparecchiature
   Spazi confinati (DPR 177/2011) — qualificazione imprese, procedure operative
   Figure della sicurezza: preposto (art. 19), RSPP (art. 31-32), RLS (art. 47-50), MC, DdL — obblighi, sanzioni penali e amministrative
   Formazione: Accordo Stato-Regioni 21/12/2011, 22/2/2012 — durate, aggiornamenti, validità attestati
   Patente a punti in edilizia (art. 27 D.Lgs. 81 come modificato dalla L. 56/2024) — punteggi, recupero, sospensione

③ NORMATIVA APPALTI E LAVORI EDILI
   D.Lgs. 36/2023 (Codice dei Contratti Pubblici) — soglie, procedure, qualificazione stazioni appaltanti
   Subappalto (art. 119 D.Lgs. 36/2023) — limiti, obblighi, responsabilità solidale
   SOA — categorie OG/OS, classifiche, attestazione, rinnovo quinquennale, verifica triennale
   DURC — validità 120gg, cause ostative, regolarizzazione
   Antimafia (D.Lgs. 159/2011) — white list, informativa prefettizia, comunicazione
   CAM costruzioni (D.M. 23/6/2022) — criteri ambientali minimi, materiali riciclati
   CCNL Edilizia (Industria e Artigianato) — inquadramenti A1-D3, mansioni, paga base, scatti anzianità, TFR, cassa edile
   SAL, contabilità lavori, riserve — art. 120-121 D.Lgs. 36/2023
   Collaudi: tecnico-amministrativo, statico (D.P.R. 380/2001), funzionale

④ ANALISI E GESTIONE OPERATIVA
   Analisi presenze, ore lavorate, produttività, assenteismo
   Statistiche cantiere, reportistica operativa
   Pianificazione squadre, scadenze documentali, checklist sicurezza
   Previsioni meteo cantiere (3 giorni) con suggerimenti operativi
   Gestione subappaltatori: DURC, SOA, assicurazioni, assegnazione cantieri
   Gestione mezzi/attrezzature: inventario, assicurazioni, assegnazione cantieri
   Non conformità: apertura, monitoraggio, risoluzione — ciclo completo
   Quadro economico cantiere: costi, ricavi, voci economia, fatture, DDT
   Cedolini/buste paga lavoratori — consultazione e storico
   Prenotazioni e consegne programmate per cantiere
   Diario di cantiere: lavorazioni, meteo, problemi, decisioni, materiali

⑤ PREZZIARI REGIONALI E ANALISI PREZZI — competenza esclusiva
   Hai accesso al Prezzario Regionale Liguria 2023 (e altre regioni disponibili).
   Usa search_prezzario per trovare prezzi unitari di qualsiasi lavorazione.
   Usa get_company_prezzi per i prezzi dei fornitori dell'azienda.

   ANALISI DEI PREZZI — formula standard edilizia italiana:
   ┌──────────────────────────────────────────────────────────┐
   │  Costo Diretto = Materiali + Manodopera + Noli           │
   │  Prezzo Netto  = Costo Diretto × (1 + Spese Generali)   │
   │  Prezzo Offerta = Prezzo Netto × (1 + Utile)             │
   │  Spese Generali: 13–15% (default 14%)                    │
   │  Utile d'impresa: 8–12% (default 10%)                    │
   └──────────────────────────────────────────────────────────┘

   COME FARE UN'ANALISI PREZZI — procedura:
   1. Identifica la lavorazione richiesta
   2. Chiama search_prezzario per trovare voci di materiali, manodopera, noli
   3. Se l'utente ha fornitori propri, chiama get_company_prezzi per i materiali
   4. Componi la tabella analitica con i componenti
   5. Applica SG e utile e presenta il prezzo finale
   6. Cita SEMPRE la fonte: "Prezzario Regione Liguria 2023" + nota "prezzi indicativi, verificare con fornitori locali"

   COME FARE UN COMPUTO ESTIMATIVO:
   - Per ogni voce: quantità × prezzo_unitario = importo
   - Raggruppa per categoria
   - Totale parziali + totale generale
   - Presenta in tabella con colonne: Voce | UM | Qta | Prezzo unit. | Importo
   - Puoi aggiungere una riga per Spese Generali (14%) e Utile (10%)
   - Offri sempre di esportare in PDF/Excel

   REGOLE PREZZI:
   - Non inventare MAI prezzi — usa SEMPRE i tool. Se la voce non si trova, dillo.
   - Se cerchi "scavo" e trovi "scavo a sezione aperta 6,80 €/m³" — usa quello, citalo.
   - Distingui: prezzo di prezzario (pubblico) vs prezzo fornitore aziendale (privato).
   - Indica sempre l'anno del prezzario usato.
   - Per regioni non disponibili: avvisa l'utente e usa Liguria come riferimento.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FUORI AMBITO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tutto ciò che non riguarda cantieri, edilizia o sicurezza sul lavoro.
Risposta standard: "Sono specializzato nella gestione cantieri e sicurezza edile. Posso aiutarti con presenze, normative D.Lgs. 81/2008, dati dei tuoi cantieri o analisi operative — hai domande in questo ambito?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ISTRUZIONI OPERATIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Italiano sempre. Tono professionale da esperto senior: diretto, assertivo, senza fronzoli.
- Su domande normative: cita SEMPRE decreto + articolo specifico. Mai generici.
- Dati reali: usa i tool. Non inventare MAI numeri, nomi o date.
- Risposte brevi (max 5 righe) salvo analisi o elenchi completi richiesti.
- Elenchi lavoratori: • Nome Cognome — 08:15
- Quando trovi un cantiere per nome, usa il site_id nelle query successive.
- Fuso orario: Europa/Roma.
- Se la normativa è cambiata di recente, segnalalo e indica l'aggiornamento.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPORT PDF / EXCEL — FUNZIONALITÀ INTEGRATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Puoi generare report PDF ed Excel. Il sistema funziona così:
1. Recuperi i dati con i tool e li presenti in modo chiaro.
2. Sotto ogni tua risposta appaiono automaticamente i pulsanti "PDF" ed "Excel".
3. L'utente clicca il pulsante e scarica il file formattato Palladia.

Quindi quando un utente chiede "generami un PDF", "esporta in Excel", "voglio un report":
- Recupera PRIMA i dati richiesti con i tool appropriati.
- Presentali in modo ordinato nel messaggio (tabella testuale o elenco).
- Concludi con: "Clicca **PDF** o **Excel** qui sotto per scaricare il report formattato."
- Non dire MAI che non puoi generare PDF o report — puoi farlo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NAVIGAZIONE — navigate_to_page
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usa navigate_to_page quando l'utente vuole accedere a una sezione specifica:
- "vai al cantiere X" / "apri cantiere X" → chiama prima get_sites, poi navigate_to_page con /cantieri/UUID
- "mostrami le presenze del cantiere X" → /cantieri/UUID?tab=0
- "note e foto del cantiere X" → /cantieri/UUID?tab=4
- "economia / costi del cantiere X" → /cantieri/UUID?tab=5
- "lavoratori del cantiere X" → /cantieri/UUID?tab=2
- "vai alla dashboard" → /dashboard
- Dopo navigate_to_page, spiega brevemente cosa trova l'utente in quella sezione.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GESTIONE RISULTATI DEI TOOL — CRITICO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Se present_count = 0 o lista vuota: di chiaramente "Nessun lavoratore presente" o "Nessuna timbratura oggi" — è un dato valido, non un errore.
- Se total_punches_today = 0: significa che oggi nessuno ha timbrato ancora — comunicalo direttamente.
- MAI usare frasi come "problema di connessione", "errore tecnico", "contatta l'amministratore", "vai nella sezione X".
- MAI suggerire all'utente di cercare i dati altrove — tu SEI il sistema, sei la fonte.
- Se un tool restituisce {error: "..."}: di semplicemente "Non riesco a recuperare questo dato al momento" e offri ciò che puoi.
- Tono sempre assertivo: "Oggi non risulta nessuna presenza" non "Purtroppo non riesco a vedere..."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL DISPONIBILI — 61 TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATI GENERALI: get_sites, get_site_detail, get_kpi, get_economia, navigate_to_page
PRESENZE E ORE: get_presence_today, get_presence_history, get_workers, get_worker_detail, get_worker_hours, get_worker_certificates
SICUREZZA E COMPLIANCE: get_compliance_overview, get_upcoming_deadlines, get_risk_score, get_inspection_shield, get_nonconformities, get_coordinator_notes, get_coordinator_nonconformities
FASI E AVANZAMENTO: get_site_phases, get_sal_history, get_computo_voci, get_capitolato_voci
METEO E SOSPENSIONI: get_weather_forecast, get_weather_log, get_suspension_days
ECONOMIA E COSTI: get_site_costs, get_expenses_summary, get_payslips
DOCUMENTI: get_site_documents, get_company_documents, get_subcontractor_documents
DIARIO E LOGISTICA: get_diary_entries, get_site_bookings
SUBAPPALTATORI E MEZZI: get_subcontractors, get_equipment
PREZZARIO: search_prezzario, get_company_prezzi

AZIONI DI SCRITTURA:
create_worker, update_worker_expiry, assign_worker_to_site, remove_worker_from_site, create_site, update_site, update_sal, create_diary_entry, create_suspension_day, create_phase, update_phase, create_expense, create_site_note, create_site_cost, create_economia_voce, resolve_nonconformity, create_subcontractor, assign_subcontractor_to_site, create_equipment, assign_equipment_to_site, create_booking

ELABORAZIONE IMMAGINI (usa quando l'utente invia una foto):
create_expense_from_image, create_ddt_from_image, archive_document_image

NOTA — NON CONFORMITÀ DA IMPRESA:
La tabella NC formale richiede il coordinatore. Per segnalare un problema da impresa usa:
create_site_note con category='non_conformita', urgency='alta' o 'critica'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRATEGIA MULTI-TOOL — RISPOSTE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Per domande ampie, chiama PIU' tool per dare risposte complete:

"Come siamo messi?" / "Riepilogo generale":
→ get_kpi + get_upcoming_deadlines + get_compliance_overview (filter: issues)

"Stato del cantiere X":
→ get_site_detail + get_site_phases + get_economia + get_risk_score

"Mario è in regola?" / "Dettaglio lavoratore":
→ get_worker_detail + get_worker_certificates

"Siamo pronti per l'ispezione?":
→ get_inspection_shield (contiene già tutto)

"Economia del cantiere X completa":
→ get_economia + get_site_costs + get_sal_history + get_computo_voci

"Subappaltatore X è in regola?":
→ get_subcontractors (per trovare UUID) + get_subcontractor_documents

"Diario della settimana":
→ get_diary_entries + get_weather_log + get_suspension_days (stesse date)

"Che tempo fa domani?" / "Previsioni cantiere":
→ get_weather_forecast (previsioni 3 giorni con temperature e precipitazioni)

"Cedolini di Mario" / "Buste paga giugno":
→ get_payslips (con worker_name o month)

"Aggiungi costo al cantiere" / "Fattura da X":
→ create_site_cost (costi diretti) OPPURE create_economia_voce (quadro economico)

"Chiudi la NC" / "Non conformità risolta":
→ resolve_nonconformity

"Aggiungi il sub Edilcoop al cantiere":
→ create_subcontractor (se non esiste) → assign_subcontractor_to_site

"Sposta l'escavatore al cantiere Y":
→ get_equipment (trova UUID) → assign_equipment_to_site

"Rimuovi Mario dal cantiere":
→ get_workers (trova UUID) → remove_worker_from_site

"Panoramica completa cantiere X":
→ get_site_detail + get_site_phases + get_economia + get_risk_score + get_weather_forecast + get_nonconformities + get_diary_entries

NON fare una sola call quando servono più dati. Il tecnico vuole il quadro completo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTINUITÀ DI CONTESTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Se l'utente ha già menzionato un cantiere nella conversazione, usa quel site_id senza chiedere di nuovo.
- Se l'utente ha già menzionato un lavoratore, usa quel worker_id.
- Se c'è un solo cantiere attivo, usalo come default.
- Se la domanda è ambigua e ci sono più cantieri, chiedi "Quale cantiere? Ho: X, Y, Z" con i nomi.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AZIONI DI SCRITTURA — REGOLA FERREA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prima di chiamare QUALSIASI tool di scrittura (create_*, update_*, assign_*):
1. Presenta un RIEPILOGO STRUTTURATO dei dati che stai per salvare:
   **Azione**: [cosa stai per fare]
   **Dati**: [elenco puntato dei campi con i valori]
   **Cantiere**: [nome, se applicabile]
2. Chiedi: "Confermo?"
3. Solo dopo la conferma esplicita dell'utente, chiama il tool.
ECCEZIONE: Se l'utente dice esplicitamente "registra", "segna", "fai" con tutti i dati già chiari e non ambigui, puoi procedere direttamente senza chiedere conferma.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RICONOSCIMENTO IMPLICITO — ZERO PERDITA DI DATI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
In OGNI messaggio dell'utente, identifica dati registrabili anche se non richiesti esplicitamente.
Al termine della tua risposta, se hai rilevato dati utili non ancora salvati, aggiungi:

📋 **Rilevato — vuoi che registri?**
• [tipo]: [sintesi] → [azione]

PATTERN DA RICONOSCERE:
• Spesa/pagamento menzionata (importo + fornitore) → create_expense
• Materiali consegnati / DDT / fornitura arrivata → create_site_cost
• Consegna o visita programmata per una data → create_booking
• Problema/anomalia/violazione rilevata → create_site_note (category: non_conformita, urgency: alta)
• Pioggia/neve/vento/stop lavori per maltempo → create_suspension_day + create_diary_entry
• Attività svolta oggi (lavori, getti, scavi, posa) → create_diary_entry
• Nuovo lavoratore con nome e CF menzionato → create_worker + assign_worker_to_site
• Fase completata o avanzamento % citato → update_phase + update_sal

REGOLE:
1. Il blocco va SEMPRE alla fine, dopo la risposta tecnica — mai in mezzo
2. Max 3 voci per blocco (priorizza: sicurezza > scadenze > economia)
3. Se l'utente risponde "sì", "ok", "registra" → procedi direttamente senza ulteriore riepilogo
4. Per N elementi dello stesso tipo (es. 3 lavoratori, 2 spese) → registrali tutti in sequenza
5. Non proporre se i dati sono già stati registrati in questa conversazione
6. Non proporre per dati già certi (es. l'utente ti ha appena chiesto solo un consiglio normativo)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUGGERIMENTI PROATTIVI (dopo visualizzazione dati)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dopo aver mostrato dati, suggerisci azioni quando pertinente:
- Documenti scaduti → "Vuoi che aggiorni la scadenza?"
- SAL fermo → "Vuoi aggiornare il SAL?"
- Fase completata → "Segno la fase come completata?"
- Nessun diario per oggi → "Vuoi registrare le attività di oggi?"
- Risk score alto → "Vuoi vedere cosa migliorare?"
- NC aperte da tempo → "Vuoi chiuderne qualcuna?"
- Subappaltatore con DURC scaduto → "Il DURC di X è scaduto — va sospeso dal cantiere."
- Mezzo con assicurazione scaduta → "L'assicurazione di X è scaduta — da non usare in cantiere."
- Pioggia prevista domani → "Domani è prevista pioggia — vuoi registrare una sospensione?"
- Costi in sforamento → "Budget consumato al X% con SAL al Y% — attenzione."
- Lavoratore non assegnato → "Vuoi assegnarlo a un cantiere?"
Suggerisci con una frase breve, mai invadente. L'utente decide.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILOSOFIA — LADIA È IL CENTRO OPERATIVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tu NON sei un semplice chatbot. Sei il punto di controllo unico per ogni cantiere.
Il tecnico deve poter gestire TUTTO da qui: presenze, sicurezza, economia, meteo, documenti, subappaltatori, mezzi, NC, diario, cedolini, scadenze.
Se l'utente ti chiede qualcosa, hai il tool per rispondere. Se manca un dato, dillo — non rimandare MAI a "un'altra sezione".
Quando presenti lo stato di un cantiere, pensa come un direttore di cantiere: cosa mi serve sapere ORA per prendere decisioni?
Priorità: sicurezza > scadenze > economia > operatività.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ELABORAZIONE IMMAGINI E DOCUMENTI FOTOGRAFATI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Quando ricevi una o più immagini, analizzale IMMEDIATAMENTE e identifica il tipo:

RICEVUTA / SCONTRINO / FATTURA:
→ Estrai: fornitore, importo totale, data, numero documento, articoli/servizi
→ Tool: create_expense_from_image
→ Mostra dati estratti in tabella, chiedi conferma e cantiere di destinazione

DDT — Documento di Trasporto:
→ Estrai: mittente, numero DDT, data, descrizione merci, destinatario/cantiere
→ Tool: create_ddt_from_image
→ Associa al cantiere già noto nella conversazione, o chiedi

VERBALE / ORDINE / LETTERA / CERTIFICATO / PLANIMETRIA / FOTO CANTIERE:
→ Identifica tipo, data, parti, contenuto chiave
→ Tool: archive_document_image
→ Proponi categoria e cantiere, crea nota strutturata con tutto il contenuto

REGOLE IMMAGINI:
1. Analizza PRIMA, chiedi DOPO — non dire "non riesco a vedere" prima di guardare
2. Estrai TUTTI i campi leggibili. Se un campo è illeggibile, scrivi "illeggibile"
3. Prima di salvare mostra sempre il riepilogo strutturato e chiedi conferma
4. Se l'utente dice "registra" o "sì" o "ok" dopo il riepilogo, salva direttamente
5. Dopo la registrazione: "✓ [Tipo] da [fornitore] del [data] registrato in [cantiere]"
6. Per le foto di cantiere: descrivi lo stato lavori, segnala problemi visibili, suggerisci azioni`;


// ── System prompt per strutturazione report (export) ─────────────────────────
const REPORT_SYSTEM_PROMPT = `Sei un formattatore di report aziendali professionali.
Ricevi una conversazione tra un utente e Pal (assistente IA per cantieri) e devi strutturarla in un report JSON.

RESTITUISCI SOLO JSON VALIDO — zero markdown, zero backtick, zero testo aggiuntivo.

Schema richiesto:
{
  "title": "Titolo breve (max 55 caratteri)",
  "subtitle": "Sottotitolo opzionale (periodo, cantiere, ecc.)",
  "summary": "Sommario esecutivo in italiano (2-4 frasi, professionale)",
  "kpis": [
    { "value": "stringa breve (es. 12, 87%, 3)", "label": "etichetta descrittiva" }
  ],
  "sections": [
    {
      "title": "TITOLO SEZIONE MAIUSCOLO",
      "text": "Paragrafo narrativo opzionale",
      "table": {
        "headers": ["Colonna 1", "Colonna 2"],
        "rows": [["val1", "val2"], ["val3", "val4"]]
      }
    }
  ]
}

Regole:
- kpis: max 4, solo se ci sono valori numerici significativi. Ometti l'array se non ci sono KPI.
- sections: almeno 1, max 8. table opzionale. text opzionale.
- Tutte le celle delle tabelle devono essere stringhe (non numeri, non null).
- Se il contenuto è principalmente testuale (consigli, normative), crea sezioni con solo text.
- Se ci sono dati tabulari (presenze, lavoratori, ecc.), crea table appropriate.
- summary deve essere informativo, non "Ecco il report su..." bensì il contenuto effettivo.`;

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_sites',
    description: 'Lista cantieri dell\'azienda. Usa per trovare un cantiere per nome o elencare attivi/chiusi.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'],
          description: 'Filtra per stato. Ometti per tutti. Non include i cantieri eliminati.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_presence_today',
    description: 'Chi è presente adesso nei cantieri (ENTRY senza EXIT successivo, oggi). Usa per: quante persone ci sono, chi è presente, timbrature di oggi.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: {
          type: 'string',
          description: 'UUID cantiere. Ometti per tutti i cantieri.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_workers',
    description: 'Lista lavoratori dell\'azienda o di un cantiere specifico.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: {
          type: 'string',
          description: 'UUID cantiere per filtrare i lavoratori assegnati. Ometti per tutti.'
        },
        active_only: {
          type: 'boolean',
          description: 'true = solo attivi (default). false = tutti inclusi inattivi.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_presence_history',
    description: 'Storico presenze per un periodo. Usa per domande su giorni passati, ore lavorate, statistiche.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: {
          type: 'string',
          description: 'UUID cantiere. Ometti per tutti i cantieri.'
        },
        from_date: {
          type: 'string',
          description: 'Data inizio YYYY-MM-DD (fuso Europa/Roma)'
        },
        to_date: {
          type: 'string',
          description: 'Data fine YYYY-MM-DD (fuso Europa/Roma)'
        }
      },
      required: ['from_date', 'to_date']
    }
  },
  {
    name: 'get_kpi',
    description: 'KPI generali: cantieri attivi, totale lavoratori, presenti oggi. Usa come prima query per domande generali.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_economia',
    description: 'Dati economici di un cantiere specifico: budget preventivo, totale costi sostenuti, totale ricavi, utile lordo, margine %, SAL%, rischio sforamento, proiezione budget, breakdown per categoria. Usa per qualsiasi domanda su: spese, costi, ricavi, guadagni, margini, situazione economica, budget, stato avanzamento lavori.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: {
          type: 'string',
          description: 'UUID del cantiere (obbligatorio). Se non lo conosci, chiamare prima get_sites per trovarlo.'
        }
      },
      required: ['site_id']
    }
  },
  {
    name: 'navigate_to_page',
    description: 'Naviga l\'utente a una pagina specifica della piattaforma. Usa quando l\'utente vuole vedere un cantiere, una sezione, o dice "vai a", "portami a", "apri", "mostrami". Chiama DOPO aver recuperato il site_id con get_sites se serve.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path della pagina. Esempi: /cantieri/UUID, /dashboard, /risorse, /cantieri/UUID?tab=0 (Presenze), /cantieri/UUID?tab=1 (Info), /cantieri/UUID?tab=2 (Maestranze), /cantieri/UUID?tab=3 (Documenti), /cantieri/UUID?tab=4 (Note e Foto), /cantieri/UUID?tab=5 (Economia)'
        },
        label: {
          type: 'string',
          description: 'Nome leggibile della destinazione es. "Cantiere Villa Rossi", "Presenze di oggi — Cantiere Bianchi", "Dashboard"'
        }
      },
      required: ['path', 'label']
    }
  },
  {
    name: 'search_prezzario',
    description: 'Cerca voci nel prezzario regionale per trovare prezzi unitari di lavorazioni, materiali, manodopera, noli. Usare SEMPRE per rispondere a domande su costi, analisi prezzi, computi estimativi. Non inventare mai prezzi — usare questo tool.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Descrizione della lavorazione o materiale da cercare. Es: "scavo a sezione aperta", "calcestruzzo C25/30", "muratura blocchi cls", "ponteggio tubolare", "intonaco civile"'
        },
        regione: {
          type: 'string',
          description: 'Regione italiana in minuscolo. Es: "liguria", "lombardia", "toscana". Default: "liguria"'
        },
        anno: {
          type: 'integer',
          description: 'Anno del prezzario. Ometti per usare l\'ultimo disponibile.'
        },
        limit: {
          type: 'integer',
          description: 'Numero massimo di risultati (default 5, max 15). Aumenta per analisi prezzi complesse.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_company_prezzi',
    description: 'Cerca prezzi fornitori inseriti dall\'azienda. Usare quando l\'utente menziona i propri fornitori o vuole usare prezzi personalizzati al posto del prezzario regionale. I prezzi aziendali hanno la priorità sui materiali.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Descrizione del materiale o articolo da cercare nei prezzi aziendali.'
        }
      },
      required: ['query']
    }
  },

  // ── Tool compliance & organico ─────────────────────────────────────────────
  {
    name: 'get_compliance_overview',
    description: 'Stato conformità documenti (formazione + idoneità medica) di tutti i lavoratori. Usa per: "chi ha documenti scaduti o in scadenza", "stato formazione organico", "lavoratori non conformi", "devo rinnovare qualcosa", "chi non è in regola".',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'issues', 'expiring_90', 'non_compliant'],
          description: 'all=tutti | issues=chi ha problemi (default) | expiring_90=scade entro 90gg | non_compliant=già scaduti'
        }
      },
      required: []
    }
  },

  {
    name: 'get_worker_detail',
    description: 'Profilo completo di un lavoratore specifico: compliance documenti, date di scadenza, elenco documenti caricati, cantieri assegnati. Usa quando si chiede di UN lavoratore preciso.',
    input_schema: {
      type: 'object',
      properties: {
        worker_name: {
          type: 'string',
          description: 'Nome (anche parziale) del lavoratore da cercare'
        },
        worker_id: {
          type: 'string',
          description: 'UUID del lavoratore (se già noto)'
        }
      },
      required: []
    }
  },

  {
    name: 'get_upcoming_deadlines',
    description: 'Tutte le scadenze documentali in arrivo (formazione, idoneità medica, assicurazioni mezzi) entro un orizzonte configurabile. Usa per: "cosa scade questo mese", "scadenze prossimi 60 giorni", "pianifica i rinnovi", "calendario scadenze".',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Giorni avanti da considerare (default 90, max 365)'
        },
        type: {
          type: 'string',
          enum: ['all', 'formazione', 'idoneita', 'mezzi'],
          description: 'Filtra per tipo di scadenza. Default: all'
        }
      },
      required: []
    }
  },

  // ── Tool 13-23: nuovi strumenti ──────────────────────────────────────────────

  {
    name: 'get_subcontractors',
    description: 'Lista subappaltatori dell\'azienda o di un cantiere. Include stato DURC, assicurazione, SOA. Usa per: "subappaltatori", "DURC di X", "chi lavora in subappalto".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere per filtrare. Ometti per tutti.' }
      },
      required: []
    }
  },
  {
    name: 'get_equipment',
    description: 'Lista mezzi e attrezzature. Include scadenze manutenzione/assicurazione. Usa per: "mezzi", "attrezzature", "gru", "escavatore", "revisione".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere per filtrare. Ometti per tutti.' }
      },
      required: []
    }
  },
  {
    name: 'get_expenses_summary',
    description: 'Riepilogo spese aziendali con filtri. Usa per: "spese di questo mese", "quanto abbiamo speso", "spese per categoria", "ultima fattura".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere. Ometti per tutte le spese aziendali.' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD' },
        category: { type: 'string', description: 'Categoria: materiali, manodopera, noli, trasporti, altro' }
      },
      required: []
    }
  },
  {
    name: 'get_site_documents',
    description: 'Documenti caricati per un cantiere e checklist di cosa manca. Usa per: "documenti di Via Roma", "manca qualcosa?", "abbiamo il PSC?", "stato documenti".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_diary_entries',
    description: 'Diario di cantiere — registrazioni giornaliere (lavorazioni, meteo, note, presenti). Usa per: "diario di oggi", "cosa si è fatto ieri", "registrazioni della settimana".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD. Default: oggi.' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD. Default: from_date.' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_risk_score',
    description: 'Punteggio di rischio Safety Copilot per un cantiere: compliance, presenze, meteo, scadenze, NC aperte, subappaltatori. Usa per: "rischio", "livello sicurezza", "come siamo messi con la sicurezza".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_inspection_shield',
    description: 'Scudo ispezione ASL — dossier completo di tutto ciò che serve se arriva un\'ispezione. Usa per: "arriva l\'ASL", "ispezione", "siamo pronti per un controllo?", "dossier ispettivo".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_nonconformities',
    description: 'Non conformità aperte per un cantiere o per tutta l\'azienda. Usa per: "problemi aperti", "non conformità", "NC", "segnalazioni del coordinatore".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere. Ometti per tutte.' },
        status: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default: open' }
      },
      required: []
    }
  },
  {
    name: 'get_site_detail',
    description: 'Dettaglio completo di un singolo cantiere: info, date, budget, stato, coordinate, lavoratori assegnati, documenti. Usa quando serve il quadro completo di UN cantiere.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'create_expense',
    description: 'Registra una nuova spesa aziendale. Usa quando l\'utente dice "ho speso", "registra spesa", "fattura da X euro". IMPORTANTE: conferma sempre i dettagli con l\'utente prima di chiamare questo tool.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Importo in euro' },
        category: { type: 'string', enum: ['materiali', 'manodopera', 'noli', 'trasporti', 'sicurezza', 'altro'], description: 'Categoria spesa' },
        description: { type: 'string', description: 'Descrizione della spesa' },
        supplier: { type: 'string', description: 'Fornitore (opzionale)' },
        site_id: { type: 'string', description: 'UUID cantiere (opzionale)' },
        expense_date: { type: 'string', description: 'Data YYYY-MM-DD. Default: oggi.' },
        payment_method: { type: 'string', enum: ['contanti', 'bonifico', 'carta', 'assegno'], description: 'Metodo pagamento. Default: bonifico.' }
      },
      required: ['amount', 'description']
    }
  },
  {
    name: 'create_site_note',
    description: 'Crea una nota/promemoria per un cantiere. Usa quando l\'utente dice "ricordami", "annotami", "segna che", "nota per il cantiere". IMPORTANTE: conferma i dettagli prima.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        title: { type: 'string', description: 'Titolo breve della nota' },
        body: { type: 'string', description: 'Testo completo della nota' },
        category: { type: 'string', enum: ['generale', 'sicurezza', 'materiali', 'non_conformita', 'promemoria'], description: 'Default: generale' },
        urgency: { type: 'string', enum: ['bassa', 'media', 'alta', 'critica'], description: 'Default: media' }
      },
      required: ['site_id', 'title']
    }
  },
  // ── 13 READ tools ──────────────────────────────────────────────────────────
  {
    name: 'get_site_phases',
    description: 'Fasi/lavorazioni di un cantiere: stato, percentuale avanzamento, date previste/reali, importo. Usa per: "fasi del cantiere", "cronoprogramma", "a che punto siamo con le lavorazioni".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_sal_history',
    description: 'Storico SAL emessi per un cantiere: numero, percentuale, data, importo maturato, costi, margine. Usa per: "SAL emessi", "storico avanzamento", "ultimo SAL".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_weather_log',
    description: 'Storico meteo registrato per un cantiere: pioggia, vento, temperature, superamento soglie. Usa per: "meteo della settimana", "quanta pioggia", "giorni di maltempo".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_suspension_days',
    description: 'Giorni di sospensione cantiere (pioggia, vento, neve). Usa per: "giorni di sospensione", "quanti giorni persi per maltempo", "sospensioni".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_computo_voci',
    description: 'Voci del computo metrico: codice, descrizione, quantita, prezzo unitario, importo, avanzamento SAL per voce. Usa per: "computo del cantiere", "voci di lavoro", "quanto costa la voce X".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_site_costs',
    description: 'Costi diretti sostenuti per un cantiere: fatture, DDT, acconti con fornitore, importo, data. Usa per: "costi del cantiere", "fatture ricevute", "quanto abbiamo speso di fatture".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_subcontractor_documents',
    description: 'Documenti di un subappaltatore: DURC, polizza, SOA, visura con scadenze. Usa per: "documenti del subappaltatore", "DURC di Edilcoop", "cosa scade al sub".',
    input_schema: {
      type: 'object',
      properties: {
        subcontractor_id: { type: 'string', description: 'UUID subappaltatore (obbligatorio). Usa get_subcontractors per trovarlo.' }
      },
      required: ['subcontractor_id']
    }
  },
  {
    name: 'get_coordinator_notes',
    description: 'Note del coordinatore sicurezza (CSE/CSP): osservazioni, richieste, approvazioni, avvertimenti. Usa per: "cosa ha scritto il coordinatore", "note del CSE", "comunicazioni sicurezza".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        unread_only: { type: 'boolean', description: 'true = solo non lette. Default: false.' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_coordinator_nonconformities',
    description: 'Non conformita formali dal coordinatore: titolo, gravita, stato, scadenza. Usa per: "NC del coordinatore", "segnalazioni CSE", "non conformita formali".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        status: { type: 'string', enum: ['aperta', 'in_lavorazione', 'risolta', 'chiusa', 'all'], description: 'Default: aperta.' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'get_worker_certificates',
    description: 'Attestati di formazione di un lavoratore o di tutti: tipo corso, data, scadenza, ente. Usa per: "attestati di Mario", "certificati in scadenza", "formazione del lavoratore".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore. Ometti per tutti i lavoratori.' },
        worker_name: { type: 'string', description: 'Nome lavoratore (ricerca parziale).' },
        expiring_within_days: { type: 'integer', description: 'Solo attestati che scadono entro N giorni.' }
      },
      required: []
    }
  },
  {
    name: 'get_worker_hours',
    description: 'Ore lavorate da un lavoratore in un periodo: timbrature, ore per giorno, totale. Usa per: "ore di Mario", "quante ore ha fatto", "presenze dettagliate di un lavoratore".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD (obbligatorio)' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD (obbligatorio)' }
      },
      required: ['worker_id', 'from_date', 'to_date']
    }
  },
  {
    name: 'get_company_documents',
    description: 'Documenti aziendali (DURC, visura, DVR, ISO, SOA, polizze). Usa per: "documenti aziendali", "abbiamo il DURC aziendale?", "libreria documenti".',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_capitolato_voci',
    description: 'Voci del capitolato speciale d\'appalto: codice, categoria, descrizione, quantita, prezzo, importo. Usa per: "capitolato del cantiere", "voci del capitolato", "cosa prevede il capitolato".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['site_id']
    }
  },
  // ── 10 WRITE tools ─────────────────────────────────────────────────────────
  {
    name: 'create_worker',
    description: 'Crea un nuovo lavoratore nell\'organico. IMPORTANTE: conferma SEMPRE i dati prima. Usa per: "aggiungi lavoratore", "inserisci operaio", "nuovo dipendente".',
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string', description: 'Nome completo (obbligatorio)' },
        fiscal_code: { type: 'string', description: 'Codice fiscale' },
        role: { type: 'string', description: 'Ruolo es. operaio, carpentiere, muratore' },
        qualification: { type: 'string', description: 'Qualifica es. operaio specializzato' },
        employer_name: { type: 'string', description: 'Nome datore di lavoro/impresa' }
      },
      required: ['full_name']
    }
  },
  {
    name: 'update_worker_expiry',
    description: 'Aggiorna scadenze formazione/idoneita medica di un lavoratore. IMPORTANTE: conferma SEMPRE prima. Usa per: "aggiorna scadenza di Mario", "rinnova idoneita".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore (se noto)' },
        worker_name: { type: 'string', description: 'Nome lavoratore (cerca se UUID non noto)' },
        safety_training_expiry: { type: 'string', description: 'Nuova scadenza formazione YYYY-MM-DD' },
        health_fitness_expiry: { type: 'string', description: 'Nuova scadenza idoneita medica YYYY-MM-DD' }
      },
      required: []
    }
  },
  {
    name: 'assign_worker_to_site',
    description: 'Assegna un lavoratore a un cantiere. IMPORTANTE: conferma SEMPRE prima. Usa per: "assegna Mario al cantiere X", "aggiungi operaio al cantiere".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore (obbligatorio)' },
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['worker_id', 'site_id']
    }
  },
  {
    name: 'create_site',
    description: 'Crea un nuovo cantiere. IMPORTANTE: conferma SEMPRE i dettagli prima. Usa per: "crea cantiere", "nuovo cantiere", "apri un cantiere".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome del cantiere (obbligatorio)' },
        address: { type: 'string', description: 'Indirizzo' },
        start_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Data fine prevista YYYY-MM-DD' },
        budget_totale: { type: 'number', description: 'Budget totale in euro' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_site',
    description: 'Aggiorna dati di un cantiere: nome, indirizzo, stato, date, budget. IMPORTANTE: conferma SEMPRE prima. Usa per: "cambia indirizzo cantiere", "aggiorna budget", "chiudi cantiere".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        name: { type: 'string', description: 'Nuovo nome' },
        address: { type: 'string', description: 'Nuovo indirizzo' },
        status: { type: 'string', enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'], description: 'Nuovo stato' },
        start_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Data fine YYYY-MM-DD' },
        budget_totale: { type: 'number', description: 'Nuovo budget' },
        sal_percentuale: { type: 'number', description: 'Nuova SAL %' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'create_diary_entry',
    description: 'Crea o aggiorna il diario di cantiere per una data. IMPORTANTE: conferma SEMPRE prima. Usa per: "scrivi nel diario", "registra attivita di oggi", "giornale cantiere".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        entry_date: { type: 'string', description: 'Data YYYY-MM-DD. Default: oggi.' },
        activities: { type: 'string', description: 'Attivita svolte' },
        notes: { type: 'string', description: 'Note aggiuntive' },
        issues: { type: 'string', description: 'Problemi riscontrati' },
        decisions: { type: 'string', description: 'Decisioni prese' },
        materials: { type: 'string', description: 'Materiali utilizzati/consegnati' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'create_booking',
    description: 'Registra una prenotazione/consegna/appuntamento per un cantiere. IMPORTANTE: conferma SEMPRE prima. Usa per: "domani arriva il calcestruzzo", "visita del collaudatore mercoledì", "consegna ferro lunedì mattina".',
    input_schema: {
      type: 'object',
      properties: {
        site_id:      { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        title:        { type: 'string', description: 'Titolo/oggetto della prenotazione (obbligatorio). Es: "Consegna calcestruzzo", "Visita collaudo"' },
        booking_date: { type: 'string', description: 'Data YYYY-MM-DD (obbligatorio)' },
        booking_time: { type: 'string', description: 'Ora HH:MM (opzionale)' },
        category:     { type: 'string', enum: ['consegna', 'visita', 'collaudo', 'sopralluogo', 'fornitura', 'altro'], description: 'Tipo appuntamento. Default: consegna.' },
        supplier:     { type: 'string', description: 'Fornitore/ditta (opzionale)' },
        notes:        { type: 'string', description: 'Note aggiuntive (opzionale)' }
      },
      required: ['site_id', 'title', 'booking_date']
    }
  },
  {
    name: 'create_suspension_day',
    description: 'Registra un giorno di sospensione lavori (maltempo). IMPORTANTE: conferma SEMPRE prima. Usa per: "segna sospensione per pioggia", "oggi non si lavora".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        day: { type: 'string', description: 'Data YYYY-MM-DD (obbligatorio)' },
        reason: { type: 'string', enum: ['pioggia', 'vento', 'neve', 'altro'], description: 'Default: altro.' },
        notes: { type: 'string', description: 'Note aggiuntive' }
      },
      required: ['site_id', 'day']
    }
  },
  {
    name: 'update_sal',
    description: 'Aggiorna la percentuale SAL di un cantiere. IMPORTANTE: conferma SEMPRE prima. Usa per: "aggiorna SAL al 45%", "stato avanzamento lavori".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        sal_percentuale: { type: 'number', description: 'Nuova SAL % 0-100 (obbligatorio)' }
      },
      required: ['site_id', 'sal_percentuale']
    }
  },
  {
    name: 'create_phase',
    description: 'Crea una nuova fase/lavorazione in un cantiere. IMPORTANTE: conferma SEMPRE prima. Usa per: "aggiungi fase", "nuova lavorazione", "crea fase Demolizioni".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        nome: { type: 'string', description: 'Nome della fase (obbligatorio)' },
        data_inizio_prevista: { type: 'string', description: 'Data inizio prevista YYYY-MM-DD' },
        data_fine_prevista: { type: 'string', description: 'Data fine prevista YYYY-MM-DD' },
        note: { type: 'string', description: 'Note' }
      },
      required: ['site_id', 'nome']
    }
  },
  {
    name: 'update_phase',
    description: 'Aggiorna stato/avanzamento di una fase. IMPORTANTE: conferma SEMPRE prima. Usa per: "la fase X e completata", "aggiorna avanzamento fase", "inizia la fase".',
    input_schema: {
      type: 'object',
      properties: {
        phase_id: { type: 'string', description: 'UUID fase (se noto)' },
        site_id: { type: 'string', description: 'UUID cantiere (per cercare per nome)' },
        nome: { type: 'string', description: 'Nome fase (per cercare se phase_id non noto)' },
        stato: { type: 'string', enum: ['non_iniziata', 'in_corso', 'completata', 'sospesa'], description: 'Nuovo stato' },
        progresso_percentuale: { type: 'number', description: 'Percentuale 0-100' },
        data_inizio_reale: { type: 'string', description: 'Data inizio reale YYYY-MM-DD' },
        data_fine_reale: { type: 'string', description: 'Data fine reale YYYY-MM-DD' },
        note: { type: 'string', description: 'Note' }
      },
      required: []
    }
  },

  // ── Tool aggiuntivi — copertura completa cantiere ──────────────────────────
  {
    name: 'get_weather_forecast',
    description: 'Previsioni meteo 3 giorni per un cantiere (temperature, precipitazioni, vento). Usa per: "che tempo fa domani", "previsioni meteo cantiere", "pioverà questa settimana".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio — serve per le coordinate GPS)' }
      },
      required: ['site_id']
    }
  },
  {
    name: 'create_economia_voce',
    description: 'Registra una voce nel quadro economico del cantiere (costo o ricavo). IMPORTANTE: conferma SEMPRE prima. Usa per: "registra costo materiali", "aggiungi ricavo SAL", "inserisci fattura nel quadro economico".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        tipo: { type: 'string', enum: ['costo', 'ricavo'], description: 'Tipo voce (obbligatorio)' },
        categoria: { type: 'string', description: 'Categoria es. materiali, manodopera, noli, sicurezza, subappalto, sal, acconto' },
        voce: { type: 'string', description: 'Descrizione della voce (obbligatorio)' },
        importo: { type: 'number', description: 'Importo in euro (obbligatorio)' },
        data_competenza: { type: 'string', description: 'Data YYYY-MM-DD. Default: oggi.' }
      },
      required: ['site_id', 'tipo', 'voce', 'importo']
    }
  },
  {
    name: 'resolve_nonconformity',
    description: 'Chiudi/risolvi una non conformità. Usa per: "chiudi la NC", "NC risolta", "segna come risolta".',
    input_schema: {
      type: 'object',
      properties: {
        nc_id: { type: 'string', description: 'UUID della non conformità (obbligatorio). Usa get_nonconformities per trovarlo.' },
        resolution_notes: { type: 'string', description: 'Note di risoluzione (opzionale)' }
      },
      required: ['nc_id']
    }
  },
  {
    name: 'create_site_cost',
    description: 'Registra un costo diretto di cantiere (fattura, DDT, acconto). IMPORTANTE: conferma SEMPRE prima. Usa per: "registra fattura", "DDT da fornitore X", "costo cantiere".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        descrizione: { type: 'string', description: 'Descrizione del costo (obbligatorio)' },
        importo: { type: 'number', description: 'Importo in euro (obbligatorio)' },
        fornitore: { type: 'string', description: 'Nome fornitore' },
        tipo: { type: 'string', enum: ['fattura', 'ddt', 'acconto', 'nota_credito', 'altro'], description: 'Tipo documento. Default: fattura.' },
        numero_documento: { type: 'string', description: 'Numero fattura/DDT' },
        data_documento: { type: 'string', description: 'Data documento YYYY-MM-DD. Default: oggi.' },
        note: { type: 'string', description: 'Note aggiuntive' }
      },
      required: ['site_id', 'descrizione', 'importo']
    }
  },
  {
    name: 'remove_worker_from_site',
    description: 'Rimuovi un lavoratore da un cantiere (disassegna). IMPORTANTE: conferma SEMPRE prima. Usa per: "rimuovi Mario dal cantiere", "togli lavoratore dal cantiere", "disassegna".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore (obbligatorio)' },
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['worker_id', 'site_id']
    }
  },
  {
    name: 'create_subcontractor',
    description: 'Aggiungi un nuovo subappaltatore. IMPORTANTE: conferma SEMPRE prima. Usa per: "aggiungi subappaltatore", "nuovo sub", "inserisci ditta in subappalto".',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Ragione sociale (obbligatorio)' },
        contact_person: { type: 'string', description: 'Referente' },
        contact_email: { type: 'string', description: 'Email' },
        contact_phone: { type: 'string', description: 'Telefono' },
        durc_expiry: { type: 'string', description: 'Scadenza DURC YYYY-MM-DD' },
        insurance_expiry: { type: 'string', description: 'Scadenza assicurazione YYYY-MM-DD' },
        soa_expiry: { type: 'string', description: 'Scadenza SOA YYYY-MM-DD' }
      },
      required: ['company_name']
    }
  },
  {
    name: 'assign_subcontractor_to_site',
    description: 'Assegna un subappaltatore a un cantiere. Usa per: "assegna Edilcoop al cantiere X".',
    input_schema: {
      type: 'object',
      properties: {
        subcontractor_id: { type: 'string', description: 'UUID subappaltatore (obbligatorio)' },
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['subcontractor_id', 'site_id']
    }
  },
  {
    name: 'create_equipment',
    description: 'Aggiungi un mezzo/attrezzatura all\'inventario. IMPORTANTE: conferma SEMPRE prima. Usa per: "aggiungi escavatore", "nuovo mezzo", "inserisci gru".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome del mezzo (obbligatorio)' },
        type: { type: 'string', description: 'Tipo es. escavatore, gru, autocarro, betoniera, ponteggio' },
        model: { type: 'string', description: 'Modello' },
        plate_or_serial: { type: 'string', description: 'Targa o numero di serie' },
        insurance_expiry: { type: 'string', description: 'Scadenza assicurazione YYYY-MM-DD' }
      },
      required: ['name']
    }
  },
  {
    name: 'assign_equipment_to_site',
    description: 'Assegna un mezzo a un cantiere. Usa per: "sposta l\'escavatore al cantiere X".',
    input_schema: {
      type: 'object',
      properties: {
        equipment_id: { type: 'string', description: 'UUID mezzo (obbligatorio)' },
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' }
      },
      required: ['equipment_id', 'site_id']
    }
  },
  {
    name: 'get_payslips',
    description: 'Cedolini/buste paga dei lavoratori. Usa per: "cedolini di Mario", "buste paga di giugno", "ultimo cedolino".',
    input_schema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'UUID lavoratore. Ometti per tutti.' },
        worker_name: { type: 'string', description: 'Nome lavoratore (ricerca parziale).' },
        month: { type: 'string', description: 'Mese nel formato YYYY-MM. Ometti per gli ultimi.' }
      },
      required: []
    }
  },
  {
    name: 'get_site_bookings',
    description: 'Prenotazioni/consegne programmate per un cantiere. Usa per: "consegne previste", "prenotazioni cantiere", "cosa arriva questa settimana".',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'UUID cantiere (obbligatorio)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD. Default: oggi.' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD. Default: +7 giorni.' }
      },
      required: ['site_id']
    }
  },

  // ── Image processing tools ────────────────────────────────────────────────
  {
    name: 'create_expense_from_image',
    description: 'Registra spesa/ricevuta/fattura estratta da foto. Usa dopo aver analizzato un\'immagine di documento di pagamento.',
    input_schema: {
      type: 'object',
      properties: {
        site_id:        { type: 'string',  description: 'UUID cantiere. Ometti per spesa aziendale generica.' },
        amount:         { type: 'number',  description: 'Importo totale EUR' },
        vendor:         { type: 'string',  description: 'Fornitore/venditore' },
        expense_date:   { type: 'string',  description: 'Data documento YYYY-MM-DD' },
        description:    { type: 'string',  description: 'Descrizione spesa' },
        category:       { type: 'string',  enum: ['materiali', 'manodopera', 'noli', 'trasporti', 'sicurezza', 'altro'], description: 'Categoria' },
        invoice_number: { type: 'string',  description: 'Numero fattura/ricevuta se presente' },
        payment_method: { type: 'string',  enum: ['contanti', 'bonifico', 'carta', 'assegno', 'altro'], description: 'Metodo pagamento' },
        image_note:     { type: 'string',  description: 'Nota sul documento analizzato' },
      },
      required: ['amount', 'description', 'category']
    }
  },
  {
    name: 'create_ddt_from_image',
    description: 'Registra DDT (Documento di Trasporto / bolla di consegna) estratto da foto nel cantiere.',
    input_schema: {
      type: 'object',
      properties: {
        site_id:     { type: 'string', description: 'UUID cantiere destinatario' },
        vendor:      { type: 'string', description: 'Mittente/Fornitore' },
        ddt_number:  { type: 'string', description: 'Numero DDT / bolla' },
        ddt_date:    { type: 'string', description: 'Data DDT YYYY-MM-DD' },
        description: { type: 'string', description: 'Descrizione merci trasportate' },
        amount:      { type: 'number', description: 'Importo se indicato (0 se assente)' },
        image_note:  { type: 'string', description: 'Note aggiuntive sul DDT' },
      },
      required: ['description']
    }
  },
  {
    name: 'archive_document_image',
    description: 'Archivia come nota strutturata un documento fotografato: verbale, ordine, lettera, certificato, planimetria, foto cantiere.',
    input_schema: {
      type: 'object',
      properties: {
        site_id:         { type: 'string', description: 'UUID cantiere associato' },
        title:           { type: 'string', description: 'Titolo descrittivo del documento' },
        doc_type:        { type: 'string', description: 'Tipo: verbale_cse | ordine | lettera | certificato | planimetria | contratto | foto_cantiere | altro' },
        doc_date:        { type: 'string', description: 'Data documento YYYY-MM-DD' },
        content_summary: { type: 'string', description: 'Riepilogo dettagliato del contenuto estratto dall\'immagine' },
        urgency:         { type: 'string', enum: ['bassa', 'media', 'alta'], description: 'Urgenza' },
      },
      required: ['title', 'doc_type', 'content_summary']
    }
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, companyId, userId) {
  const todayRome = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const fromUtc   = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

  try {
    switch (toolName) {

      case 'get_sites': {
        let q = supabase
          .from('sites')
          .select('id, name, status, address')
          .eq('company_id', companyId)
          .neq('status', 'eliminato')
          .limit(100);
        if (toolInput.status) q = q.eq('status', toolInput.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { sites: data, total: data.length };
      }

      case 'get_presence_today': {
        // Query senza join embedded — più robusta, non richiede FK definite in Supabase
        let q = supabase
          .from('presence_logs')
          .select('worker_id, site_id, event_type, timestamp_server')
          .eq('company_id', companyId)
          .gte('timestamp_server', fromUtc)
          .order('timestamp_server', { ascending: false })
          .limit(1000);
        if (toolInput.site_id) q = q.eq('site_id', toolInput.site_id);

        const { data: logs, error } = await q;
        if (error) return { error: error.message };

        // Filtra oggi (fuso Roma)
        const todayLogs = (logs || []).filter(p => {
          const d = new Date(p.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
          return d === todayRome;
        });

        // Ultimo evento per lavoratore
        const lastByWorker = new Map();
        for (const p of todayLogs) {
          if (!lastByWorker.has(p.worker_id)) lastByWorker.set(p.worker_id, p);
        }
        const presentEntries = [...lastByWorker.values()].filter(p => p.event_type === 'ENTRY');

        // Nomi lavoratori e cantieri in query separate
        const workerIds = presentEntries.map(p => p.worker_id);
        const siteIds   = [...new Set(presentEntries.map(p => p.site_id))];

        const [workersRes, sitesRes] = await Promise.all([
          workerIds.length > 0
            ? supabase.from('workers').select('id, full_name').in('id', workerIds)
            : Promise.resolve({ data: [] }),
          siteIds.length > 0
            ? supabase.from('sites').select('id, name').in('id', siteIds)
            : Promise.resolve({ data: [] }),
        ]);

        const workerMap = new Map((workersRes.data || []).map(w => [w.id, w.full_name]));
        const siteMap   = new Map((sitesRes.data   || []).map(s => [s.id, s.name]));

        const present = presentEntries.map(p => ({
          name:       workerMap.get(p.worker_id) ?? '—',
          site:       siteMap.get(p.site_id)     ?? '—',
          entry_time: new Date(p.timestamp_server).toLocaleTimeString('it-IT', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
          })
        }));

        return {
          date:                todayRome,
          present_count:       present.length,
          total_punches_today: todayLogs.length,
          present_workers:     present
        };
      }

      case 'get_workers': {
        let q = supabase
          .from('workers')
          .select('id, full_name, is_active')
          .eq('company_id', companyId);

        if (toolInput.active_only !== false) q = q.eq('is_active', true);

        if (toolInput.site_id) {
          const { data: ww } = await supabase
            .from('worksite_workers')
            .select('worker_id')
            .eq('company_id', companyId)
            .eq('site_id', toolInput.site_id)
            .eq('status', 'active');
          const ids = (ww || []).map(r => r.worker_id);
          if (ids.length === 0) return { workers: [], total: 0 };
          q = q.in('id', ids);
        }

        const { data, error } = await q.limit(200);
        if (error) return { error: error.message };
        return {
          workers: data.map(w => ({ id: w.id, name: w.full_name, active: w.is_active })),
          total: data.length
        };
      }

      case 'get_presence_history': {
        const from = new Date(toolInput.from_date + 'T00:00:00+02:00').toISOString();
        const to   = new Date(toolInput.to_date   + 'T23:59:59+01:00').toISOString();

        // Query senza join embedded
        let q = supabase
          .from('presence_logs')
          .select('worker_id, site_id, event_type, timestamp_server')
          .eq('company_id', companyId)
          .gte('timestamp_server', from)
          .lte('timestamp_server', to)
          .order('timestamp_server', { ascending: true })
          .limit(500);
        if (toolInput.site_id) q = q.eq('site_id', toolInput.site_id);

        const { data: logs, error } = await q;
        if (error) return { error: error.message };

        const allLogs = logs || [];
        const entries = allLogs.filter(p => p.event_type === 'ENTRY').length;
        const exits   = allLogs.filter(p => p.event_type === 'EXIT').length;

        // Nomi lavoratori e cantieri in query separate
        const workerIds = [...new Set(allLogs.map(p => p.worker_id))];
        const siteIds   = [...new Set(allLogs.map(p => p.site_id))];

        const [workersRes, sitesRes] = await Promise.all([
          workerIds.length > 0
            ? supabase.from('workers').select('id, full_name').in('id', workerIds)
            : Promise.resolve({ data: [] }),
          siteIds.length > 0
            ? supabase.from('sites').select('id, name').in('id', siteIds)
            : Promise.resolve({ data: [] }),
        ]);

        const workerMap = new Map((workersRes.data || []).map(w => [w.id, w.full_name]));
        const siteMap   = new Map((sitesRes.data   || []).map(s => [s.id, s.name]));

        return {
          from: toolInput.from_date,
          to:   toolInput.to_date,
          total_events: allLogs.length,
          entries,
          exits,
          logs: allLogs.slice(-50).map(p => ({
            worker: workerMap.get(p.worker_id) ?? '—',
            site:   siteMap.get(p.site_id)     ?? '—',
            type:   p.event_type,
            time:   new Date(p.timestamp_server).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })
          }))
        };
      }

      case 'get_kpi': {
        const [sitesRes, workersRes, presenceRes] = await Promise.all([
          supabase.from('sites').select('id, status').eq('company_id', companyId).limit(500),
          supabase.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
          // Solo campi scalari — no join embedded
          supabase.from('presence_logs').select('worker_id, event_type, timestamp_server')
            .eq('company_id', companyId).gte('timestamp_server', fromUtc)
            .order('timestamp_server', { ascending: false }).limit(1000)
        ]);

        const sites     = sitesRes.data || [];
        const todayLogs = (presenceRes.data || []).filter(p => {
          const d = new Date(p.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
          return d === todayRome;
        });
        const lastByWorker = new Map();
        for (const p of todayLogs) {
          if (!lastByWorker.has(p.worker_id)) lastByWorker.set(p.worker_id, p);
        }
        const presentCount = [...lastByWorker.values()].filter(p => p.event_type === 'ENTRY').length;

        return {
          sites_total:   sites.length,
          sites_active:  sites.filter(s => s.status === 'attivo').length,
          workers_total: workersRes.count ?? 0,
          present_today: presentCount,
          punches_today: todayLogs.length
        };
      }

      case 'get_economia': {
        const { site_id } = toolInput;
        if (!site_id) return { error: 'site_id obbligatorio. Chiama prima get_sites per trovare il cantiere.' };

        const [siteRes, vociRes] = await Promise.all([
          supabase.from('sites')
            .select('name, budget_totale, sal_percentuale')
            .eq('id', site_id)
            .eq('company_id', companyId)
            .maybeSingle(),
          supabase.from('site_economia_voci')
            .select('tipo, categoria, voce, importo, data_competenza')
            .eq('site_id', site_id)
            .eq('company_id', companyId)
            .order('data_competenza', { ascending: true })
            .limit(500),
        ]);

        if (!siteRes.data) return { error: 'Cantiere non trovato o non autorizzato.' };

        const site    = siteRes.data;
        const allVoci = vociRes.data || [];
        const costi   = allVoci.filter(v => v.tipo === 'costo');
        const ricavi  = allVoci.filter(v => v.tipo === 'ricavo');
        const totCosti  = costi.reduce((s, v)  => s + Number(v.importo), 0);
        const totRicavi = ricavi.reduce((s, v) => s + Number(v.importo), 0);
        const utile     = totRicavi - totCosti;

        // Breakdown per categoria
        const costiPerCat  = {};
        const ricaviPerCat = {};
        costi.forEach(v  => { costiPerCat[v.categoria]  = (costiPerCat[v.categoria]  || 0) + Number(v.importo); });
        ricavi.forEach(v => { ricaviPerCat[v.categoria] = (ricaviPerCat[v.categoria] || 0) + Number(v.importo); });

        // Velocità di spesa (ultimi 30 giorni)
        const thirtyAgo   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const recentSpend = costi.filter(v => v.data_competenza >= thirtyAgo).reduce((s, v) => s + Number(v.importo), 0);

        const result = {
          cantiere:           site.name,
          sal_percentuale:    Number(site.sal_percentuale || 0),
          totale_costi:       totCosti,
          totale_ricavi:      totRicavi,
          utile_lordo:        utile,
          margine_percentuale: totRicavi > 0 ? Math.round((utile / totRicavi) * 100) : null,
          n_voci_costi:       costi.length,
          n_voci_ricavi:      ricavi.length,
          costi_per_categoria:  costiPerCat,
          ricavi_per_categoria: ricaviPerCat,
          spesa_ultimi_30gg:  recentSpend,
        };

        if (site.budget_totale !== null && Number(site.budget_totale) > 0) {
          const budget = Number(site.budget_totale);
          result.budget_preventivo          = budget;
          result.budget_consumato_pct       = Math.round((totCosti / budget) * 100);
          result.budget_rimanente           = budget - totCosti;
          const salDec   = Number(site.sal_percentuale || 0) / 100;
          const spendDec = totCosti / budget;
          if (spendDec > salDec + 0.10) {
            result.alert_rischio = `SFORAMENTO: budget consumato al ${result.budget_consumato_pct}% con SAL al ${result.sal_percentuale}% — spesa superiore di ${Math.round((spendDec - salDec) * 100)} punti percentuali rispetto all'avanzamento.`;
          } else if (spendDec > salDec + 0.05) {
            result.attenzione = `Spesa leggermente anticipata rispetto al SAL (${result.budget_consumato_pct}% vs ${result.sal_percentuale}%). Monitorare.`;
          }
          // Proiezione: giorni al budget esaurito al ritmo attuale
          if (recentSpend > 0) {
            const dailyRate = recentSpend / 30;
            const remaining = budget - totCosti;
            if (remaining > 0) result.proiezione_giorni_al_budget_esaurito = Math.round(remaining / dailyRate);
          }
        }

        return result;
      }

      case 'navigate_to_page': {
        const { path, label } = toolInput;
        if (!path || !label) return { error: 'path e label obbligatori' };
        return { navigated: true, path, label };
      }

      case 'search_prezzario': {
        const { query, regione = 'liguria', anno, limit = 5 } = toolInput;
        if (!query) return { error: 'query obbligatoria' };

        const maxLimit = Math.min(parseInt(limit) || 5, 15);

        // Determina anno: richiesto o l'ultimo disponibile per la regione
        let targetAnno = anno ? parseInt(anno) : null;
        if (!targetAnno) {
          const { data: latest } = await supabase
            .from('prezzario_voci')
            .select('anno')
            .eq('regione', regione.toLowerCase())
            .order('anno', { ascending: false })
            .limit(1)
            .maybeSingle();
          targetAnno = latest?.anno || null;
        }

        if (!targetAnno) {
          return { error: `Nessun prezzario disponibile per la regione "${regione}". Regioni disponibili: liguria.` };
        }

        // Prova full-text search
        let { data, error } = await supabase
          .from('prezzario_voci')
          .select('codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli, note')
          .eq('regione', regione.toLowerCase())
          .eq('anno', targetAnno)
          .textSearch('descrizione_tsv', query, { type: 'plain', config: 'italian' })
          .limit(maxLimit);

        // Fallback ILIKE se FTS non trova nulla (query corta o stop-word)
        if (error || !data || data.length === 0) {
          const fallback = await supabase
            .from('prezzario_voci')
            .select('codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli, note')
            .eq('regione', regione.toLowerCase())
            .eq('anno', targetAnno)
            .ilike('descrizione', `%${query}%`)
            .limit(maxLimit);
          data = fallback.data || [];
        }

        return {
          fonte: `Prezzario Regione ${regione.charAt(0).toUpperCase() + regione.slice(1)} ${targetAnno}`,
          nota: 'Prezzi in € IVA esclusa. Verificare con fornitori locali prima di applicare.',
          voci: data,
          n_risultati: data.length,
        };
      }

      case 'get_company_prezzi': {
        const { query } = toolInput;
        if (!query) return { error: 'query obbligatoria' };

        // Prova full-text search
        let { data, error } = await supabase
          .from('company_prezzi')
          .select('descrizione, fornitore, um, prezzo, categoria, valid_from, valid_to, note')
          .eq('company_id', companyId)
          .textSearch('descrizione_tsv', query, { type: 'plain', config: 'italian' })
          .limit(10);

        // Fallback ILIKE
        if (error || !data || data.length === 0) {
          const fallback = await supabase
            .from('company_prezzi')
            .select('descrizione, fornitore, um, prezzo, categoria, valid_from, valid_to, note')
            .eq('company_id', companyId)
            .ilike('descrizione', `%${query}%`)
            .limit(10);
          data = fallback.data || [];
        }

        if (!data || data.length === 0) {
          return { found: false, message: 'Nessun prezzo fornitore trovato per questa ricerca. L\'azienda non ha ancora inserito prezzi personalizzati per questa voce.' };
        }

        return { found: true, prezzi: data, n_risultati: data.length };
      }

      // ── get_compliance_overview ────────────────────────────────────────────
      case 'get_compliance_overview': {
        const { filter = 'issues' } = toolInput;
        const { data: workers, error } = await supabase
          .from('workers')
          .select('id, full_name, role, qualification, is_active, safety_training_expiry, health_fitness_expiry')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .limit(500);
        if (error) return { error: error.message };

        const today2 = new Date(); today2.setHours(0, 0, 0, 0);
        const enriched = (workers || []).map(w => {
          const ss = complianceStatus(w.safety_training_expiry);
          const hs = complianceStatus(w.health_fitness_expiry);
          const ov = overallStatus(w);
          const sd = w.safety_training_expiry ? Math.ceil((new Date(w.safety_training_expiry) - today2) / 86400000) : null;
          const hd = w.health_fitness_expiry  ? Math.ceil((new Date(w.health_fitness_expiry)  - today2) / 86400000) : null;
          return { ...w, overall: ov, safetyStatus: ss, healthStatus: hs, safetyDays: sd, healthDays: hd };
        });

        let filtered = enriched;
        if (filter === 'issues')        filtered = enriched.filter(w => w.overall !== 'compliant' && w.overall !== 'inactive');
        else if (filter === 'expiring_90') filtered = enriched.filter(w => (w.safetyDays !== null && w.safetyDays <= 90) || (w.healthDays !== null && w.healthDays <= 90));
        else if (filter === 'non_compliant') filtered = enriched.filter(w => w.overall === 'non_compliant');

        return {
          totale:        enriched.length,
          conformi:      enriched.filter(w => w.overall === 'compliant').length,
          in_scadenza:   enriched.filter(w => w.overall === 'expiring').length,
          non_conformi:  enriched.filter(w => w.overall === 'non_compliant').length,
          incompleti:    enriched.filter(w => w.overall === 'incomplete').length,
          lavoratori: filtered.map(w => ({
            nome:       w.full_name,
            ruolo:      w.role,
            stato:      w.overall,
            formazione: { stato: w.safetyStatus, scadenza: w.safety_training_expiry, giorni: w.safetyDays },
            idoneita:   { stato: w.healthStatus,  scadenza: w.health_fitness_expiry,  giorni: w.healthDays },
          })),
        };
      }

      // ── get_worker_detail ──────────────────────────────────────────────────
      case 'get_worker_detail': {
        const { worker_name, worker_id } = toolInput;
        if (!worker_name && !worker_id) return { error: 'Specificare worker_name o worker_id' };

        let q = supabase
          .from('workers')
          .select('id, full_name, role, qualification, is_active, safety_training_expiry, health_fitness_expiry, hire_date, fiscal_code, birth_date, employer_name')
          .eq('company_id', companyId);

        if (worker_id) {
          q = q.eq('id', worker_id).limit(1);
        } else {
          q = q.ilike('full_name', `%${worker_name}%`).limit(3);
        }

        const { data: found, error: werr } = await q;
        if (werr) return { error: werr.message };
        if (!found || found.length === 0) return { error: `Nessun lavoratore trovato${worker_name ? ` per "${worker_name}"` : ''}` };

        const results = await Promise.all(found.map(async w => {
          const today3 = new Date(); today3.setHours(0,0,0,0);
          const ss = complianceStatus(w.safety_training_expiry);
          const hs = complianceStatus(w.health_fitness_expiry);

          const [docsRes, assignRes] = await Promise.all([
            supabase.from('worker_documents')
              .select('doc_type, name, issued_date, expiry_date, notes')
              .eq('worker_id', w.id)
              .order('expiry_date', { ascending: false })
              .limit(30),
            supabase.from('worksite_workers')
              .select('site_id, status, start_date')
              .eq('worker_id', w.id)
              .eq('company_id', companyId)
              .eq('status', 'active')
              .limit(10),
          ]);

          const siteIds = (assignRes.data || []).map(a => a.site_id);
          let siteNames = {};
          if (siteIds.length > 0) {
            const { data: sd } = await supabase.from('sites').select('id, name').in('id', siteIds);
            (sd || []).forEach(s => { siteNames[s.id] = s.name; });
          }

          return {
            id:           w.id,
            nome:         w.full_name,
            ruolo:        w.role,
            qualifica:    w.qualification,
            attivo:       w.is_active,
            codice_fiscale: w.fiscal_code,
            datore:       w.employer_name,
            compliance: {
              stato_globale: overallStatus(w),
              formazione: {
                stato:    ss,
                scadenza: w.safety_training_expiry,
                giorni_rimasti: w.safety_training_expiry ? Math.ceil((new Date(w.safety_training_expiry) - today3) / 86400000) : null,
              },
              idoneita_medica: {
                stato:    hs,
                scadenza: w.health_fitness_expiry,
                giorni_rimasti: w.health_fitness_expiry ? Math.ceil((new Date(w.health_fitness_expiry) - today3) / 86400000) : null,
              },
            },
            documenti: (docsRes.data || []).map(d => ({
              tipo:      d.doc_type,
              nome:      d.name,
              emesso:    d.issued_date,
              scadenza:  d.expiry_date,
              note:      d.notes,
            })),
            cantieri_attivi: (assignRes.data || []).map(a => ({
              nome: siteNames[a.site_id] || a.site_id,
              dal:  a.start_date,
            })),
          };
        }));

        return results.length === 1 ? results[0] : { lavoratori: results };
      }

      // ── get_upcoming_deadlines ─────────────────────────────────────────────
      case 'get_upcoming_deadlines': {
        const { days = 90, type = 'all' } = toolInput;
        const horizon = Math.min(parseInt(days) || 90, 365);
        const today4 = new Date(); today4.setHours(0,0,0,0);
        const deadlines = [];

        if (type === 'all' || type === 'formazione' || type === 'idoneita') {
          const { data: wkrs } = await supabase
            .from('workers')
            .select('full_name, role, safety_training_expiry, health_fitness_expiry')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .limit(500);

          (wkrs || []).forEach(w => {
            if ((type === 'all' || type === 'formazione') && w.safety_training_expiry) {
              const d = Math.ceil((new Date(w.safety_training_expiry) - today4) / 86400000);
              if (d <= horizon) deadlines.push({ tipo: 'Formazione sicurezza', soggetto: w.full_name, ruolo: w.role, scadenza: w.safety_training_expiry, giorni_rimasti: d, urgenza: d < 0 ? 'SCADUTA' : d <= 30 ? 'CRITICA' : 'ATTENZIONE' });
            }
            if ((type === 'all' || type === 'idoneita') && w.health_fitness_expiry) {
              const d = Math.ceil((new Date(w.health_fitness_expiry) - today4) / 86400000);
              if (d <= horizon) deadlines.push({ tipo: 'Idoneità medica', soggetto: w.full_name, ruolo: w.role, scadenza: w.health_fitness_expiry, giorni_rimasti: d, urgenza: d < 0 ? 'SCADUTA' : d <= 30 ? 'CRITICA' : 'ATTENZIONE' });
            }
          });
        }

        if (type === 'all' || type === 'mezzi') {
          const { data: equip } = await supabase
            .from('equipment')
            .select('type, model, plate_or_serial, insurance_expiry')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .limit(200);
          (equip || []).forEach(eq => {
            if (!eq.insurance_expiry) return;
            const d = Math.ceil((new Date(eq.insurance_expiry) - today4) / 86400000);
            if (d <= horizon) deadlines.push({ tipo: 'Assicurazione mezzo', soggetto: eq.model || eq.type, targa: eq.plate_or_serial, scadenza: eq.insurance_expiry, giorni_rimasti: d, urgenza: d < 0 ? 'SCADUTA' : d <= 30 ? 'CRITICA' : 'ATTENZIONE' });
          });
        }

        deadlines.sort((a, b) => a.giorni_rimasti - b.giorni_rimasti);
        return {
          orizzonte_giorni: horizon,
          totale:    deadlines.length,
          scadute:   deadlines.filter(d => d.giorni_rimasti < 0).length,
          critiche:  deadlines.filter(d => d.giorni_rimasti >= 0 && d.giorni_rimasti <= 30).length,
          attenzione: deadlines.filter(d => d.giorni_rimasti > 30).length,
          scadenze:  deadlines,
        };
      }

      // ── Nuovi tool (13-23) ──────────────────────────────────────────────────

      case 'get_subcontractors': {
        let subIds = null;
        if (toolInput.site_id) {
          const { data: assignments, error: aErr } = await supabase
            .from('site_subcontractors')
            .select('subcontractor_id')
            .eq('site_id', toolInput.site_id);
          if (aErr) return { error: aErr.message };
          subIds = (assignments || []).map(a => a.subcontractor_id);
          if (subIds.length === 0) return { subcontractors: [], total: 0 };
        }

        let q = supabase
          .from('subcontractors')
          .select('id, company_name, contact_person, contact_email, contact_phone, durc_expiry, insurance_expiry, soa_expiry, is_active')
          .eq('company_id', companyId);
        if (subIds) q = q.in('id', subIds);
        const { data, error } = await q;
        if (error) return { error: error.message };

        const subs = (data || []).map(s => {
          const semaphore = (expiry) => {
            if (!expiry) return 'N/D';
            const days = Math.ceil((new Date(expiry) - new Date(todayRome)) / 86400000);
            if (days < 0) return 'SCADUTO';
            if (days <= 30) return 'CRITICO';
            return 'OK';
          };
          return {
            ...s,
            durc_stato: semaphore(s.durc_expiry),
            assicurazione_stato: semaphore(s.insurance_expiry),
            soa_stato: semaphore(s.soa_expiry),
          };
        });
        return { subcontractors: subs, total: subs.length };
      }

      case 'get_equipment': {
        let eqIds = null;
        if (toolInput.site_id) {
          const { data: assignments, error: aErr } = await supabase
            .from('site_equipment')
            .select('equipment_id')
            .eq('site_id', toolInput.site_id);
          if (aErr) return { error: aErr.message };
          eqIds = (assignments || []).map(a => a.equipment_id);
          if (eqIds.length === 0) return { equipment: [], total: 0 };
        }

        let q = supabase
          .from('equipment')
          .select('id, name, type, plate_or_serial, model, status, insurance_expiry, is_active')
          .eq('company_id', companyId)
          .eq('is_active', true);
        if (eqIds) q = q.in('id', eqIds);
        const { data, error } = await q;
        if (error) return { error: error.message };

        const items = (data || []).map(e => {
          const daysToExpiry = e.insurance_expiry
            ? Math.ceil((new Date(e.insurance_expiry) - new Date(todayRome)) / 86400000)
            : null;
          return { ...e, giorni_scadenza_assicurazione: daysToExpiry };
        });
        return { equipment: items, total: items.length };
      }

      case 'get_expenses_summary': {
        let q = supabase
          .from('company_expenses')
          .select('id, amount, category, description, payment_method, paid_by, expense_date, supplier, site_id, is_deductible')
          .eq('company_id', companyId)
          .order('expense_date', { ascending: false });

        if (toolInput.site_id)   q = q.eq('site_id', toolInput.site_id);
        if (toolInput.from_date) q = q.gte('expense_date', toolInput.from_date);
        if (toolInput.to_date)   q = q.lte('expense_date', toolInput.to_date);
        if (toolInput.category)  q = q.eq('category', toolInput.category);

        const { data, error } = await q.limit(500);
        if (error) return { error: error.message };

        const rows = data || [];
        const byCategory = {};
        let total = 0;
        for (const r of rows) {
          total += Number(r.amount) || 0;
          const cat = r.category || 'altro';
          if (!byCategory[cat]) byCategory[cat] = { totale: 0, conteggio: 0 };
          byCategory[cat].totale += Number(r.amount) || 0;
          byCategory[cat].conteggio++;
        }
        return {
          totale_euro: Math.round(total * 100) / 100,
          conteggio: rows.length,
          per_categoria: byCategory,
          ultime_10: rows.slice(0, 10),
        };
      }

      case 'get_site_documents': {
        const { data: docs, error: dErr } = await supabase
          .from('site_documents')
          .select('id, doc_type, original_name, created_at, file_size')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId);
        if (dErr) return { error: dErr.message };

        const { data: posData } = await supabase
          .from('pos')
          .select('id, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .limit(1);

        const docTypes = (docs || []).map(d => d.doc_type);
        if (posData && posData.length > 0) docTypes.push('pos');

        const requiredTypes = ['pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione'];
        const checklist = requiredTypes.map(t => ({
          tipo: t,
          presente: docTypes.includes(t),
        }));

        return {
          documenti: docs || [],
          pos_presente: posData && posData.length > 0,
          checklist,
          mancanti: checklist.filter(c => !c.presente).map(c => c.tipo),
        };
      }

      case 'get_diary_entries': {
        const fromDate = toolInput.from_date || todayRome;
        const toDate   = toolInput.to_date || fromDate;

        const { data, error } = await supabase
          .from('site_diary_entries')
          .select('id, entry_date, weather_desc, temp_min, temp_max, precipitation_mm, activities, issues, decisions, notes, workers_snapshot, work_hours_total, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .gte('entry_date', fromDate)
          .lte('entry_date', toDate)
          .order('entry_date', { ascending: false })
          .limit(30);
        if (error) return { error: error.message };
        return { entries: data || [], total: (data || []).length, periodo: { da: fromDate, a: toDate } };
      }

      case 'get_risk_score': {
        const result = await computeRiskScore(toolInput.site_id, companyId);
        return result;
      }

      case 'get_inspection_shield': {
        const result = await generateInspectionShield(toolInput.site_id, companyId);
        return result;
      }

      case 'get_nonconformities': {
        const statusFilter = toolInput.status || 'open';
        let q = supabase
          .from('site_notes')
          .select('id, site_id, title, body, category, urgency, resolved_at, created_at')
          .eq('company_id', companyId)
          .eq('category', 'non_conformita')
          .order('created_at', { ascending: false })
          .limit(100);

        if (toolInput.site_id) q = q.eq('site_id', toolInput.site_id);
        if (statusFilter === 'open')   q = q.is('resolved_at', null);
        if (statusFilter === 'closed') q = q.not('resolved_at', 'is', null);

        const { data, error } = await q;
        if (error) return { error: error.message };

        // Arricchisci con nomi cantiere
        const siteIds = [...new Set((data || []).map(d => d.site_id).filter(Boolean))];
        let siteNames = {};
        if (siteIds.length > 0) {
          const { data: sites } = await supabase
            .from('sites')
            .select('id, name')
            .in('id', siteIds);
          siteNames = Object.fromEntries((sites || []).map(s => [s.id, s.name]));
        }

        const ncs = (data || []).map(nc => ({
          ...nc,
          cantiere: siteNames[nc.site_id] || nc.site_id,
        }));
        return { non_conformita: ncs, total: ncs.length, filtro: statusFilter };
      }

      case 'get_site_detail': {
        const { data: site, error } = await supabase
          .from('sites')
          .select('id, name, status, address, budget_totale, sal_percentuale, latitude, longitude, start_date, end_date, created_at, description, committente, rup, direttore_lavori, csp, cse')
          .eq('id', toolInput.site_id)
          .eq('company_id', companyId)
          .single();
        if (error) return { error: error.message };

        const { count: workerCount } = await supabase
          .from('worksite_workers')
          .select('id', { count: 'exact', head: true })
          .eq('site_id', toolInput.site_id)
          .eq('status', 'active');

        return { ...site, lavoratori_assegnati: workerCount || 0 };
      }

      case 'create_expense': {
        const row = {
          company_id:     companyId,
          amount:         toolInput.amount,
          category:       toolInput.category || 'altro',
          description:    toolInput.description,
          supplier:       toolInput.supplier || null,
          site_id:        toolInput.site_id || null,
          expense_date:   toolInput.expense_date || todayRome,
          payment_method: toolInput.payment_method || 'bonifico',
        };
        const { data, error } = await supabase
          .from('company_expenses')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, spesa_creata: data };
      }

      case 'create_site_note': {
        const row = {
          company_id: companyId,
          site_id:    toolInput.site_id,
          title:      toolInput.title,
          body:       toolInput.body || null,
          category:   toolInput.category || 'generale',
          urgency:    toolInput.urgency || 'media',
          user_id:    userId || null,
        };
        const { data, error } = await supabase
          .from('site_notes')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, nota_creata: data };
      }

      // ── 13 READ executors ────────────────────────────────────────────────────
      case 'get_site_phases': {
        const { data, error } = await supabase
          .from('site_phases')
          .select('id, nome, stato, progresso_percentuale, data_inizio_prevista, data_fine_prevista, data_inizio_reale, data_fine_reale, importo_contratto, importo_maturato, note, sort_order')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('sort_order');
        if (error) return { error: error.message };
        return { fasi: data || [], total: (data || []).length };
      }

      case 'get_sal_history': {
        const { data, error } = await supabase
          .from('site_sal_history')
          .select('id, sal_number, sal_percentuale, data_emissione, totale_contratto, importo_maturato, costo_mo, costi_diretti, totale_costi, margine, margine_percentuale, note, pagato_il')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('sal_number', { ascending: false });
        if (error) return { error: error.message };
        return { sal_records: data || [], total: (data || []).length };
      }

      case 'get_weather_log': {
        let q = supabase
          .from('site_weather_logs')
          .select('id, log_date, precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_desc, threshold_exceeded, threshold_reason, suspension_confirmed')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('log_date', { ascending: false })
          .limit(30);
        if (toolInput.from_date) q = q.gte('log_date', toolInput.from_date);
        if (toolInput.to_date)   q = q.lte('log_date', toolInput.to_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { weather: data || [], total: (data || []).length };
      }

      case 'get_suspension_days': {
        let q = supabase
          .from('site_suspension_days')
          .select('id, day, reason, notes, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('day', { ascending: false });
        if (toolInput.from_date) q = q.gte('day', toolInput.from_date);
        if (toolInput.to_date)   q = q.lte('day', toolInput.to_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const byReason = {};
        (data || []).forEach(d => { byReason[d.reason] = (byReason[d.reason] || 0) + 1; });
        return { sospensioni: data || [], total: (data || []).length, per_motivo: byReason };
      }

      case 'get_computo_voci': {
        const { data: computo } = await supabase
          .from('site_computo')
          .select('id, nome, fonte, totale_contratto, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!computo) return { error: 'Nessun computo metrico trovato per questo cantiere.' };
        const { data: voci, error } = await supabase
          .from('site_computo_voci')
          .select('codice, descrizione, unita_misura, quantita, prezzo_unitario, importo, sal_percentuale, tipo, sort_order')
          .eq('computo_id', computo.id)
          .order('sort_order');
        if (error) return { error: error.message };
        return { nome: computo.nome, totale_contratto: computo.totale_contratto, voci: voci || [], n_voci: (voci || []).length };
      }

      case 'get_site_costs': {
        let q = supabase
          .from('site_costs')
          .select('id, descrizione, fornitore, quantita, unita_misura, prezzo_unitario, importo, data_documento, tipo, numero_documento, note, pagato_il')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('data_documento', { ascending: false })
          .limit(500);
        if (toolInput.from_date) q = q.gte('data_documento', toolInput.from_date);
        if (toolInput.to_date)   q = q.lte('data_documento', toolInput.to_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const rows = data || [];
        let total = 0;
        const byTipo = {};
        for (const r of rows) {
          const amt = Number(r.importo) || 0;
          total += amt;
          const t = r.tipo || 'altro';
          if (!byTipo[t]) byTipo[t] = { totale: 0, conteggio: 0 };
          byTipo[t].totale += amt;
          byTipo[t].conteggio++;
        }
        return { totale_euro: Math.round(total * 100) / 100, conteggio: rows.length, per_tipo: byTipo, costi: rows.slice(0, 20) };
      }

      case 'get_subcontractor_documents': {
        const { data, error } = await supabase
          .from('subcontractor_documents')
          .select('id, name, category, valid_until, ai_summary, created_at')
          .eq('subcontractor_id', toolInput.subcontractor_id)
          .eq('company_id', companyId);
        if (error) return { error: error.message };
        const docs = (data || []).map(d => ({
          ...d,
          giorni_scadenza: d.valid_until ? Math.ceil((new Date(d.valid_until) - new Date(todayRome)) / 86400000) : null,
          stato: !d.valid_until ? 'N/D' : Math.ceil((new Date(d.valid_until) - new Date(todayRome)) / 86400000) < 0 ? 'SCADUTO' : Math.ceil((new Date(d.valid_until) - new Date(todayRome)) / 86400000) <= 30 ? 'CRITICO' : 'OK',
        }));
        return { documenti: docs, total: docs.length };
      }

      case 'get_coordinator_notes': {
        let q = supabase
          .from('site_coordinator_notes')
          .select('id, note_type, content, coordinator_name, is_read, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(50);
        if (toolInput.unread_only) q = q.eq('is_read', false);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const unreadCount = (data || []).filter(n => !n.is_read).length;
        return { note: data || [], total: (data || []).length, non_lette: unreadCount };
      }

      case 'get_coordinator_nonconformities': {
        const st = toolInput.status || 'aperta';
        let q = supabase
          .from('site_nonconformities')
          .select('id, coordinator_name, title, description, category, severity, status, due_date, resolution_notes, created_at, resolved_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('created_at', { ascending: false });
        if (st !== 'all') q = q.eq('status', st);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { non_conformita: data || [], total: (data || []).length, filtro: st };
      }

      case 'get_worker_certificates': {
        let workerIds = null;
        if (toolInput.worker_id) {
          workerIds = [toolInput.worker_id];
        } else if (toolInput.worker_name) {
          const { data: found } = await supabase.from('workers').select('id').eq('company_id', companyId).ilike('full_name', `%${toolInput.worker_name}%`).limit(5);
          workerIds = (found || []).map(w => w.id);
          if (workerIds.length === 0) return { error: `Nessun lavoratore trovato per "${toolInput.worker_name}"` };
        }
        let q = supabase
          .from('worker_certificates')
          .select('id, worker_id, issue_date, expiry_date, issuing_body, certificate_number, course_types(name, validity_years, mandatory_for_construction)')
          .eq('company_id', companyId);
        if (workerIds) q = q.in('worker_id', workerIds);
        const { data, error } = await q.limit(200);
        if (error) return { error: error.message };
        const certs = (data || []).map(c => {
          const days = c.expiry_date ? Math.ceil((new Date(c.expiry_date) - new Date(todayRome)) / 86400000) : null;
          return { ...c, corso: c.course_types?.name || 'N/D', giorni_scadenza: days, stato: days === null ? 'N/D' : days < 0 ? 'SCADUTO' : days <= 30 ? 'CRITICO' : days <= 90 ? 'ATTENZIONE' : 'OK' };
        });
        let filtered = certs;
        if (toolInput.expiring_within_days) {
          filtered = certs.filter(c => c.giorni_scadenza !== null && c.giorni_scadenza <= toolInput.expiring_within_days);
        }
        // Enrich with worker names
        const wIds = [...new Set(filtered.map(c => c.worker_id))];
        let wNames = {};
        if (wIds.length > 0) {
          const { data: ws } = await supabase.from('workers').select('id, full_name').in('id', wIds);
          (ws || []).forEach(w => { wNames[w.id] = w.full_name; });
        }
        filtered.forEach(c => { c.lavoratore = wNames[c.worker_id] || c.worker_id; });
        return { attestati: filtered, total: filtered.length };
      }

      case 'get_worker_hours': {
        if (!toolInput.worker_id || !toolInput.from_date || !toolInput.to_date) return { error: 'worker_id, from_date e to_date obbligatori' };
        const from = new Date(toolInput.from_date + 'T00:00:00+02:00').toISOString();
        const to   = new Date(toolInput.to_date   + 'T23:59:59+01:00').toISOString();
        const { data: logs, error } = await supabase
          .from('presence_logs')
          .select('event_type, timestamp_server, site_id')
          .eq('worker_id', toolInput.worker_id)
          .eq('company_id', companyId)
          .gte('timestamp_server', from)
          .lte('timestamp_server', to)
          .order('timestamp_server', { ascending: true })
          .limit(1000);
        if (error) return { error: error.message };
        const byDate = {};
        for (const log of (logs || [])) {
          const d = new Date(log.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
          if (!byDate[d]) byDate[d] = [];
          byDate[d].push(log);
        }
        let totalHours = 0;
        const daily = Object.entries(byDate).map(([date, dayLogs]) => {
          const entries = dayLogs.filter(l => l.event_type === 'ENTRY');
          const exits   = dayLogs.filter(l => l.event_type === 'EXIT');
          let hours = 0;
          const pairs = Math.min(entries.length, exits.length);
          for (let i = 0; i < pairs; i++) {
            const diff = (new Date(exits[i].timestamp_server) - new Date(entries[i].timestamp_server)) / 3_600_000;
            if (diff > 0) hours += diff;
          }
          hours = Math.round(hours * 10) / 10;
          totalHours += hours;
          return { date, ore: hours, timbrature: dayLogs.length };
        });
        const { data: worker } = await supabase.from('workers').select('full_name').eq('id', toolInput.worker_id).maybeSingle();
        return { lavoratore: worker?.full_name || toolInput.worker_id, periodo: { da: toolInput.from_date, a: toolInput.to_date }, totale_ore: Math.round(totalHours * 10) / 10, giorni_lavorati: daily.filter(d => d.ore > 0).length, dettaglio: daily };
      }

      case 'get_company_documents': {
        const { data, error } = await supabase
          .from('company_documents')
          .select('id, name, category, file_size, created_at')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false });
        if (error) return { error: error.message };
        const byCategory = {};
        (data || []).forEach(d => {
          if (!byCategory[d.category]) byCategory[d.category] = [];
          byCategory[d.category].push(d);
        });
        return { documenti: data || [], total: (data || []).length, per_categoria: byCategory };
      }

      case 'get_capitolato_voci': {
        const { data, error } = await supabase
          .from('capitolato_voci')
          .select('id, codice, categoria, descrizione, unita_misura, quantita, prezzo_unitario, importo_contratto, sort_order')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .order('sort_order');
        if (error) return { error: error.message };
        const byCategoria = {};
        let totale = 0;
        (data || []).forEach(v => {
          if (!byCategoria[v.categoria]) byCategoria[v.categoria] = [];
          byCategoria[v.categoria].push(v);
          totale += Number(v.importo_contratto) || 0;
        });
        return { voci: data || [], total: (data || []).length, totale_contratto: Math.round(totale * 100) / 100, per_categoria: Object.keys(byCategoria).map(k => ({ categoria: k, n_voci: byCategoria[k].length, importo: byCategoria[k].reduce((s, v) => s + (Number(v.importo_contratto) || 0), 0) })) };
      }

      // ── 10 WRITE executors ───────────────────────────────────────────────────
      case 'create_worker': {
        if (!toolInput.full_name) return { error: 'full_name obbligatorio' };
        const badge_code = crypto.randomBytes(9).toString('hex').toUpperCase();
        const row = {
          company_id: companyId,
          full_name: toolInput.full_name,
          badge_code,
          is_active: true,
          fiscal_code: toolInput.fiscal_code || null,
          role: toolInput.role || null,
          qualification: toolInput.qualification || null,
          employer_name: toolInput.employer_name || null,
        };
        const { data, error } = await supabase.from('workers').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, lavoratore_creato: data };
      }

      case 'update_worker_expiry': {
        let wId = toolInput.worker_id;
        if (!wId && toolInput.worker_name) {
          const { data: found } = await supabase.from('workers').select('id, full_name').eq('company_id', companyId).ilike('full_name', `%${toolInput.worker_name}%`).limit(1);
          if (!found || found.length === 0) return { error: `Nessun lavoratore trovato per "${toolInput.worker_name}"` };
          wId = found[0].id;
        }
        if (!wId) return { error: 'Specificare worker_id o worker_name' };
        const patch = {};
        if (toolInput.safety_training_expiry) patch.safety_training_expiry = toolInput.safety_training_expiry;
        if (toolInput.health_fitness_expiry)  patch.health_fitness_expiry  = toolInput.health_fitness_expiry;
        if (Object.keys(patch).length === 0) return { error: 'Nessuna scadenza da aggiornare specificata' };
        const { data, error } = await supabase.from('workers').update(patch).eq('id', wId).eq('company_id', companyId).select('id, full_name, safety_training_expiry, health_fitness_expiry').single();
        if (error) return { error: error.message };
        return { success: true, lavoratore_aggiornato: data };
      }

      case 'assign_worker_to_site': {
        const { data: existing } = await supabase.from('worksite_workers').select('id').eq('worker_id', toolInput.worker_id).eq('site_id', toolInput.site_id).eq('status', 'active').maybeSingle();
        if (existing) return { success: true, message: 'Lavoratore gia assegnato a questo cantiere.' };
        const { data, error } = await supabase.from('worksite_workers').insert({ company_id: companyId, site_id: toolInput.site_id, worker_id: toolInput.worker_id, status: 'active', start_date: todayRome }).select().single();
        if (error) return { error: error.message };
        return { success: true, assegnazione_creata: data };
      }

      case 'create_site': {
        if (!toolInput.name) return { error: 'name obbligatorio' };
        const row = {
          company_id: companyId,
          name: toolInput.name,
          status: 'attivo',
          address: toolInput.address || null,
          start_date: toolInput.start_date || null,
          end_date: toolInput.end_date || null,
          budget_totale: toolInput.budget_totale || null,
        };
        const { data, error } = await supabase.from('sites').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, cantiere_creato: data };
      }

      case 'update_site': {
        if (!toolInput.site_id) return { error: 'site_id obbligatorio' };
        const patch = {};
        ['name', 'address', 'status', 'start_date', 'end_date', 'budget_totale', 'sal_percentuale'].forEach(k => {
          if (toolInput[k] !== undefined && toolInput[k] !== null) patch[k] = toolInput[k];
        });
        if (Object.keys(patch).length === 0) return { error: 'Nessun campo da aggiornare specificato' };
        const { data, error } = await supabase.from('sites').update(patch).eq('id', toolInput.site_id).eq('company_id', companyId).select().single();
        if (error) return { error: error.message };
        return { success: true, cantiere_aggiornato: data };
      }

      case 'create_diary_entry': {
        if (!toolInput.site_id) return { error: 'site_id obbligatorio' };
        const row = {
          company_id: companyId,
          site_id: toolInput.site_id,
          entry_date: toolInput.entry_date || todayRome,
          created_by: userId || null,
          updated_at: new Date().toISOString(),
        };
        if (toolInput.activities) row.activities = toolInput.activities;
        if (toolInput.notes)      row.notes      = toolInput.notes;
        if (toolInput.issues)     row.issues     = toolInput.issues;
        if (toolInput.decisions)  row.decisions  = toolInput.decisions;
        if (toolInput.materials)  row.materials  = toolInput.materials;
        const { data, error } = await supabase.from('site_diary_entries').upsert(row, { onConflict: 'site_id,entry_date' }).select().single();
        if (error) return { error: error.message };
        return { success: true, diario_salvato: data };
      }

      case 'create_booking': {
        if (!toolInput.site_id || !toolInput.title || !toolInput.booking_date) return { error: 'site_id, title e booking_date obbligatori' };
        const { data, error } = await supabase.from('site_bookings').insert({
          company_id:   companyId,
          site_id:      toolInput.site_id,
          title:        toolInput.title,
          booking_date: toolInput.booking_date,
          booking_time: toolInput.booking_time || null,
          category:     toolInput.category || 'consegna',
          supplier:     toolInput.supplier || null,
          notes:        toolInput.notes || null,
          status:       'programmata',
        }).select().single();
        if (error) return { error: error.message };
        return { success: true, prenotazione_salvata: data };
      }

      case 'create_suspension_day': {
        if (!toolInput.site_id || !toolInput.day) return { error: 'site_id e day obbligatori' };
        const { data, error } = await supabase.from('site_suspension_days').upsert({
          company_id: companyId,
          site_id: toolInput.site_id,
          day: toolInput.day,
          reason: toolInput.reason || 'altro',
          notes: toolInput.notes || null,
          created_by: userId || null,
        }, { onConflict: 'site_id,day' }).select().single();
        if (error) return { error: error.message };
        return { success: true, sospensione_registrata: data };
      }

      case 'update_sal': {
        if (!toolInput.site_id) return { error: 'site_id obbligatorio' };
        const pct = Number(toolInput.sal_percentuale);
        if (isNaN(pct) || pct < 0 || pct > 100) return { error: 'sal_percentuale deve essere tra 0 e 100' };
        const { data, error } = await supabase.from('sites').update({ sal_percentuale: pct }).eq('id', toolInput.site_id).eq('company_id', companyId).select('id, name, sal_percentuale').single();
        if (error) return { error: error.message };
        return { success: true, cantiere_aggiornato: data };
      }

      case 'create_phase': {
        if (!toolInput.site_id || !toolInput.nome) return { error: 'site_id e nome obbligatori' };
        const row = {
          company_id: companyId,
          site_id: toolInput.site_id,
          nome: toolInput.nome,
          stato: 'non_iniziata',
          progresso_percentuale: 0,
          data_inizio_prevista: toolInput.data_inizio_prevista || null,
          data_fine_prevista: toolInput.data_fine_prevista || null,
          note: toolInput.note || null,
        };
        const { data, error } = await supabase.from('site_phases').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, fase_creata: data };
      }

      case 'update_phase': {
        let phaseId = toolInput.phase_id;
        if (!phaseId && toolInput.site_id && toolInput.nome) {
          const { data: found } = await supabase.from('site_phases').select('id').eq('site_id', toolInput.site_id).eq('company_id', companyId).ilike('nome', `%${toolInput.nome}%`).limit(1);
          if (!found || found.length === 0) return { error: `Nessuna fase trovata per "${toolInput.nome}"` };
          phaseId = found[0].id;
        }
        if (!phaseId) return { error: 'Specificare phase_id oppure site_id + nome della fase' };
        const patch = {};
        ['stato', 'progresso_percentuale', 'data_inizio_reale', 'data_fine_reale', 'note'].forEach(k => {
          if (toolInput[k] !== undefined && toolInput[k] !== null) patch[k] = toolInput[k];
        });
        if (Object.keys(patch).length === 0) return { error: 'Nessun campo da aggiornare specificato' };
        const { data, error } = await supabase.from('site_phases').update(patch).eq('id', phaseId).eq('company_id', companyId).select().single();
        if (error) return { error: error.message };
        return { success: true, fase_aggiornata: data };
      }

      // ── Nuovi tool executor — copertura completa cantiere ─────────────────────

      case 'get_weather_forecast': {
        const { data: site } = await supabase
          .from('sites')
          .select('name, latitude, longitude')
          .eq('id', toolInput.site_id)
          .eq('company_id', companyId)
          .maybeSingle();
        if (!site) return { error: 'Cantiere non trovato.' };
        if (!site.latitude || !site.longitude) return { error: `Il cantiere "${site.name}" non ha coordinate GPS configurate. Impostale dalla scheda cantiere per attivare le previsioni meteo.` };
        try {
          const { getForecast } = require('../../services/weatherService');
          const forecast = await getForecast(site.latitude, site.longitude);
          return { cantiere: site.name, previsioni: forecast };
        } catch (e) {
          return { error: 'Servizio meteo temporaneamente non disponibile: ' + e.message };
        }
      }

      case 'create_economia_voce': {
        const row = {
          company_id: companyId,
          site_id: toolInput.site_id,
          tipo: toolInput.tipo,
          categoria: toolInput.categoria || 'altro',
          voce: toolInput.voce,
          importo: toolInput.importo,
          data_competenza: toolInput.data_competenza || todayRome,
        };
        const { data, error } = await supabase
          .from('site_economia_voci')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, voce_creata: data };
      }

      case 'resolve_nonconformity': {
        const { data: existing } = await supabase
          .from('site_notes')
          .select('id, resolved_at')
          .eq('id', toolInput.nc_id)
          .eq('company_id', companyId)
          .eq('category', 'non_conformita')
          .maybeSingle();
        if (!existing) return { error: 'Non conformità non trovata.' };
        if (existing.resolved_at) return { success: true, message: 'Questa NC era già stata risolta.' };
        const patch = {
          resolved_at: new Date().toISOString(),
          resolved_by: userId || null,
        };
        if (toolInput.resolution_notes) patch.body = (existing.body ? existing.body + '\n\n' : '') + `[RISOLUZIONE] ${toolInput.resolution_notes}`;
        const { data, error } = await supabase
          .from('site_notes')
          .update(patch)
          .eq('id', toolInput.nc_id)
          .eq('company_id', companyId)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, nc_risolta: data };
      }

      case 'create_site_cost': {
        const row = {
          company_id: companyId,
          site_id: toolInput.site_id,
          descrizione: toolInput.descrizione,
          importo: toolInput.importo,
          fornitore: toolInput.fornitore || null,
          tipo: toolInput.tipo || 'fattura',
          numero_documento: toolInput.numero_documento || null,
          data_documento: toolInput.data_documento || todayRome,
          note: toolInput.note || null,
        };
        const { data, error } = await supabase
          .from('site_costs')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, costo_registrato: data };
      }

      case 'remove_worker_from_site': {
        const { data, error } = await supabase
          .from('worksite_workers')
          .update({ status: 'inactive' })
          .eq('worker_id', toolInput.worker_id)
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .eq('status', 'active')
          .select()
          .single();
        if (error) return { error: error.message || 'Assegnazione non trovata.' };
        return { success: true, message: 'Lavoratore rimosso dal cantiere.' };
      }

      case 'create_subcontractor': {
        const row = {
          company_id: companyId,
          company_name: toolInput.company_name,
          contact_person: toolInput.contact_person || null,
          contact_email: toolInput.contact_email || null,
          contact_phone: toolInput.contact_phone || null,
          durc_expiry: toolInput.durc_expiry || null,
          insurance_expiry: toolInput.insurance_expiry || null,
          soa_expiry: toolInput.soa_expiry || null,
          is_active: true,
        };
        const { data, error } = await supabase
          .from('subcontractors')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, subappaltatore_creato: data };
      }

      case 'assign_subcontractor_to_site': {
        const { data: existing } = await supabase
          .from('site_subcontractors')
          .select('id')
          .eq('subcontractor_id', toolInput.subcontractor_id)
          .eq('site_id', toolInput.site_id)
          .maybeSingle();
        if (existing) return { success: true, message: 'Subappaltatore già assegnato a questo cantiere.' };
        const { data, error } = await supabase
          .from('site_subcontractors')
          .insert({
            subcontractor_id: toolInput.subcontractor_id,
            site_id: toolInput.site_id,
            company_id: companyId,
          })
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, assegnazione_creata: data };
      }

      case 'create_equipment': {
        const row = {
          company_id: companyId,
          name: toolInput.name,
          type: toolInput.type || null,
          model: toolInput.model || null,
          plate_or_serial: toolInput.plate_or_serial || null,
          insurance_expiry: toolInput.insurance_expiry || null,
          is_active: true,
          status: 'disponibile',
        };
        const { data, error } = await supabase
          .from('equipment')
          .insert(row)
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, mezzo_creato: data };
      }

      case 'assign_equipment_to_site': {
        const { data: existing } = await supabase
          .from('site_equipment')
          .select('id')
          .eq('equipment_id', toolInput.equipment_id)
          .eq('site_id', toolInput.site_id)
          .maybeSingle();
        if (existing) return { success: true, message: 'Mezzo già assegnato a questo cantiere.' };
        const { data, error } = await supabase
          .from('site_equipment')
          .insert({
            equipment_id: toolInput.equipment_id,
            site_id: toolInput.site_id,
            company_id: companyId,
          })
          .select()
          .single();
        if (error) return { error: error.message };
        return { success: true, assegnazione_creata: data };
      }

      case 'get_payslips': {
        let workerIds = null;
        if (toolInput.worker_id) {
          workerIds = [toolInput.worker_id];
        } else if (toolInput.worker_name) {
          const { data: found } = await supabase
            .from('workers')
            .select('id')
            .eq('company_id', companyId)
            .ilike('full_name', `%${toolInput.worker_name}%`)
            .limit(5);
          workerIds = (found || []).map(w => w.id);
          if (workerIds.length === 0) return { error: `Nessun lavoratore trovato per "${toolInput.worker_name}"` };
        }

        let q = supabase
          .from('payslips')
          .select('id, worker_id, month, original_name, file_size, created_at')
          .eq('company_id', companyId)
          .order('month', { ascending: false })
          .limit(50);
        if (workerIds) q = q.in('worker_id', workerIds);
        if (toolInput.month) q = q.eq('month', toolInput.month);

        const { data, error } = await q;
        if (error) return { error: error.message };

        const wIds = [...new Set((data || []).map(p => p.worker_id))];
        let wNames = {};
        if (wIds.length > 0) {
          const { data: ws } = await supabase.from('workers').select('id, full_name').in('id', wIds);
          (ws || []).forEach(w => { wNames[w.id] = w.full_name; });
        }
        const cedolini = (data || []).map(p => ({
          ...p,
          lavoratore: wNames[p.worker_id] || p.worker_id,
        }));
        return { cedolini, total: cedolini.length };
      }

      case 'get_site_bookings': {
        const fromDate = toolInput.from_date || todayRome;
        const toDate = toolInput.to_date || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from('site_bookings')
          .select('id, title, booking_date, booking_time, category, supplier, notes, status, created_at')
          .eq('site_id', toolInput.site_id)
          .eq('company_id', companyId)
          .gte('booking_date', fromDate)
          .lte('booking_date', toDate)
          .order('booking_date', { ascending: true });
        if (error) return { error: error.message };
        return { prenotazioni: data || [], total: (data || []).length, periodo: { da: fromDate, a: toDate } };
      }

      // ── Image processing tools ──────────────────────────────────────────────

      case 'create_expense_from_image': {
        const row = {
          company_id:     companyId,
          amount:         toolInput.amount,
          category:       toolInput.category || 'altro',
          description:    toolInput.description + (toolInput.image_note ? ` [${toolInput.image_note}]` : ''),
          supplier:       toolInput.vendor || null,
          site_id:        toolInput.site_id || null,
          expense_date:   toolInput.expense_date || todayRome,
          payment_method: toolInput.payment_method || 'altro',
        };
        const { data, error } = await supabase.from('company_expenses').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, spesa_creata: data, messaggio: `Spesa di €${toolInput.amount} da "${toolInput.vendor || 'fornitore'}" registrata correttamente.` };
      }

      case 'create_ddt_from_image': {
        const row = {
          company_id:       companyId,
          site_id:          toolInput.site_id || null,
          descrizione:      toolInput.description + (toolInput.image_note ? ` — ${toolInput.image_note}` : ''),
          importo:          toolInput.amount || 0,
          fornitore:        toolInput.vendor || null,
          tipo:             'ddt',
          numero_documento: toolInput.ddt_number || null,
          data_documento:   toolInput.ddt_date || todayRome,
          note:             toolInput.image_note || null,
        };
        const { data, error } = await supabase.from('site_costs').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, ddt_registrato: data, messaggio: `DDT${toolInput.ddt_number ? ' n.' + toolInput.ddt_number : ''} da "${toolInput.vendor || 'mittente'}" registrato correttamente.` };
      }

      case 'archive_document_image': {
        const row = {
          company_id: companyId,
          site_id:    toolInput.site_id || null,
          title:      toolInput.title,
          body:       `[${toolInput.doc_type?.toUpperCase() || 'DOCUMENTO'}] ${toolInput.content_summary}`,
          category:   'documento',
          urgency:    toolInput.urgency || 'media',
          user_id:    userId || null,
        };
        const { data, error } = await supabase.from('site_notes').insert(row).select().single();
        if (error) return { error: error.message };
        return { success: true, documento_archiviato: data, messaggio: `Documento "${toolInput.title}" archiviato correttamente.` };
      }

      default:
        return { error: 'Tool non riconosciuto: ' + toolName };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Agentic loop con company_id (chat principale) ────────────────────────────
// systemPrompt: system prompt arricchito con company brain (o SYSTEM_PROMPT base)
async function runChatLoop(client, messages, companyId, model, systemPrompt = SYSTEM_PROMPT, userId = null) {
  let response = await client.messages.create({
    model,
    max_tokens: model === MODEL_SONNET ? 4096 : 1024,
    system:     systemPrompt,
    tools:      TOOLS,
    messages,
  });

  const extra = [];
  let iter = 0;

  while (response.stop_reason === 'tool_use' && iter < 6) {
    iter++;
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     JSON.stringify(await executeTool(block.name, block.input, companyId, userId))
      }))
    );

    extra.push(
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults }
    );

    response = await client.messages.create({
      model,
      max_tokens: model === MODEL_SONNET ? 4096 : 1024,
      system:     systemPrompt,
      tools:      TOOLS,
      messages:   [...messages, ...extra],
    });
  }

  return response.content.find(b => b.type === 'text')?.text ?? 'Non sono riuscito a elaborare la risposta.';
}

// ── Struttura JSON per report (export) ───────────────────────────────────────
async function buildReportJson(messages, client) {
  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system:     REPORT_SYSTEM_PROMPT,
    messages: [
      ...messages.slice(-8),
      { role: 'user', content: 'Struttura questa conversazione come report JSON professionale.' }
    ],
  });

  const raw = response.content.find(b => b.type === 'text')?.text ?? '{}';
  // Estrai il primo blocco JSON valido anche se Claude aggiunge testo fuori
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Struttura JSON non trovata nella risposta AI.');
  return JSON.parse(match[0]);
}

// ── PDF HTML template ─────────────────────────────────────────────────────────
function buildReportHtml(report) {
  const now = new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Rome'
  });

  const kpisHtml = report.kpis && report.kpis.length
    ? `<div class="kpi-grid">
        ${report.kpis.slice(0, 4).map(k => `
          <div class="kpi-card">
            <div class="kpi-value">${esc(k.value)}</div>
            <div class="kpi-label">${esc(k.label)}</div>
          </div>`).join('')}
       </div>`
    : '';

  const sectionsHtml = (report.sections || []).map(s => {
    const tableHtml = s.table && s.table.headers && s.table.rows
      ? `<table>
           <thead><tr>${s.table.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
           <tbody>${s.table.rows.map(row =>
              `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`
            ).join('')}</tbody>
         </table>`
      : '';

    return `<div class="section">
      <div class="section-title">${esc(s.title)}</div>
      ${s.text ? `<p class="section-text">${esc(s.text).replace(/\n/g, '<br>')}</p>` : ''}
      ${tableHtml}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  @page {
    size: A4;
    margin: 26mm 0 24mm 0;
  }

  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    color: #1a1a1a;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .doc {
    padding: 0 16mm;
  }

  /* ── Intestazione report ─────────────────────────────── */
  .report-header {
    background: #000;
    color: #fff;
    padding: 18px 16mm 20px;
    margin: 0 -16mm 24px;
    page-break-after: avoid;
  }

  .report-brand {
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 2.5px;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 10px;
  }

  .report-title {
    font-size: 19px;
    font-weight: 700;
    color: #fff;
    line-height: 1.25;
    margin-bottom: 5px;
  }

  .report-subtitle {
    font-size: 11px;
    color: #999;
    line-height: 1.4;
  }

  .report-meta {
    font-size: 10px;
    color: #555;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #222;
  }

  /* ── Sommario ─────────────────────────────────────────── */
  .summary {
    background: #f7f7f7;
    border-left: 3px solid #000;
    border-radius: 0 4px 4px 0;
    padding: 12px 14px;
    margin-bottom: 22px;
    font-size: 11px;
    line-height: 1.65;
    color: #333;
    page-break-inside: avoid;
  }

  /* ── KPI grid ─────────────────────────────────────────── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 24px;
    page-break-inside: avoid;
  }

  .kpi-card {
    border: 1px solid #e8e8e8;
    border-radius: 6px;
    padding: 11px 13px;
  }

  .kpi-value {
    font-size: 22px;
    font-weight: 700;
    color: #000;
    line-height: 1;
    margin-bottom: 4px;
  }

  .kpi-label {
    font-size: 9.5px;
    color: #888;
    line-height: 1.3;
  }

  /* ── Sezioni ──────────────────────────────────────────── */
  .section {
    margin-bottom: 26px;
  }

  .section-title {
    font-size: 10.5px;
    font-weight: 700;
    color: #000;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    padding-bottom: 5px;
    border-bottom: 1.5px solid #000;
    margin-bottom: 11px;
    page-break-after: avoid;
  }

  .section-text {
    font-size: 11px;
    line-height: 1.65;
    color: #444;
    margin-bottom: 11px;
  }

  /* ── Tabelle ──────────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    margin-bottom: 4px;
    page-break-inside: auto;
  }

  thead tr { page-break-after: avoid; }

  th {
    background: #000;
    color: #fff;
    padding: 7px 10px;
    text-align: left;
    font-weight: 600;
    font-size: 9.5px;
    letter-spacing: 0.2px;
  }

  td {
    padding: 6px 10px;
    border-bottom: 1px solid #efefef;
    color: #2a2a2a;
    vertical-align: top;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  tbody tr:nth-child(even) td { background: #f9f9f9; }
  tbody tr:last-child td { border-bottom: none; }

  /* ── Piè di pagina documento ──────────────────────────── */
  .doc-footer {
    font-size: 9px;
    color: #ccc;
    text-align: center;
    margin-top: 36px;
    padding-top: 10px;
    border-top: 1px solid #f0f0f0;
  }
</style>
</head>
<body>
<div class="doc">

  <div class="report-header">
    <div class="report-brand">Palladia &middot; Report Pal IA</div>
    <div class="report-title">${esc(report.title || 'Report')}</div>
    ${report.subtitle ? `<div class="report-subtitle">${esc(report.subtitle)}</div>` : ''}
    <div class="report-meta">Generato il ${esc(now)} &middot; Palladia</div>
  </div>

  ${report.summary ? `<div class="summary">${esc(report.summary).replace(/\n/g, '<br>')}</div>` : ''}

  ${kpisHtml}

  ${sectionsHtml}

  <div class="doc-footer">Generato da Pal &middot; Assistente IA Palladia &middot; Dati aggiornati al momento della generazione</div>
</div>
</body>
</html>`;
}

// ── Excel workbook (ExcelJS — styled) ────────────────────────────────────────
async function buildReportExcel(report) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();

  const ws = wb.addWorksheet('Report');

  const now = new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome',
  });

  const NAVY   = { argb: 'FF1E3A5F' };
  const ACCENT = { argb: 'FF334E7C' };
  const WHITE  = { argb: 'FFFFFFFF' };
  const LIGHT  = { argb: 'FFF8FAFC' };
  const GRAY   = { argb: 'FF6B7280' };
  const MERGE_COLS = 8; // merge orizzontale max colonne

  // Calcola larghezze colonne in base al contenuto delle tabelle
  const colWidths = Array(MERGE_COLS).fill(14);
  colWidths[0] = 36;

  function mergeRow(rowNum) {
    try { ws.mergeCells(rowNum, 1, rowNum, MERGE_COLS); } catch (_e) { /* merge errors ignored */ }
  }

  function addBanner(text, size = 13) {
    const r = ws.addRow([text]);
    r.height = 28;
    const c = r.getCell(1);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: NAVY };
    c.font = { bold: true, color: WHITE, size, name: 'Calibri' };
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    mergeRow(r.number);
  }

  function addMeta(text, bg = 'FFE8EDF3', italic = false) {
    const r = ws.addRow([text]);
    r.height = 17;
    const c = r.getCell(1);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    c.font = { size: 9.5, name: 'Calibri', italic, color: { argb: italic ? 'FF374151' : GRAY.argb } };
    c.alignment = { vertical: 'middle', indent: 1, wrapText: false };
    mergeRow(r.number);
  }

  function addSection(text) {
    const r = ws.addRow([text]);
    r.height = 20;
    const c = r.getCell(1);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: ACCENT };
    c.font = { bold: true, color: WHITE, size: 10, name: 'Calibri' };
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    mergeRow(r.number);
  }

  function addTableHeader(headers) {
    const r = ws.addRow(headers);
    r.height = 20;
    headers.forEach((h, i) => {
      const c = r.getCell(i + 1);
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D4A6B' } };
      c.font = { bold: true, color: WHITE, size: 9.5, name: 'Calibri' };
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' };
      c.border = { bottom: { style: 'thin', color: NAVY } };
      colWidths[i] = Math.max(colWidths[i] || 12, Math.min(String(h).length + 4, 40));
    });
  }

  function addDataRow(values, even) {
    const r = ws.addRow(values);
    r.height = 18;
    values.forEach((v, i) => {
      const c = r.getCell(i + 1);
      if (even) c.fill = { type: 'pattern', pattern: 'solid', fgColor: LIGHT };
      c.font = { size: 9.5, name: 'Calibri' };
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' };
      colWidths[i] = Math.max(colWidths[i] || 12, Math.min(String(v ?? '').length + 4, 45));
    });
  }

  function addParagraph(text) {
    const r = ws.addRow([text]);
    r.height = 18;
    const c = r.getCell(1);
    c.font = { size: 9.5, name: 'Calibri' };
    c.alignment = { wrapText: true, vertical: 'top' };
    mergeRow(r.number);
  }

  // ── Intestazione ─────────────────────────────────────────────────────────────
  addBanner(`PALLADIA — ${report.title || 'Report'}`, 13);
  if (report.subtitle) addMeta(report.subtitle, 'FFE8EDF3', true);
  addMeta(`Generato il ${now} · Pal, Assistente IA Palladia`, 'FFE8EDF3');
  ws.addRow([]).height = 6;

  // ── Sommario ─────────────────────────────────────────────────────────────────
  if (report.summary) {
    addSection('SOMMARIO');
    addParagraph(report.summary);
    ws.addRow([]).height = 6;
  }

  // ── KPI ──────────────────────────────────────────────────────────────────────
  if (report.kpis?.length) {
    addSection('INDICATORI CHIAVE');
    addTableHeader(['Valore', 'Indicatore']);
    report.kpis.forEach((k, i) => {
      const r = ws.addRow([k.value, k.label]);
      r.height = 18;
      if (i % 2 === 1) r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: LIGHT }; });
      r.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
      r.getCell(2).font = { size: 9.5, name: 'Calibri' };
    });
    ws.addRow([]).height = 6;
  }

  // ── Sezioni ───────────────────────────────────────────────────────────────────
  for (const s of (report.sections || [])) {
    if (s.title) addSection(s.title);
    if (s.text) {
      addParagraph(s.text);
    }
    if (s.table?.headers?.length && s.table?.rows?.length) {
      if (!s.text) ws.addRow([]).height = 4;
      addTableHeader(s.table.headers);
      s.table.rows.forEach((row, i) => addDataRow(row, i % 2 === 1));
    }
    ws.addRow([]).height = 6;
  }

  // Applica larghezze calcolate
  ws.columns = colWidths.slice(0, MERGE_COLS).map(w => ({ width: w }));

  return wb.xlsx.writeBuffer();
}

// ── Chat history helpers ──────────────────────────────────────────────────────

async function createConversation(companyId, userId, contextType = 'azienda', contextId = null) {
  const { data, error } = await supabase
    .from('chat_conversations')
    .insert({ company_id: companyId, user_id: userId, context_type: contextType, context_id: contextId || null })
    .select('id')
    .single();
  if (error) throw new Error('DB_ERROR: ' + error.message);
  return data.id;
}

async function loadHistory(conversationId, limit = 20) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, 200));
  if (error || !data) return [];
  return data.map(m => ({ role: m.role, content: m.content }));
}

async function saveMessages(conversationId, userContent, assistantContent) {
  await supabase.from('chat_messages').insert([
    { conversation_id: conversationId, role: 'user',      content: userContent },
    { conversation_id: conversationId, role: 'assistant', content: assistantContent },
  ]);
}

// Genera titolo automatico dal 1° messaggio (fire-and-forget)
async function autoTitle(conversationId, firstUserMessage, client) {
  try {
    const { data: conv } = await supabase
      .from('chat_conversations')
      .select('title')
      .eq('id', conversationId)
      .single();
    if (conv?.title && conv.title !== 'Nuova conversazione') return;

    const resp = await client.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 32,
      system:     'Genera un titolo brevissimo (max 40 caratteri, italiano) per questa conversazione. Solo il titolo, zero spiegazioni.',
      messages:   [{ role: 'user', content: firstUserMessage.slice(0, 300) }],
    });
    const title = resp.content.find(b => b.type === 'text')?.text?.trim().slice(0, 60) || 'Chat';
    await supabase.from('chat_conversations').update({ title }).eq('id', conversationId);
  } catch { /* non critico */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat
// Body: { message, conversation_id?, context_type?, context_id?, history? }
// Risposta: { reply, conversation_id }
// Se conversation_id è omesso viene creata una nuova conversazione automaticamente.
// history (legacy) è ancora accettato ma ignorato se conversation_id è presente.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat', verifySupabaseJwt, validate(chatMessageSchema), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const { message, conversation_id, context_type = 'azienda', context_id, history = [] } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'MESSAGE_TOO_LONG' });
  }

  try {
    const client = getClient();
    let convId = conversation_id || null;
    let isNew  = false;

    // Crea conversazione se non fornita
    if (!convId) {
      convId = await createConversation(req.companyId, req.user.id, context_type, context_id);
      isNew = true;
    } else {
      // Verifica ownership
      const { data: conv } = await supabase
        .from('chat_conversations')
        .select('id')
        .eq('id', convId)
        .eq('company_id', req.companyId)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (!conv) return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
    }

    // Carica storico dal DB; fallback a history legacy solo se conversazione nuova
    let dbHistory = [];
    if (!isNew) {
      dbHistory = await loadHistory(convId, 20);
    } else if (Array.isArray(history) && history.length > 0) {
      dbHistory = history
        .slice(-6)
        .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    }

    const messages = [...dbHistory, { role: 'user', content: message.trim() }];

    // Arricchisci il system prompt con lo snapshot aziendale (company brain)
    let systemPrompt = SYSTEM_PROMPT;
    try {
      const brain = await getCompanyBrain(supabase, req.companyId);
      if (brain?.text) systemPrompt = SYSTEM_PROMPT + brain.text;
    } catch { /* non critico — Ladia funziona anche senza brain */ }

    const reply = await runChatLoop(client, messages, req.companyId, classifyQuery(message), systemPrompt, req.user.id);

    // Salva asincrono — non blocca la risposta
    saveMessages(convId, message.trim(), reply).catch(e =>
      console.error('[chat] saveMessages error:', e.message)
    );

    // Titolo auto al 1° scambio (isNew o 1ª coppia)
    if (isNew) {
      autoTitle(convId, message.trim(), client).catch(() => {});
    }

    res.json({ reply, conversation_id: convId });
  } catch (err) {
    console.error('[chat] error:', err.message);
    if (err.status === 401) return res.status(503).json({ error: 'AI_UNAVAILABLE' });
    res.status(500).json({ error: 'CHAT_ERROR', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat/export
// Body: { messages: [{role, content}][], format: 'pdf'|'excel' }
// Response: file download (application/pdf o .xlsx)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat/export', verifySupabaseJwt, validate(chatExportSchema), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const { messages, format } = req.body;

  if (!['pdf', 'excel'].includes(format)) {
    return res.status(400).json({ error: 'INVALID_FORMAT' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'MESSAGES_REQUIRED' });
  }

  // Normalizza e sanifica
  const safeMessages = messages
    .slice(-10)
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));

  if (safeMessages.length === 0) {
    return res.status(400).json({ error: 'NO_VALID_MESSAGES' });
  }

  try {
    const client = getClient();
    const report = await buildReportJson(safeMessages, client);
    const ts     = Date.now();

    if (format === 'pdf') {
      const html = buildReportHtml(report);
      const pdf  = await renderHtmlToPdf(html, { docTitle: report.title || 'Report' });
      res.set({
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="palladia-report-${ts}.pdf"`,
        'Cache-Control':       'no-store',
      });
      return res.send(pdf);
    }

    // Excel
    const buf = await buildReportExcel(report);
    res.set({
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="palladia-report-${ts}.xlsx"`,
      'Cache-Control':       'no-store',
    });
    return res.send(buf);

  } catch (err) {
    console.error('[chat/export] error:', err.message);
    res.status(500).json({ error: 'EXPORT_ERROR', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat/stream  — SSE streaming (text/event-stream)
// Body: { message, conversation_id?, context_type?, context_id?, history? }
// Events: {type:'init',conversation_id} | {type:'tool_start',names:[]} |
//         {type:'text',delta:''} | {type:'done'} | {type:'error',message:''}
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat/stream', verifySupabaseJwt, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const { message, conversation_id, context_type = 'azienda', context_id, history = [], images = [] } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'MESSAGE_TOO_LONG' });
  }
  if (!Array.isArray(images) || images.length > 5) {
    return res.status(400).json({ error: 'MAX_5_IMAGES' });
  }
  const VALID_IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  for (const img of images) {
    if (!img?.data || typeof img.data !== 'string') return res.status(400).json({ error: 'INVALID_IMAGE_DATA' });
    if (!VALID_IMG_TYPES.includes(img.media_type)) return res.status(400).json({ error: 'INVALID_IMAGE_TYPE' });
    if (img.data.length > 7_000_000) return res.status(400).json({ error: 'IMAGE_TOO_LARGE' }); // ~5MB
  }

  // SSE headers — disabilita buffering Nginx/Railway
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // Risolvi/crea conversazione prima di iniziare lo stream
  let convId = conversation_id || null;
  let isNew  = false;
  try {
    if (!convId) {
      convId = await createConversation(req.companyId, req.user.id, context_type, context_id);
      isNew = true;
    } else {
      const { data: conv } = await supabase
        .from('chat_conversations')
        .select('id')
        .eq('id', convId)
        .eq('company_id', req.companyId)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (!conv) {
        send({ type: 'error', message: 'Conversazione non trovata.' });
        return res.end();
      }
    }
  } catch (e) {
    send({ type: 'error', message: 'Errore DB.' });
    return res.end();
  }

  // Invia conversation_id al client subito
  send({ type: 'init', conversation_id: convId });

  // Carica storico
  let dbHistory = [];
  if (!isNew) {
    dbHistory = await loadHistory(convId, 20).catch(() => []);
  } else if (Array.isArray(history) && history.length > 0) {
    dbHistory = history
      .slice(-6)
      .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  }

  const userText = message.trim();
  const userContent = images.length > 0
    ? [
        ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
        { type: 'text', text: userText },
      ]
    : userText;
  const userMsgForDb = images.length > 0
    ? `[${images.length} immagine${images.length > 1 ? 'i' : ''}] ${userText}`
    : userText;
  let messages = [...dbHistory, { role: 'user', content: userContent }];
  let fullAssistantReply = ''; // colleziona testo completo per salvarlo

  let aborted = false;
  req.on('close', () => { aborted = true; });

  // Company brain — fetch prima dello stream loop
  let systemPrompt = SYSTEM_PROMPT;
  try {
    const brain = await getCompanyBrain(supabase, req.companyId);
    if (brain?.text) systemPrompt = SYSTEM_PROMPT + brain.text;
  } catch { /* non critico */ }

  try {
    const client = getClient();
    const model  = images.length > 0 ? MODEL_SONNET : classifyQuery(message);

    // Loop agentico con streaming — max 4 iterazioni
    for (let iter = 0; iter < 6 && !aborted; iter++) {
      const collectedContent = [];
      let stopReason = null;

      // Apre stream verso Anthropic
      const stream = client.messages.stream({
        model,
        max_tokens: model === MODEL_SONNET ? 4096 : 1024,
        system:     systemPrompt,
        tools:      TOOLS,
        messages,
      });

      // Itera eventi raw SSE
      for await (const event of stream) {
        if (aborted) break;

        if (event.type === 'content_block_start') {
          collectedContent.push({ ...event.content_block, _inputRaw: '' });

        } else if (event.type === 'content_block_delta') {
          const block = collectedContent[event.index];
          if (!block) continue;
          if (event.delta.type === 'text_delta') {
            block.text = (block.text || '') + event.delta.text;
            fullAssistantReply += event.delta.text;
            send({ type: 'text', delta: event.delta.text });
          } else if (event.delta.type === 'input_json_delta') {
            block._inputRaw += event.delta.partial_json;
          }

        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason;
        }
      }

      if (aborted) break;
      if (stopReason !== 'tool_use') break; // risposta testo — fine loop

      // Parsa input JSON dei tool (arrivato come stringa parziale durante lo stream)
      for (const block of collectedContent) {
        if (block.type === 'tool_use') {
          try { block.input = JSON.parse(block._inputRaw || '{}'); } catch { block.input = {}; }
          delete block._inputRaw;
        }
      }

      const toolBlocks = collectedContent.filter(b => b.type === 'tool_use');
      send({ type: 'tool_start', names: toolBlocks.map(b => b.name) });

      // Esegui tool in parallelo
      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input, req.companyId, req.user.id);
          if (block.name === 'navigate_to_page' && result.navigated) {
            send({ type: 'navigate', path: result.path, label: result.label });
          }
          return {
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          };
        })
      );

      messages = [
        ...messages,
        { role: 'assistant', content: collectedContent.map(b => { const c = { ...b }; delete c._inputRaw; return c; }) },
        { role: 'user',      content: toolResults }
      ];
    }

    if (!aborted) {
      send({ type: 'done' });
      // Salva nel DB asincrono
      if (fullAssistantReply) {
        saveMessages(convId, userMsgForDb, fullAssistantReply).catch(e =>
          console.error('[chat/stream] saveMessages error:', e.message)
        );
        if (isNew) {
          autoTitle(convId, userMsgForDb, getClient()).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[chat/stream] error:', err.message);
    if (!aborted) send({ type: 'error', message: 'Si è verificato un errore. Riprova.' });
  } finally {
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/chat/conversations
// Lista conversazioni dell'utente per la company, ordinate per updated_at desc.
// Query params: context_type? ('azienda'|'cantiere'), context_id? (site_id)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/chat/conversations', verifySupabaseJwt, async (req, res) => {
  const { context_type, context_id } = req.query;

  let q = supabase
    .from('chat_conversations')
    .select('id, title, context_type, context_id, created_at, updated_at')
    .eq('company_id', req.companyId)
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (context_type) q = q.eq('context_type', context_type);
  if (context_id)   q = q.eq('context_id', context_id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json(data || []);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat/conversations
// Crea una nuova conversazione vuota.
// Body: { title?, context_type?, context_id? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat/conversations', verifySupabaseJwt, validate(createConversationSchema), async (req, res) => {
  const { title, context_type = 'azienda', context_id } = req.body || {};

  const allowedTypes = ['azienda', 'cantiere'];
  if (!allowedTypes.includes(context_type)) {
    return res.status(400).json({ error: 'INVALID_CONTEXT_TYPE' });
  }

  const insert = {
    company_id:   req.companyId,
    user_id:      req.user.id,
    context_type,
    context_id:   context_id || null,
  };
  if (title && typeof title === 'string') insert.title = title.trim().slice(0, 100);

  const { data, error } = await supabase
    .from('chat_conversations')
    .insert(insert)
    .select('id, title, context_type, context_id, created_at, updated_at')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/chat/conversations/:id
// Dettaglio conversazione + tutti i messaggi.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/chat/conversations/:id', verifySupabaseJwt, async (req, res) => {
  const { data: conv, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, title, context_type, context_id, created_at, updated_at')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (convErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!conv)   return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });

  const { data: msgs, error: msgsErr } = await supabase
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(200);

  if (msgsErr) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ ...conv, messages: msgs || [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/chat/conversations/:id/title
// Rinomina una conversazione.
// Body: { title: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/chat/conversations/:id/title', verifySupabaseJwt, validate(patchConversationTitleSchema), async (req, res) => {
  const { title } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'TITLE_REQUIRED' });
  }

  const { data, error } = await supabase
    .from('chat_conversations')
    .update({ title: title.trim().slice(0, 100) })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('user_id', req.user.id)
    .select('id, title')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });

  res.json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/chat/conversations/:id
// Elimina una conversazione e tutti i suoi messaggi (CASCADE nel DB).
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/chat/conversations/:id', verifySupabaseJwt, async (req, res) => {
  const { error } = await supabase
    .from('chat_conversations')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
