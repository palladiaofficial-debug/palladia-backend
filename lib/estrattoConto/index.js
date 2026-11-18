'use strict';
/**
 * lib/estrattoConto/index.js — F-513 (AUDIT.md del frontend, 18/11/2026).
 *
 * Il titolare carica l'estratto conto (Excel/CSV): i movimenti si salvano una
 * volta sola (impronta: ricaricare lo stesso mese non li raddoppia), Palladia
 * propone le fatture di Da pagare che risultano pagate (abbina.js) e il titolare
 * conferma. Una fattura confermata prende la data del bonifico e il segno «lo
 * dice la banca» (pagato_banca_at). Niente IA: i movimenti restano sul server.
 */
const crypto = require('crypto');
const supabase = require('../supabase');
const { leggiEstratto } = require('./leggi');
const { abbina } = require('./abbina');

const ERRORI = {
  PDF: 'È un PDF: dalla banca scarica i movimenti in Excel o CSV (c\'è quasi sempre il tasto «Esporta»).',
  XLS_VECCHIO: 'È un Excel vecchio (.xls): aprilo e salvalo come .xlsx, oppure scarica il CSV dalla banca.',
  COLONNE: 'Non trovo le colonne della data e dell\'importo: è proprio il file dei movimenti della banca?',
  VUOTO: 'Nel file non ci sono movimenti.',
};
// errore('PDF') → messaggio della tabella; errore('frase…') → la frase, codice NON_VALIDO
const errore = (code, status = 400) => Object.assign(new Error(ERRORI[code] || code), { code: ERRORI[code] ? code : 'NON_VALIDO', status });
const cent = (n) => Math.round(Math.abs(Number(n) || 0) * 100);

/** Salva l'estratto e i movimenti nuovi; ritorna le proposte. */
async function carica({ companyId, userId, buffer, nomeFile, mime }) {
  const letto = await leggiEstratto(buffer, nomeFile, mime);
  if (letto.errore) throw errore(letto.errore);
  if (!letto.movimenti.length) throw errore('VUOTO');
  const date = letto.movimenti.map(m => m.data).sort();
  const { data: est, error } = await supabase.from('estratti_conto').insert({
    company_id: companyId, nome_file: String(nomeFile || '').slice(0, 200), movimenti: letto.movimenti.length,
    dal: date[0], al: date[date.length - 1], caricato_da: userId || null,
  }).select('id').single();
  if (error) throw new Error(error.message);
  // Due movimenti identici nello stesso giorno (due bonifici uguali) restano due: l'impronta conta le ripetizioni
  const visti = {};
  const righe = letto.movimenti.map(m => {
    const base = `${m.data}|${m.importo.toFixed(2)}|${m.descrizione.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    visti[base] = (visti[base] || 0) + 1;
    return {
      company_id: companyId, estratto_id: est.id, data: m.data, importo: m.importo, descrizione: m.descrizione,
      impronta: crypto.createHash('sha256').update(`${base}#${visti[base]}`).digest('hex'),
    };
  });
  const { data: nuovi, error: e2 } = await supabase.from('estratto_movimenti')
    .upsert(righe, { onConflict: 'company_id,impronta', ignoreDuplicates: true }).select('id');
  if (e2) throw new Error(e2.message);
  const p = await proposte(companyId);
  return { ...p, letti: { movimenti: letto.movimenti.length, nuovi: nuovi?.length || 0, dal: date[0], al: date[date.length - 1] } };
}

/** Le proposte aperte: movimenti in uscita non ancora usati né scartati ↔ fatture non ancora pagate davvero. */
async function proposte(companyId) {
  const da = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const [{ data: mov, error: e1 }, { data: fat, error: e2 }, { data: usati, error: e3 }] = await Promise.all([
    supabase.from('estratto_movimenti').select('id, data, importo, descrizione')
      .eq('company_id', companyId).is('scartato_at', null).lt('importo', 0).gte('data', da).order('data'),
    supabase.from('company_expenses').select('id, supplier, amount, invoice_number, expense_date, pagato_il, is_credit_note')
      .eq('company_id', companyId).eq('da_pagare', true).is('pagato_banca_at', null).gte('expense_date', da),
    supabase.from('company_expenses').select('pagato_movimento_id').eq('company_id', companyId).not('pagato_movimento_id', 'is', null),
  ]);
  if (e1 || e2 || e3) throw new Error((e1 || e2 || e3).message);
  const presi = new Set((usati || []).map(u => u.pagato_movimento_id));
  const movimenti = (mov || []).filter(m => !presi.has(m.id)).map(m => ({ ...m, importo: Number(m.importo) }));
  const fatture = (fat || []).filter(f => !f.is_credit_note).map(f => ({
    id: f.id, fornitore: f.supplier, importo: Number(f.amount), data: f.expense_date, numero: f.invoice_number,
  }));
  const ris = abbina(movimenti, fatture);
  const forma = (r) => ({
    movimento: { id: r.movimento.id, data: r.movimento.data, importo: r.movimento.importo, descrizione: r.movimento.descrizione },
    fatture: r.fatture.map(f => ({ id: f.id, fornitore: f.fornitore, importo: f.importo, numero: f.numero })),
  });
  return {
    sicure: ris.filter(r => r.tipo === 'sicuro').map(forma),
    dubbie: ris.filter(r => r.tipo === 'da_confermare').map(forma),
  };
}

/** Il titolare conferma: quelle fatture sono pagate con quel movimento. */
async function conferma(companyId, movimentoId, expenseIds) {
  if (!Array.isArray(expenseIds) || !expenseIds.length || expenseIds.length > 6) throw errore('Scegli le fatture pagate con questo movimento.');
  const { data: m } = await supabase.from('estratto_movimenti').select('id, data, importo')
    .eq('id', movimentoId).eq('company_id', companyId).maybeSingle();
  if (!m) throw errore('Movimento non trovato.', 404);
  const { data: gia } = await supabase.from('company_expenses').select('id').eq('company_id', companyId).eq('pagato_movimento_id', m.id).limit(1);
  if (gia?.length) throw errore('Questo movimento è già stato usato per altre fatture.', 409);
  const { data: fat } = await supabase.from('company_expenses').select('id, amount, pagato_banca_at')
    .eq('company_id', companyId).in('id', expenseIds);
  if ((fat || []).length !== expenseIds.length) throw errore('Fattura non trovata.', 404);
  if (fat.some(f => f.pagato_banca_at)) throw errore('Una di queste fatture è già segnata pagata dalla banca.', 409);
  if (fat.reduce((s, f) => s + cent(f.amount), 0) !== cent(m.importo)) throw errore('L\'importo delle fatture non è uguale al movimento.');
  const { error } = await supabase.from('company_expenses')
    .update({ pagato_il: m.data, pagato_banca_at: new Date().toISOString(), pagato_movimento_id: m.id })
    .eq('company_id', companyId).in('id', expenseIds);
  if (error) throw new Error(error.message);
  return { ok: true, pagatoIl: m.data };
}

/** Il titolare dice «No»: questo movimento non si propone più. */
async function scarta(companyId, movimentoId) {
  const { data, error } = await supabase.from('estratto_movimenti').update({ scartato_at: new Date().toISOString() })
    .eq('id', movimentoId).eq('company_id', companyId).select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw errore('Movimento non trovato.', 404);
  return { ok: true };
}

module.exports = { carica, proposte, conferma, scarta, ERRORI };
