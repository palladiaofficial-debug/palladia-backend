'use strict';
const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const XLSX      = require('xlsx');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt }    = require('../../middleware/verifyJwt');
const { renderHtmlToPdf }      = require('../../pdf-renderer');

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
];

function classifyQuery(message) {
  const lower = message.toLowerCase();
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

④ ANALISI E GESTIONE
   Analisi presenze, ore lavorate, produttività, assenteismo
   Statistiche cantiere, reportistica operativa
   Pianificazione squadre, scadenze documentali, checklist sicurezza

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
- Tono sempre assertivo: "Oggi non risulta nessuna presenza" non "Purtroppo non riesco a vedere..."`;

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
  }
];

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, companyId) {
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
        const from = new Date(toolInput.from_date + 'T00:00:00+01:00').toISOString();
        const to   = new Date(toolInput.to_date   + 'T23:59:59+01:00').toISOString();

        // Query senza join embedded
        let q = supabase
          .from('presence_logs')
          .select('worker_id, site_id, event_type, timestamp_server')
          .eq('company_id', companyId)
          .gte('timestamp_server', from)
          .lte('timestamp_server', to)
          .order('timestamp_server', { ascending: true })
          .limit(2000);
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

      default:
        return { error: 'Tool non riconosciuto: ' + toolName };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Agentic loop riusabile ───────────────────────────────────────────────────
async function runAgentLoop(client, messages, systemPrompt, tools, maxIter = 4) {
  let response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system:     systemPrompt,
    tools:      tools || [],
    messages,
  });

  const extra = [];
  let iter = 0;

  while (response.stop_reason === 'tool_use' && iter < maxIter) {
    iter++;
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     JSON.stringify(await executeTool(block.name, block.input, null)) // companyId overridden below
      }))
    );

    extra.push(
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults }
    );

    response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system:     systemPrompt,
      tools:      tools || [],
      messages:   [...messages, ...extra],
    });
  }

  return response.content.find(b => b.type === 'text')?.text ?? '';
}

// ── Agentic loop con company_id (chat principale) ────────────────────────────
async function runChatLoop(client, messages, companyId, model) {
  let response = await client.messages.create({
    model,
    max_tokens: model === MODEL_SONNET ? 2048 : 1024,
    system:     SYSTEM_PROMPT,
    tools:      TOOLS,
    messages,
  });

  const extra = [];
  let iter = 0;

  while (response.stop_reason === 'tool_use' && iter < 4) {
    iter++;
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     JSON.stringify(await executeTool(block.name, block.input, companyId))
      }))
    );

    extra.push(
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults }
    );

    response = await client.messages.create({
      model,
      max_tokens: model === MODEL_SONNET ? 2048 : 1024,
      system:     SYSTEM_PROMPT,
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

// ── Excel workbook ────────────────────────────────────────────────────────────
function buildReportExcel(report) {
  const wb  = XLSX.utils.book_new();
  const now = new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome'
  });

  // Sheet principale
  const aoa = [];

  // Intestazione
  aoa.push([`PALLADIA — ${report.title || 'Report'}`]);
  if (report.subtitle) aoa.push([report.subtitle]);
  aoa.push([`Generato il ${now} da Pal · Assistente IA Palladia`]);
  aoa.push([]);

  // Sommario
  if (report.summary) {
    aoa.push(['SOMMARIO']);
    aoa.push([report.summary]);
    aoa.push([]);
  }

  // KPI
  if (report.kpis && report.kpis.length) {
    aoa.push(['KPI']);
    aoa.push(['Valore', 'Indicatore']);
    report.kpis.forEach(k => aoa.push([k.value, k.label]));
    aoa.push([]);
  }

  // Sezioni
  (report.sections || []).forEach(s => {
    aoa.push([s.title || '']);

    if (s.text) {
      aoa.push([s.text]);
      aoa.push([]);
    }

    if (s.table && s.table.headers && s.table.rows) {
      aoa.push(s.table.headers);
      s.table.rows.forEach(row => aoa.push(row));
    }

    aoa.push([]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Larghezze colonne automatiche (stima max 50 caratteri per colonna)
  const colWidths = [];
  aoa.forEach(row => {
    row.forEach((cell, ci) => {
      const len = Math.min(String(cell ?? '').length + 2, 50);
      colWidths[ci] = Math.max(colWidths[ci] || 10, len);
    });
  });
  ws['!cols'] = colWidths.map(w => ({ wch: w }));

  XLSX.utils.book_append_sheet(wb, ws, 'Report');

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/chat
// Body: { message: string, history?: [{role, content}][] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat', verifySupabaseJwt, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const { message, history = [] } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'MESSAGE_TOO_LONG' });
  }

  const safeHistory = (Array.isArray(history) ? history : [])
    .slice(-6)
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const messages = [...safeHistory, { role: 'user', content: message.trim() }];

  try {
    const reply = await runChatLoop(getClient(), messages, req.companyId, classifyQuery(message));
    res.json({ reply });
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
router.post('/chat/export', verifySupabaseJwt, async (req, res) => {
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
    const buf = buildReportExcel(report);
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
// Events: {type:'tool_start',names:[]} | {type:'text',delta:''} | {type:'done'} | {type:'error',message:''}
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat/stream', verifySupabaseJwt, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'MESSAGE_TOO_LONG' });
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

  const safeHistory = (Array.isArray(history) ? history : [])
    .slice(-6)
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  let messages = [...safeHistory, { role: 'user', content: message.trim() }];

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const client = getClient();
    const model  = classifyQuery(message);

    // Loop agentico con streaming — max 4 iterazioni
    for (let iter = 0; iter < 4 && !aborted; iter++) {
      const collectedContent = [];
      let stopReason = null;

      // Apre stream verso Anthropic
      const stream = client.messages.stream({
        model,
        max_tokens: model === MODEL_SONNET ? 2048 : 1024,
        system:     SYSTEM_PROMPT,
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
          const result = await executeTool(block.name, block.input, req.companyId);
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

    if (!aborted) send({ type: 'done' });
  } catch (err) {
    console.error('[chat/stream] error:', err.message);
    if (!aborted) send({ type: 'error', message: 'Si è verificato un errore. Riprova.' });
  } finally {
    res.end();
  }
});

module.exports = router;
