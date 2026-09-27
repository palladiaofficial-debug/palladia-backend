'use strict';
// ── Lettura del PSC per il POS (F-259, AUDIT.md del frontend) ───────────────
// Il titolare carica il Piano di Sicurezza e Coordinamento del cantiere (è
// già salvato in site_documents, categoria 'psc', dalla route documenti) e
// noi ne estraiamo ciò che serve al POS di UNA impresa: dati del cantiere,
// coordinatori, orari, le fasi affidate a quell'impresa e le misure che il
// PSC chiede proprio a lei, ognuna con la pagina da cui arriva.
//
// La forma della risposta è IMPOSTA con un tool a schema (tool_choice forzato),
// non chiesta a parole, e poi ricontrollata campo per campo (sanitizePsc):
// un testo lungo, un numero al posto di una stringa o una pagina inventata
// oltre la fine del documento non passano mai al POS.
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');
const { extractPdfText } = require('./pdfExtract');
const { logUsage, checkAiBudget } = require('./ladiaUsageLog');

const MODEL = 'claude-haiku-4-5-20251001';
const BUCKET = 'site-documents';
const MAX_TEXT_CHARS = 220_000;   // ~60k token: un PSC di 150 pagine ci sta
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const TOOL = {
  name: 'dati_psc',
  description: 'Restituisce i dati del PSC utili al POS dell’impresa indicata.',
  input_schema: {
    type: 'object',
    properties: {
      riferimento: { type: 'string', description: 'Titolo/revisione/data del PSC, se indicati (es. "PSC rev. 2 del 01/09/2026")' },
      committente: { type: 'string' },
      cf_committente: { type: 'string' },
      responsabile_lavori: { type: 'string' },
      csp: { type: 'string', description: 'Coordinatore per la progettazione, nome' },
      cse_nome: { type: 'string' },
      cse_telefono: { type: 'string' },
      cse_email: { type: 'string' },
      indirizzo_cantiere: { type: 'string' },
      data_inizio: { type: 'string', description: 'AAAA-MM-GG' },
      data_fine: { type: 'string', description: 'AAAA-MM-GG' },
      importo_lavori: { type: 'string', description: 'Solo cifre, senza simbolo' },
      orario_inizio: { type: 'string', description: 'HH:MM' },
      orario_fine: { type: 'string', description: 'HH:MM' },
      pausa_minuti: { type: 'integer' },
      fasi_impresa: {
        type: 'array', description: 'Fasi di lavoro che il PSC assegna all’impresa indicata (o, se il PSC non distingue per impresa, quelle compatibili con i lavori indicati)',
        items: { type: 'object', properties: { titolo: { type: 'string' }, pagina: { type: 'integer' } }, required: ['titolo'] },
      },
      richieste_per_impresa: {
        type: 'array', description: 'Misure, procedure e documenti che il PSC chiede all’impresa (o a tutte le imprese esecutrici) di inserire nel proprio POS',
        items: { type: 'object', properties: { titolo: { type: 'string' }, dettaglio: { type: 'string' }, pagina: { type: 'integer' } }, required: ['titolo'] },
      },
      rischi_interferenza: {
        type: 'array', items: { type: 'object', properties: { titolo: { type: 'string' }, pagina: { type: 'integer' } }, required: ['titolo'] },
      },
      pagine: { type: 'object', description: 'Pagina dove si trova ciascun dato principale', properties: {
        committente: { type: 'integer' }, cse: { type: 'integer' }, date: { type: 'integer' }, orari: { type: 'integer' },
      } },
      e_un_psc: { type: 'boolean', description: 'false se il documento chiaramente NON è un Piano di Sicurezza e Coordinamento' },
    },
    required: ['e_un_psc'],
  },
};

function prompt(impresaName, lavori) {
  return `Sei un tecnico della sicurezza in edilizia. Leggi il PSC (Piano di Sicurezza e Coordinamento, D.Lgs. 81/2008 all. XV) qui sotto e compila lo strumento dati_psc per il POS dell'impresa esecutrice "${impresaName}"${lavori ? ` (lavori: ${lavori})` : ''}.
Regole:
- Riporta SOLO ciò che è scritto nel PSC. Se un dato non c'è, omettilo: mai inventare nomi, date, numeri o pagine.
- "pagina" è il numero di pagina del PDF indicato dai separatori "--- Pagina N ---" (o la pagina del documento se lo leggi come PDF).
- Frasi brevi e chiare in italiano (massimo 25 parole per voce).
- richieste_per_impresa: solo ciò che il PSC chiede di fare, prevedere, allegare o rispettare da parte di questa impresa o di tutte le imprese esecutrici (procedure, piani di sollevamento, verifiche, coordinamento, DPI particolari...). Massimo 12 voci, le più importanti.
- fasi_impresa: massimo 12. rischi_interferenza: massimo 8.`;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isoDate = (v) => {
  const s = str(v, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s))) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
const hhmm = (v) => { const m = str(v, 10).match(/^(\d{1,2})[:.](\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const page = (v, numPages) => (Number.isInteger(v) && v >= 1 && (!numPages || v <= numPages) ? v : null);
const list = (arr, numPages, max, withDetail) => (Array.isArray(arr) ? arr : [])
  .map(x => ({ titolo: str(x && x.titolo, 160), ...(withDetail ? { dettaglio: str(x && x.dettaglio, 300) } : {}), pagina: page(x && x.pagina, numPages) }))
  .filter(x => x.titolo)
  .slice(0, max);

/** Ricontrolla campo per campo ciò che ha restituito il modello. */
function sanitizePsc(raw, numPages) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.pagine && typeof r.pagine === 'object' ? r.pagine : {};
  const pausa = Number.isInteger(r.pausa_minuti) && r.pausa_minuti >= 0 && r.pausa_minuti <= 180 ? r.pausa_minuti : null;
  return {
    isPsc: r.e_un_psc !== false,
    riferimento: str(r.riferimento, 160),
    committente: str(r.committente, 200),
    cfCommittente: str(r.cf_committente, 20).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    responsabileLavori: str(r.responsabile_lavori, 120),
    csp: str(r.csp, 120),
    cse: { nome: str(r.cse_nome, 120), telefono: str(r.cse_telefono, 40), email: str(r.cse_email, 120) },
    indirizzo: str(r.indirizzo_cantiere, 200),
    dataInizio: isoDate(r.data_inizio),
    dataFine: isoDate(r.data_fine),
    importo: str(r.importo_lavori, 20).replace(/[^\d.,]/g, ''),
    orarioInizio: hhmm(r.orario_inizio),
    orarioFine: hhmm(r.orario_fine),
    pausaMinuti: pausa,
    fasi: list(r.fasi_impresa, numPages, 12, false),
    richieste: list(r.richieste_per_impresa, numPages, 12, true),
    interferenze: list(r.rischi_interferenza, numPages, 8, false),
    pagine: { committente: page(p.committente, numPages), cse: page(p.cse, numPages), date: page(p.date, numPages), orari: page(p.orari, numPages) },
  };
}

async function defaultAi({ system, content, companyId, userId }) {
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 3000, temperature: 0, system,
    tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content }],
  });
  await logUsage({ companyId, userId, model: MODEL, callSite: 'pos_psc_extract', usage: resp.usage });
  const block = (resp.content || []).find(b => b.type === 'tool_use');
  return block ? block.input : null;
}

/**
 * @param {string} companyId
 * @param {{siteId:string, documentId:string, impresaName?:string, lavori?:string, userId?:string}} p
 * @param {{ai?:Function, download?:Function}} [deps] iniettabili per i test
 */
async function extractPsc(companyId, p, deps = {}) {
  const ai = deps.ai || defaultAi;
  const { data: doc } = await supabase.from('site_documents')
    .select('id, company_id, site_id, file_path, mime_type, file_size, name')
    .eq('id', p.documentId).eq('company_id', companyId).eq('site_id', p.siteId).maybeSingle();
  if (!doc) { const e = new Error('PSC non trovato'); e.status = 404; throw e; }
  if (doc.mime_type !== 'application/pdf') { const e = new Error('Il PSC deve essere un PDF'); e.status = 400; throw e; }
  if (doc.file_size && doc.file_size > MAX_PDF_BYTES) { const e = new Error('PDF troppo grande (massimo 25 MB)'); e.status = 400; throw e; }

  const buffer = deps.download
    ? await deps.download(doc.file_path)
    : Buffer.from(await (await supabase.storage.from(BUCKET).download(doc.file_path)).data.arrayBuffer());

  const { text, numPages } = await extractPdfText(buffer, { maxPages: 150, minChars: 10 });
  const system = prompt(p.impresaName || 'impresa esecutrice', p.lavori || '');
  let content, source;
  if (text && text.trim().length > 500) {
    source = 'testo';
    content = `Testo del PSC (${numPages} pagine):\n\n${text.slice(0, MAX_TEXT_CHARS)}`;
  } else {
    source = 'scansione';
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'Leggi questo PSC e compila lo strumento dati_psc.' },
    ];
  }
  if (!deps.ai) {
    const budget = await checkAiBudget(companyId);
    if (!budget.allowed) { const e = new Error('Hai raggiunto il limite mensile di utilizzo dell’AI del tuo piano'); e.status = 429; throw e; }
  }
  const raw = await ai({ system, content, companyId, userId: p.userId || null });
  if (!raw) { const e = new Error('Non sono riuscito a leggere il PSC'); e.status = 502; throw e; }
  return { ...sanitizePsc(raw, numPages), numPages, source, documentId: doc.id, fileName: doc.name };
}

module.exports = { extractPsc, sanitizePsc, TOOL };
