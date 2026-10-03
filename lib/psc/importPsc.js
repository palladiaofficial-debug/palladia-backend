'use strict';
/**
 * lib/psc/importPsc.js — F-270. "Porta qui i PSC che hai già fatto": ogni
 * vecchio PSC (PDF o Word, fatto con qualunque programma) diventa libreria del
 * coordinatore — le sue lavorazioni con rischi e misure, le sue frasi per
 * sezione, le sue voci di costo con i suoi prezzi — con il nome del file da
 * cui vengono. Riporta SOLO ciò che è scritto: la forma è imposta da un tool
 * a schema e ricontrollata campo per campo.
 *
 * La lettura gira in coda nel processo (un file alla volta): la richiesta di
 * caricamento risponde subito e il frontend ripassa a vedere lo stato.
 */
const supabase = require('../supabase');
const { callTool, contentFromFile } = require('./ai');
const { schedaPerTesto } = require('./lavorazioni');
const { VOCI_COSTO } = require('./catalog');

const BUCKET = 'psc-files';
const SEZIONI = ['organizzazione', 'coordinamento', 'emergenze', 'uso_comune', 'procedure', 'contesto', 'interferenze'];
const COSTO_KEYS = [...VOCI_COSTO.map(v => v.key), 'altro'];

const TOOL = {
  name: 'libreria_psc',
  description: 'Restituisce il contenuto riutilizzabile di un Piano di Sicurezza e Coordinamento.',
  input_schema: {
    type: 'object',
    properties: {
      e_un_psc: { type: 'boolean', description: 'false se il documento chiaramente NON è un PSC' },
      opera: { type: 'string', description: 'Nome breve dell\'opera, es. "Ristrutturazione Scuola Pertini"' },
      anno: { type: 'integer', description: 'Anno del documento, se indicato' },
      comune: { type: 'string' },
      sezioni_riconosciute: { type: 'array', items: { type: 'string' }, description: 'Titoli delle sezioni principali trovate' },
      lavorazioni: {
        type: 'array', description: 'Lavorazioni/fasi con i rischi e le misure SCRITTE nel PSC. Massimo 25.',
        items: { type: 'object', properties: {
          nome: { type: 'string' },
          rischi: { type: 'array', items: { type: 'string' } },
          misure: { type: 'array', items: { type: 'string' }, description: 'Misure di prevenzione e protezione, ciascuna una frase completa come scritta nel PSC' },
          durata_giorni: { type: 'integer' },
          pagina: { type: 'integer' },
        }, required: ['nome'] },
      },
      frasi: {
        type: 'array', description: 'Prescrizioni riutilizzabili su organizzazione del cantiere, coordinamento/riunioni, emergenze, uso comune, procedure, contesto, interferenze. Massimo 40.',
        items: { type: 'object', properties: {
          sezione: { type: 'string', enum: SEZIONI },
          titolo: { type: 'string' },
          testo: { type: 'string' },
          pagina: { type: 'integer' },
        }, required: ['sezione', 'testo'] },
      },
      costi: {
        type: 'array', description: 'Voci della stima dei costi della sicurezza. Massimo 60.',
        items: { type: 'object', properties: {
          descrizione: { type: 'string' },
          codice: { type: 'string', description: 'Codice della voce di prezzario, se indicato' },
          um: { type: 'string' },
          prezzo: { type: 'number', description: 'Prezzo unitario in euro' },
          tipo: { type: 'string', enum: COSTO_KEYS, description: 'A quale voce tipica corrisponde (altro se nessuna)' },
          pagina: { type: 'integer' },
        }, required: ['descrizione'] },
      },
      pagine_illeggibili: { type: 'array', items: { type: 'integer' } },
    },
    required: ['e_un_psc'],
  },
};

const SYSTEM = `Sei un coordinatore della sicurezza esperto. Leggi un PSC (D.Lgs. 81/2008, Allegato XV) scritto da un collega e ricava ciò che si può riusare in un PSC futuro, compilando lo strumento libreria_psc.
Regole:
- Riporta SOLO ciò che è scritto nel documento, con le sue parole (puoi accorciare, mai inventare). Se una parte manca, omettila.
- Le misure e le frasi devono essere frasi complete e autonome (massimo 60 parole), senza riferimenti a nomi di persone, date o imprese specifiche di quel cantiere: sostituisci i nomi propri con "l'impresa", "il preposto", "il CSE".
- Per i costi riporta descrizione, unità di misura e prezzo unitario come scritti; tipo = la voce tipica corrispondente (recinzione, baracca, wc, ponteggio, parapetti, linea_vita, mantovana, estintori, riunioni, ecc.) o "altro".
- "pagina" è il numero di pagina del PDF ("--- Pagina N ---") se disponibile.`;

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const pg = (v, n) => (Number.isInteger(v) && v >= 1 && (!n || v <= n) ? v : null);

function sanitize(raw, numPages) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const arr = (a, max) => (Array.isArray(a) ? a.slice(0, max) : []);
  const lavorazioni = arr(r.lavorazioni, 25).map(l => ({
    nome: str(l && l.nome, 160),
    rischi: arr(l && l.rischi, 15).map(x => str(x, 200)).filter(Boolean),
    misure: arr(l && l.misure, 25).map(x => str(x, 450)).filter(x => x.length >= 12),
    durata_giorni: Number.isInteger(l && l.durata_giorni) && l.durata_giorni > 0 && l.durata_giorni < 1000 ? l.durata_giorni : null,
    pagina: pg(l && l.pagina, numPages),
  })).filter(l => l.nome);
  const frasi = arr(r.frasi, 40).map(f => ({
    sezione: SEZIONI.includes(f && f.sezione) ? f.sezione : null,
    titolo: str(f && f.titolo, 120),
    testo: str(f && f.testo, 600),
    pagina: pg(f && f.pagina, numPages),
  })).filter(f => f.sezione && f.testo.length >= 20);
  const costi = arr(r.costi, 60).map(c => ({
    descrizione: str(c && c.descrizione, 400),
    codice: str(c && c.codice, 40) || null,
    um: str(c && c.um, 20) || null,
    prezzo: typeof (c && c.prezzo) === 'number' && c.prezzo >= 0 && c.prezzo < 1e6 ? Math.round(c.prezzo * 100) / 100 : null,
    tipo: COSTO_KEYS.includes(c && c.tipo) ? c.tipo : 'altro',
    pagina: pg(c && c.pagina, numPages),
  })).filter(c => c.descrizione.length >= 6);
  return {
    isPsc: r.e_un_psc !== false,
    opera: str(r.opera, 160),
    anno: Number.isInteger(r.anno) && r.anno > 1990 && r.anno < 2100 ? r.anno : null,
    comune: str(r.comune, 80),
    sezioni: arr(r.sezioni_riconosciute, 30).map(x => str(x, 120)).filter(Boolean),
    lavorazioni, frasi, costi,
    illeggibili: arr(r.pagine_illeggibili, 50).map(x => pg(x, numPages)).filter(Boolean),
  };
}

async function insertDedup(rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { error } = await supabase.from('psc_library').insert(chunk);
    if (!error) { inserted += chunk.length; continue; }
    // Un duplicato fa fallire il blocco: ripiego riga per riga.
    for (const row of chunk) {
      const { error: e1 } = await supabase.from('psc_library').insert(row);
      if (!e1) inserted++;
      else if (e1.code !== '23505') throw e1;
    }
  }
  return inserted;
}

/** Trasforma il risultato letto in righe di libreria. Pura. */
function libraryRows(companyId, importId, sourceName, res) {
  const rows = [];
  for (const l of res.lavorazioni) {
    const sid = schedaPerTesto(l.nome);
    rows.push({ company_id: companyId, kind: 'lavorazione', scheda_id: sid, titolo: l.nome, testo: l.nome, data: { rischi: l.rischi, misure: l.misure, durata_giorni: l.durata_giorni, pagina: l.pagina }, source_name: sourceName, source_import: importId });
    for (const m of l.misure) rows.push({ company_id: companyId, kind: 'misura', scheda_id: sid, titolo: l.nome, testo: m, data: { pagina: l.pagina }, source_name: sourceName, source_import: importId });
  }
  for (const f of res.frasi) rows.push({ company_id: companyId, kind: 'frase', sezione: f.sezione, titolo: f.titolo || null, testo: f.testo, data: { pagina: f.pagina }, source_name: sourceName, source_import: importId });
  for (const c of res.costi) rows.push({ company_id: companyId, kind: 'costo', titolo: c.tipo !== 'altro' ? c.tipo : null, testo: c.descrizione, data: { key: c.tipo !== 'altro' ? c.tipo : null, codice: c.codice, um: c.um, prezzo: c.prezzo, pagina: c.pagina }, source_name: sourceName, source_import: importId });
  return rows;
}

function sourceNameOf(fileName, res) {
  const base = String(fileName || '').replace(/\.(pdf|docx)$/i, '').replace(/[_]+/g, ' ').trim();
  if (res.opera) return `PSC ${res.opera.replace(/^psc\s+/i, '')}${res.anno ? ` ${res.anno}` : ''}`.slice(0, 160);
  return base.slice(0, 160) || 'PSC importato';
}

async function processOne(row, deps = {}) {
  const { id, company_id: companyId, storage_path: path, mime_type: mime, file_name: fileName, created_by: userId } = row;
  await supabase.from('psc_imports').update({ status: 'in_lettura' }).eq('id', id);
  try {
    const buffer = deps.download ? await deps.download(path)
      : Buffer.from(await (await supabase.storage.from(BUCKET).download(path)).data.arrayBuffer());
    const { content, numPages, source } = await contentFromFile(buffer, mime, `PSC "${fileName}"`);
    const ai = deps.ai || ((args) => callTool(args));
    const { input, truncated } = await ai({ system: SYSTEM, content, tool: TOOL, maxTokens: 16000, companyId, userId, callSite: 'psc_import_library' });
    if (!input) throw Object.assign(new Error('Non sono riuscito a leggere il documento'), { status: 502 });
    const res = sanitize(input, numPages);
    if (!res.isPsc) {
      await supabase.from('psc_imports').update({ status: 'errore', error: 'Questo documento non sembra un PSC', num_pages: numPages, done_at: new Date().toISOString() }).eq('id', id);
      return;
    }
    const sourceName = sourceNameOf(fileName, res);
    const rows = libraryRows(companyId, id, sourceName, res);
    const inserted = await insertDedup(rows);
    const daGuardare = source === 'scansione' || res.illeggibili.length > 0 || truncated;
    const result = {
      source, opera: res.opera, anno: res.anno, comune: res.comune, sezioni: res.sezioni, source_name: sourceName,
      conteggi: { lavorazioni: res.lavorazioni.length, misure: res.lavorazioni.reduce((s, l) => s + l.misure.length, 0), frasi: res.frasi.length, costi: res.costi.length, nuove_in_libreria: inserted },
      illeggibili: res.illeggibili, troncato: truncated,
      anteprima: res.lavorazioni.slice(0, 1).map(l => ({ nome: l.nome, rischi: l.rischi.length, misure: l.misure.length, pagina: l.pagina }))[0] || null,
    };
    await supabase.from('psc_imports').update({ status: daGuardare ? 'da_guardare' : 'letto', num_pages: numPages, result, done_at: new Date().toISOString() }).eq('id', id);
  } catch (err) {
    const msg = err && err.status && err.status < 500 ? err.message : 'Lettura non riuscita: riprova più tardi';
    await supabase.from('psc_imports').update({ status: 'errore', error: String(msg).slice(0, 300), done_at: new Date().toISOString() }).eq('id', id);
    if (!(err && err.status && err.status < 500)) console.error('[psc import]', id, err && err.message);
  }
}

// ── Coda nel processo ──────────────────────────────────────────────────────────
let running = false;
const queue = [];
function enqueue(row) {
  queue.push(row);
  if (!running) drain();
}
async function drain() {
  running = true;
  while (queue.length) {
    const row = queue.shift();
    try { await processOne(row); } catch (e) { console.error('[psc import queue]', e && e.message); }
  }
  running = false;
}

/** Al riavvio del server: rimette in coda i file rimasti a metà. */
async function resumePending() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supabase.from('psc_imports').select('*').in('status', ['in_coda', 'in_lettura']).gte('created_at', since).order('created_at');
  for (const r of data || []) enqueue(r);
  return (data || []).length;
}

module.exports = { TOOL, sanitize, libraryRows, sourceNameOf, processOne, enqueue, resumePending, BUCKET };
