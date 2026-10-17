'use strict';
// ── Conti dei sub: lettura del foglio del subappaltatore (F-360) ─────────────
// Il foglio arriva com'è: Excel (anche più schede, con formule), CSV, PDF o
// foto. L'Excel diventa testo cella per cella (valori, non formule); PDF e foto
// vanno all'IA come documento. L'IA restituisce impresa, cantiere, mese, ore
// per persona e giorno, lavori a misura e il totale scritto; qui si controlla
// la risposta (controllaLettura, funzione pura). Mai numeri inventati: quello
// che non è scritto resta vuoto e lo chiede la pagina.
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');
const { withAiLimit } = require('./concurrencyLimit');
const { logUsage } = require('./ladiaUsageLog');
const { leggiImporto } = require('./daPagareLettura');

const MODEL = 'claude-opus-5-5';
const IMMAGINI = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_TESTO = 90000;
const MAX_RIGHE_FOGLIO = 600;
const MAX_COLONNE = 45;

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function errore(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

const PROMPT = `È il conto mensile che un'impresa subappaltatrice manda a un'impresa edile italiana (l'affidataria) per farsi approvare il lavoro del mese e poi fatturarlo. Può contenere ore lavorate dalle sue persone e/o lavori a misura (es. rasatura m², coloritura m², posa cartongesso m², messa in opera).

Leggi:
- impresa: chi ha fatto il lavoro e manda il conto (il subappaltatore, non l'affidataria);
- cantiere: indirizzo o nome del cantiere, se scritto;
- mese: il mese del lavoro, formato YYYY-MM;
- tariffa_oraria: euro per ora, solo se scritta; se il foglio scrive euro per giornata, dividi per 8;
- ore: una riga per persona e giorno, se il foglio le dice giorno per giorno (anche in una griglia persone × giorni del mese: una riga per ogni cella piena). giorno = YYYY-MM-DD. Se il foglio dà solo il totale del mese per persona, una riga per persona con giorno vuoto. Se dà solo il totale della squadra, persona = "Squadra" e giorno vuoto. Se il foglio conta in giornate, converti in ore: 1 giornata = 8 ore, mezza giornata = 4 ore. Non mettere righe con zero ore.
- lavori: lavori a misura o a corpo, con voce, unità (m², ml, cad, a corpo…), quantità del mese, prezzo unitario e importo come scritti. Le ore NON vanno nei lavori.
- totale_scritto: il totale del conto come è scritto sul foglio (senza IVA se è indicato a parte), anche se secondo te la somma è sbagliata.

Copia i numeri come sono scritti, senza correggerli e senza inventare: un dato non scritto resta stringa vuota. Ignora righe di riepilogo, subtotali e IVA.
Se non è un conto di lavori o ore di un'impresa, leggibile=false.`;

const SCHEMA = {
  type: 'object',
  properties: {
    leggibile: { type: 'boolean' },
    impresa: { type: 'string' },
    cantiere: { type: 'string' },
    mese: { type: 'string', description: 'YYYY-MM oppure vuoto' },
    tariffa_oraria: { type: 'string', description: 'es. 28.00 oppure vuoto' },
    ore: {
      type: 'array',
      items: {
        type: 'object',
        properties: { persona: { type: 'string' }, giorno: { type: 'string', description: 'YYYY-MM-DD oppure vuoto' }, ore: { type: 'string' } },
        required: ['persona', 'giorno', 'ore'],
        additionalProperties: false,
      },
    },
    lavori: {
      type: 'array',
      items: {
        type: 'object',
        properties: { voce: { type: 'string' }, unita: { type: 'string' }, quantita: { type: 'string' }, prezzo: { type: 'string' }, importo: { type: 'string' } },
        required: ['voce', 'unita', 'quantita', 'prezzo', 'importo'],
        additionalProperties: false,
      },
    },
    totale_scritto: { type: 'string' },
  },
  required: ['leggibile', 'impresa', 'cantiere', 'mese', 'tariffa_oraria', 'ore', 'lavori', 'totale_scritto'],
  additionalProperties: false,
};

const pulisci = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const isGiorno = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const isMese = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const pos = (v) => { const n = leggiImporto(v); return n != null && n > 0 ? Math.round(n * 100) / 100 : null; };

/** Verifica pura della risposta dell'IA. null = non usabile. */
function controllaLettura(raw) {
  if (!raw || typeof raw !== 'object' || raw.leggibile !== true) return null;
  const ore = (Array.isArray(raw.ore) ? raw.ore : []).map(r => ({
    persona: pulisci(r && r.persona, 80),
    giorno: isGiorno(r && r.giorno) ? r.giorno : null,
    ore_foglio: pos(r && r.ore),
  })).filter(r => r.persona.length >= 2 && r.ore_foglio != null && r.ore_foglio <= 24 * 31);
  const misura = (Array.isArray(raw.lavori) ? raw.lavori : []).map(r => ({
    voce: pulisci(r && r.voce, 120),
    unita: pulisci(r && r.unita, 20) || null,
    quantita_foglio: pos(r && r.quantita),
    prezzo_foglio: pos(r && r.prezzo),
    importo_scritto: pos(r && r.importo),
  })).filter(r => r.voce.length >= 2 && (r.quantita_foglio != null || r.importo_scritto != null))
    // "a corpo" senza quantità: 1 × importo
    .map(r => (r.quantita_foglio == null ? { ...r, quantita_foglio: 1, unita: r.unita || 'a corpo', prezzo_foglio: r.prezzo_foglio ?? r.importo_scritto } : r));
  if (!ore.length && !misura.length) return null;
  return {
    impresa: pulisci(raw.impresa, 160),
    cantiere: pulisci(raw.cantiere, 200) || null,
    mese: isMese(raw.mese) ? raw.mese : null,
    tariffa: pos(raw.tariffa_oraria),
    ore,
    misura,
    totaleScritto: pos(raw.totale_scritto),
  };
}

/** Le celle di un Excel come testo: una riga per riga, celle separate da " | ". */
async function excelInTesto(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const parti = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const righe = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (righe.length >= MAX_RIGHE_FOGLIO) return;
      const celle = [];
      for (let c = 1; c <= Math.min(row.cellCount, MAX_COLONNE); c++) {
        const cell = row.getCell(c);
        let v = cell.value;
        if (v && typeof v === 'object') {
          if (v instanceof Date) v = v.toISOString().slice(0, 10);
          else if ('result' in v) v = v.result instanceof Date ? v.result.toISOString().slice(0, 10) : v.result;
          else if ('richText' in v) v = v.richText.map(t => t.text).join('');
          else if ('text' in v) v = v.text;
          else v = '';
        }
        celle.push(v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
      }
      while (celle.length && !celle[celle.length - 1]) celle.pop();
      if (celle.some(Boolean)) righe.push(`r${n}: ${celle.join(' | ')}`);
    });
    if (righe.length) parti.push(`=== Scheda «${ws.name}» ===\n${righe.join('\n')}`);
  });
  const testo = parti.join('\n\n');
  if (!testo.trim()) throw errore('VUOTO', 'Il file Excel è vuoto.');
  return testo.slice(0, MAX_TESTO);
}

/** Che file è: excel | csv | pdf | immagine | null. */
function tipoFoglio(nome, mimetype) {
  const n = String(nome || '').toLowerCase();
  if (/\.xlsx$/.test(n) || mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'excel';
  if (/\.xls$/.test(n) || mimetype === 'application/vnd.ms-excel') return 'xls';
  if (/\.csv$/.test(n) || mimetype === 'text/csv') return 'csv';
  if (/\.pdf$/.test(n) || mimetype === 'application/pdf') return 'pdf';
  if (IMMAGINI.includes(mimetype) || /\.(jpe?g|png|webp)$/.test(n)) return 'immagine';
  return null;
}

/**
 * Legge il foglio. Lancia VECCHIO_EXCEL per i .xls (formato 97-2003) e FORMATO per il resto.
 * @returns {Promise<ReturnType<typeof controllaLettura>>}
 */
async function leggiFoglio({ buffer, mimetype, originalname, companyId }) {
  const tipo = tipoFoglio(originalname, mimetype);
  if (tipo === 'xls') throw errore('VECCHIO_EXCEL', 'È un Excel vecchio (.xls): aprilo e salvalo come .xlsx, oppure caricalo in PDF.');
  if (!tipo) throw errore('FORMATO', 'Carica il foglio in Excel (.xlsx), PDF o foto.');
  let blocco;
  if (tipo === 'excel' || tipo === 'csv') {
    const testo = tipo === 'excel' ? await excelInTesto(buffer) : buffer.toString('utf8').slice(0, MAX_TESTO);
    blocco = { type: 'text', text: `File «${pulisci(originalname, 120)}»:\n\n${testo}` };
  } else if (tipo === 'pdf') {
    blocco = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  } else {
    const media = IMMAGINI.includes(mimetype) ? mimetype : /\.png$/i.test(originalname) ? 'image/png' : /\.webp$/i.test(originalname) ? 'image/webp' : 'image/jpeg';
    blocco = { type: 'image', source: { type: 'base64', media_type: media, data: buffer.toString('base64') } };
  }
  const msg = await withAiLimit(() => client().beta.messages.create({
    model: MODEL,
    max_tokens: 20000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [blocco, { type: 'text', text: PROMPT }] }],
  }));
  if (companyId) logUsage({ companyId, model: msg.model || MODEL, callSite: 'conti_sub_lettura', usage: msg.usage });
  if (msg.stop_reason === 'refusal') return null;
  if (msg.stop_reason === 'max_tokens') throw errore('TROPPO_LUNGO', 'Il foglio è troppo lungo da leggere in una volta: caricalo un cantiere alla volta.');
  const text = (msg.content || []).find(b => b.type === 'text')?.text;
  if (!text) return null;
  try { return controllaLettura(JSON.parse(text)); } catch { return null; }
}

module.exports = { leggiFoglio, controllaLettura, excelInTesto, tipoFoglio };
