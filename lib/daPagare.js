'use strict';
/**
 * lib/daPagare.js — F-338 (AUDIT.md del frontend): Da pagare.
 *
 * I pagamenti da non dimenticare: chi, quanto, entro quando, "mi ha
 * sollecitato". Righe di company_expenses con da_pagare = true (migr. 250),
 * mostrate dentro Da fare (lib/daFare.js le aggiunge come kind 'pagamento') e
 * nella card Buongiorno. Mockup approvato: https://claude.ai/artifact/F25qJirS3FYk2d3xTQAmpn
 *
 * Confine (deciso prima del codice): niente categorie, cantiere, centri di
 * costo, IVA, margini, previsione di cassa, SAL. Solo la lista.
 *
 * Gruppi:
 *   subito            scaduta, oppure "mi ha sollecitato"
 *   settimana         scade nei prossimi 7 giorni
 *   piu_avanti        il resto
 *   da_controllare    letta da un PDF/foto senza XML e non ancora confermata
 */
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');
const { ibanValido } = require('./iban');

const FLAG = 'da_pagare';
const RUOLI = ['owner', 'admin', 'tech'];
const BUCKET = 'site-documents';
const GIORNI_SETTIMANA = 7;

function errore(code, message, status = 400) { return Object.assign(new Error(message || code), { code, status }); }
function dbErr(error) { if (error) throw errore('DB_ERROR', error.message, 500); }

const romeDate = (d = new Date()) => new Date(d).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const giorniTra = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const GG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
function euro(n) {
  const [i, d] = Number(n || 0).toFixed(2).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} €`;
}
// F-357: "WC LOC ITALIA S.r.l." e "WC Loc Italia S.r.l. Unipersonale" sono lo
// stesso fornitore (chiave per raggruppare le fatture e per i doppioni).
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/'/g, '')
  .replace(/\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|unipersonale|a socio unico|socio unico|in liquidazione)(?![a-z0-9])/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// F-357: il nome da mostrare. Senza la forma societaria e, se il gestionale del
// fornitore l'ha scritto TUTTO MAIUSCOLO, con le maiuscole normali
// ("GUARDALA' GIUSEPPINA" → "Guardalà Giuseppina").
const MINUSCOLE = new Set(['di', 'da', 'de', 'del', 'della', 'dei', 'degli', 'delle', 'e', 'ed', 'in', 'con', 'per', 'su', 'a', 'al', 'la', 'le', 'lo', 'il', 'gli']);
const ACCENTI = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù' };
const FORMA = /[\s,.-]*\b(s\.?\s?r\.?\s?l\.?\s?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|unipersonale|a socio unico|socio unico)(?![A-Za-z0-9])\.?/gi;
function nomeBreve(s) {
  const pieno = String(s || '').replace(/\s+/g, ' ').trim();
  let t = pieno.replace(FORMA, '').replace(/[\s,.-]+$/, '').trim();
  if (t.length < 2) t = pieno;
  if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) {
    t = t.toLowerCase().split(' ')
      // sigle senza vocali ("WC", "CMC") restano maiuscole
      .map((w, i) => (i > 0 && MINUSCOLE.has(w)) ? w : /^[b-df-hj-np-tv-z]{2,4}$/.test(w) ? w.toUpperCase() : w.replace(/(^|[-'])([a-z])/g, (m, a, c) => a + c.toUpperCase()))
      .join(' ')
      .replace(/([aeiou])'(?=\s|$)/g, (m, v) => ACCENTI[v]);
  }
  return t;
}
const testo = (s, max = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

async function attivoPer(companyId) {
  try { return await isFeatureEnabled(companyId, FLAG); } catch { return false; }
}
const puoVedere = (role) => !role || RUOLI.includes(role);

/** Data che conta per la lista: "rimandato al" se più avanti della scadenza. */
function dataEffettiva(r) {
  if (r.rimandato_al && (!r.data_scadenza || r.rimandato_al > r.data_scadenza)) return r.rimandato_al;
  return r.data_scadenza || null;
}

function quandoTesto(giorni, data) {
  if (data == null) return 'senza scadenza';
  if (giorni < -1) return `scaduta da ${-giorni} giorni`;
  if (giorni === -1) return 'scaduta ieri';
  if (giorni === 0) return 'entro oggi';
  if (giorni === 1) return 'entro domani';
  const d = new Date(`${data}T12:00:00Z`);
  if (giorni <= 6) return `entro ${GG[d.getUTCDay()]} ${d.getUTCDate()}`;
  return `entro il ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`;
}

/** Una riga della lista, pronta per la pagina e per Da fare. Pura. */
function riga(r, today) {
  const data = dataEffettiva(r);
  const giorni = data ? giorniTra(today, data) : null;
  const daControllare = !!r.pending_review;
  const gruppo = daControllare ? 'da_controllare'
    : (r.sollecitato || (giorni != null && giorni < 0)) ? 'subito'
      : (giorni != null && giorni <= GIORNI_SETTIMANA) ? 'settimana' : 'piu_avanti';
  const pezzi = [daControllare ? `letta da ${r.source === 'email' ? 'un\'email' : 'una foto'} · ${quandoTesto(giorni, data)}?` : quandoTesto(giorni, data)];
  const rimandata = !!(r.rimandato_al && r.rimandato_al === data);
  if (rimandata) pezzi[0] = `rimandata · ${pezzi[0]}`;
  if (r.sollecitato) pezzi.push('ti ha sollecitato');
  if (r.invoice_number) pezzi.push(`fattura n. ${r.invoice_number}`);
  return {
    id: r.id,
    fornitore: r.supplier || r.description,
    // F-357: nome da mostrare e chiave per raggruppare le fatture dello stesso fornitore
    nome: nomeBreve(r.supplier || r.description),
    chiave: normNome(r.supplier || r.description) || String(r.id),
    rimandata,
    iban: ibanValido(r.iban),
    importo: Number(r.amount),
    importoTesto: euro(r.amount),
    scadenza: r.data_scadenza || null,
    data,
    giorni,
    gruppo,
    sollecitato: !!r.sollecitato,
    numeroFattura: r.invoice_number || null,
    daControllare,
    perEmail: r.source === 'email',
    conFoto: !!r.receipt_url,
    sottotitolo: pezzi.join(' · '),
    pagatoIl: r.pagato_il || null,
  };
}

const COLS = 'id, company_id, supplier, description, amount, data_scadenza, rimandato_al, sollecitato, invoice_number, pending_review, source, receipt_url, pagato_il, created_at, iban';

async function aperti(companyId) {
  const { data, error } = await supabase.from('company_expenses').select(COLS)
    .eq('company_id', companyId).eq('da_pagare', true).is('pagato_il', null);
  dbErr(error);
  return data || [];
}

const ORDINE = ['subito', 'da_controllare', 'settimana', 'piu_avanti'];
function ordina(righe) {
  return righe.sort((a, b) => ORDINE.indexOf(a.gruppo) - ORDINE.indexOf(b.gruppo)
    || (a.data || '9999') .localeCompare(b.data || '9999') || a.fornitore.localeCompare(b.fornitore, 'it'));
}

/** La lista completa: righe aperte, totale della settimana, pagati del mese. */
async function elenco(companyId, { today = romeDate() } = {}) {
  const [aperte, pagatiRes] = await Promise.all([
    aperti(companyId),
    supabase.from('company_expenses').select(COLS).eq('company_id', companyId).eq('da_pagare', true)
      .gte('pagato_il', `${today.slice(0, 7)}-01`).order('pagato_il', { ascending: false }).limit(100),
  ]);
  dbErr(pagatiRes.error);
  const righe = ordina(aperte.map(r => riga(r, today)));
  const totaleSettimana = righe.filter(r => r.gruppo === 'subito' || r.gruppo === 'settimana').reduce((s, r) => s + r.importo, 0);
  const totale = Math.round(righe.reduce((s, r) => s + r.importo, 0) * 100) / 100;
  return {
    oggi: today,
    righe,
    totaleSettimana,
    totaleSettimanaTesto: euro(totaleSettimana),
    // F-357: quanto devi in tutto, la prima cosa della pagina
    totale,
    totaleTesto: euro(totale),
    pagatiQuestoMese: (pagatiRes.data || []).map(r => riga(r, today)),
  };
}

/** Per Da fare: le righe come voci della lista unica (kind 'pagamento'). */
async function vociDaFare(companyId, role, today) {
  // Solo per una persona con il ruolo giusto: lavagna e riepilogo email (senza utente) non le vedono
  if (!role || !RUOLI.includes(role) || !(await attivoPer(companyId))) return [];
  const righe = (await aperti(companyId)).map(r => riga(r, today));
  return righe.map(p => ({
    id: `pagamento:${p.id}`,
    pagamentoId: p.id,
    kind: 'pagamento',
    type: 'pagamento',
    title: p.fornitore,
    subtitle: p.sottotitolo,
    date: p.data,
    days: p.giorni ?? 999,
    bucket: p.gruppo === 'subito' ? 'scaduto' : p.gruppo === 'piu_avanti' ? 'mese' : 'settimana',
    severity: p.gruppo === 'subito' ? 'critical' : 'warning',
    urgent: p.gruppo === 'subito',
    link: '/scadenze?type=pagare',
    importo: p.importo,
    importoTesto: p.importoTesto,
    gruppoPagamento: p.gruppo,
    sollecitato: p.sollecitato,
    daControllare: p.daControllare,
    nome: p.nome,
    chiave: p.chiave,
  }));
}

/**
 * F-357: le fatture di Da fare (kind 'pagamento') in una riga sola, per "Tutto"
 * e per la card Buongiorno: quante, quanto, a chi. Pura; null se non ce ne sono.
 * Nessun tasto "Pagato" qui: si segna pagata solo da Da pagare, dove si vede la fattura.
 */
function riassuntoPagamenti(voci) {
  const v = (voci || []).filter(i => i.kind === 'pagamento');
  if (!v.length) return null;
  const n = v.length;
  const totale = Math.round(v.reduce((s, i) => s + Number(i.importo || 0), 0) * 100) / 100;
  const scadute = v.filter(i => i.days < 0).length;
  const daControllare = v.filter(i => i.daControllare).length;
  const fornitori = [];
  for (const i of [...v].sort((a, b) => a.days - b.days)) {
    const k = i.chiave || i.title;
    let f = fornitori.find(x => x.k === k);
    if (!f) { f = { k, nome: i.nome || i.title, sollecitato: false }; fornitori.push(f); }
    if (i.sollecitato) f.sollecitato = true;
  }
  const soll = fornitori.filter(f => f.sollecitato).length;
  const minGiorni = Math.min(...v.map(i => i.days));
  const stato = scadute === n ? (n === 1 ? 'scaduta' : 'tutte scadute')
    : scadute > 0 ? `${scadute} ${scadute === 1 ? 'scaduta' : 'scadute'}`
      : minGiorni === 0 ? (n === 1 ? 'scade oggi' : 'una scade oggi')
        : minGiorni === 1 ? (n === 1 ? 'scade domani' : 'una scade domani')
          : minGiorni <= 7 ? 'entro questa settimana' : null;
  const fatture = n === 1 ? '1 fattura da pagare' : `${n} fatture da pagare`;
  const nomi = fornitori.slice(0, 3).map(f => f.nome).join(', ') + (fornitori.length > 3 ? ` e altri ${fornitori.length - 3}` : '');
  const sollTesto = !soll ? null
    : soll === fornitori.length ? (soll === 1 ? 'ha sollecitato' : 'tutti hanno sollecitato')
      : `${soll} ${soll === 1 ? 'ha sollecitato' : 'hanno sollecitato'}`;
  return {
    id: 'pagamenti',
    n,
    totale,
    totaleTesto: euro(totale),
    scadute,
    daControllare,
    sollecitati: soll,
    urgente: scadute > 0 || soll > 0,
    titolo: stato ? `${fatture}, ${stato}` : fatture,
    dettaglio: [nomi, sollTesto, daControllare ? `${daControllare} da controllare` : null].filter(Boolean).join(' · '),
    link: '/scadenze?type=pagare',
  };
}

// ── Scritture ───────────────────────────────────────────────────────────────
async function rigaDellAzienda(companyId, id) {
  const { data, error } = await supabase.from('company_expenses').select(COLS)
    .eq('id', id).eq('company_id', companyId).eq('da_pagare', true).maybeSingle();
  dbErr(error);
  if (!data) throw errore('NOT_FOUND', 'Pagamento non trovato', 404);
  return data;
}

function importoValido(v) {
  const { leggiImporto } = require('./daPagareLettura');
  const n = leggiImporto(v);
  if (n == null || n <= 0 || n > 10_000_000) throw errore('IMPORTO', 'Scrivi quanto devi pagare');
  return Math.round(n * 100) / 100;
}
function dataValida(v, campo = 'Entro quando') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw errore('DATA', `${campo}: data non valida`);
  return v;
}

/** Stessa fattura già in lista (stesso fornitore, numero e importo). */
async function doppione(companyId, { fornitore, numero, importo }) {
  if (!numero) return null;
  const { data, error } = await supabase.from('company_expenses').select('id, supplier, amount, invoice_number')
    .eq('company_id', companyId).eq('invoice_number', String(numero)).limit(20);
  dbErr(error);
  return (data || []).find(r => Number(r.amount) === importo && normNome(r.supplier) === normNome(fornitore)) || null;
}

async function crea({ companyId, userId, fornitore, importo, entro, sollecitato = false, numeroFattura = null, iban = null, file = null, today = romeDate() }) {
  const chi = testo(fornitore, 160);
  if (chi.length < 2) throw errore('FORNITORE', 'Scrivi a chi devi pagare');
  const q = importoValido(importo);
  const data = dataValida(entro);
  const numero = numeroFattura ? testo(numeroFattura, 40) : null;
  const gia = await doppione(companyId, { fornitore: chi, numero, importo: q });
  if (gia) throw errore('DOPPIONE', `Questa fattura c'è già: ${gia.supplier}, n. ${gia.invoice_number}, ${euro(gia.amount)}`, 409);
  const { data: row, error } = await supabase.from('company_expenses').insert({
    company_id: companyId, created_by: userId || null,
    amount: q, supplier: chi, description: `Da pagare: ${chi}`, category: 'altro', payment_method: 'bonifico',
    expense_date: today, data_scadenza: data, invoice_number: numero,
    sollecitato: !!sollecitato, da_pagare: true, source: 'manual', iban: ibanValido(iban),
    pending_review: false,
  }).select(COLS).single();
  dbErr(error);
  if (file?.buffer?.length) {
    const ext = (String(file.originalname || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
    const storagePath = `${companyId}/expenses/${row.id}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (!upErr) { await supabase.from('company_expenses').update({ receipt_url: storagePath }).eq('id', row.id); row.receipt_url = storagePath; }
    else console.error('[da-pagare] foto non salvata:', upErr.message);
  }
  return riga(row, today);
}

async function aggiorna({ companyId, id, fornitore, importo, entro, sollecitato, iban, today = romeDate() }) {
  await rigaDellAzienda(companyId, id);
  const patch = { updated_at: new Date().toISOString() };
  if (fornitore !== undefined) { const chi = testo(fornitore, 160); if (chi.length < 2) throw errore('FORNITORE', 'Scrivi a chi devi pagare'); patch.supplier = chi; patch.description = `Da pagare: ${chi}`; }
  if (importo !== undefined) patch.amount = importoValido(importo);
  if (entro !== undefined) { patch.data_scadenza = dataValida(entro); patch.rimandato_al = null; }
  if (sollecitato !== undefined) patch.sollecitato = !!sollecitato;
  if (iban !== undefined) {
    if (iban === null || String(iban).trim() === '') patch.iban = null;
    else { const v = ibanValido(iban); if (!v) throw errore('IBAN', 'IBAN non valido: controlla le cifre'); patch.iban = v; }
  }
  const { data, error } = await supabase.from('company_expenses').update(patch).eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

/** "È giusto": una riga letta da PDF/foto senza XML diventa una riga normale. */
async function conferma({ companyId, id, today = romeDate() }) {
  await rigaDellAzienda(companyId, id);
  const { data, error } = await supabase.from('company_expenses')
    .update({ pending_review: false, pending_review_reason: null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

/** F-357: "Pagata oggi / ieri / altro giorno". Mai nel futuro, al massimo un anno fa. */
function dataPagamento(il, today) {
  if (il === undefined || il === null || il === '') return today;
  const d = dataValida(il, 'Pagata il');
  if (d > today) throw errore('DATA', 'Pagata il: non può essere nel futuro');
  if (d < addDays(today, -366)) throw errore('DATA', 'Pagata il: più di un anno fa');
  return d;
}

async function pagato({ companyId, id, il, today = romeDate() }) {
  const quando = dataPagamento(il, today);
  const r = await rigaDellAzienda(companyId, id);
  if (r.pagato_il) return riga(r, today);
  const { data, error } = await supabase.from('company_expenses').update({ pagato_il: quando, pending_review: false, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

async function nonPagato({ companyId, id, today = romeDate() }) {
  await rigaDellAzienda(companyId, id);
  const { data, error } = await supabase.from('company_expenses').update({ pagato_il: null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

/** "Rimanda": torna da `giorni` giorni da oggi (o da una data scelta). Spegne il sollecito. */
async function rimanda({ companyId, id, giorni, al, today = romeDate() }) {
  await rigaDellAzienda(companyId, id);
  let quando = al ? dataValida(al, 'Rimanda') : null;
  if (!quando) {
    const n = Number(giorni);
    if (!Number.isInteger(n) || n < 1 || n > 90) throw errore('GIORNI', 'Rimanda di 1–90 giorni');
    quando = addDays(today, n);
  }
  const { data, error } = await supabase.from('company_expenses').update({ rimandato_al: quando, sollecitato: false, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

/** Annulla un "Rimanda" (tasto Annulla del messaggio). */
async function annullaRimanda({ companyId, id, sollecitato, today = romeDate() }) {
  await rigaDellAzienda(companyId, id);
  const patch = { rimandato_al: null, updated_at: new Date().toISOString() };
  if (sollecitato !== undefined) patch.sollecitato = !!sollecitato;
  const { data, error } = await supabase.from('company_expenses').update(patch).eq('id', id).eq('company_id', companyId).select(COLS).single();
  dbErr(error);
  return riga(data, today);
}

async function elimina({ companyId, id }) {
  const r = await rigaDellAzienda(companyId, id);
  if (r.receipt_url) await supabase.storage.from(BUCKET).remove([r.receipt_url]).catch(() => {});
  const { error } = await supabase.from('company_expenses').delete().eq('id', id).eq('company_id', companyId);
  dbErr(error);
  return { ok: true };
}

async function fotoFirmata({ companyId, id }) {
  const r = await rigaDellAzienda(companyId, id);
  if (!r.receipt_url) throw errore('NOT_FOUND', 'Nessuna foto', 404);
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(r.receipt_url, 600);
  if (!data?.signedUrl) throw errore('STORAGE_ERROR', 'Foto non disponibile', 500);
  return { url: data.signedUrl };
}

module.exports = {
  FLAG, RUOLI, attivoPer, puoVedere, errore, euro,
  elenco, vociDaFare, riassuntoPagamenti, crea, aggiorna, conferma, pagato, nonPagato, rimanda, annullaRimanda, elimina, fotoFirmata,
  // per i test
  riga, dataEffettiva, quandoTesto, normNome, nomeBreve, importoValido, dataPagamento,
};
