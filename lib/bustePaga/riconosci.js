'use strict';
/**
 * lib/bustePaga/riconosci.js — F-496 (AUDIT.md del frontend): una busta paga o
 * un prospetto paghe si riconosce dal CONTENUTO, non dal nome del file.
 *
 * Documenti (impresa, cantieri, lavoratori) lo vedono anche tecnici e
 * coordinatori; le paghe le vede solo l'ufficio (F-494). Ogni strada che salva
 * un file in Documenti chiama prima `fermaPaghe()`: se il PDF è una busta o un
 * prospetto, non va in Documenti ma fra i «Prospetti del commercialista» della
 * scheda Buste paga (buste_caricamenti.riepilogo_path, solo owner/admin).
 *
 * Senza AI: le parole che stanno su ogni cedolino italiano (LUL) e mai insieme
 * su DURC, UNILAV, F24, POS o contratti. Servono almeno 3 segni, di cui uno
 * «da busta» (competenze e trattenute, periodo di liquidazione, cedolino).
 * Limite: un PDF senza testo (foto, scansione) non si riconosce.
 */
const crypto = require('crypto');
const supabase = require('../supabase');
const { extractPdfText } = require('../pdfExtract');
const { inspectPdf } = require('../pdfSplit');
const { MESI } = require('./dividi');

const BUCKET = 'site-documents';
const senzaAccenti = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ');

const SEGNI = {
  competenzeTrattenute: (t) => /\bCOMPETENZE\b/.test(t) && /\bTRATTENUTE\b/.test(t),
  periodoLiquidazione: (t) => /PERIODO DI (LIQUIDAZIONE|PAGA|RETRIBUZIONE)/.test(t),
  cedolino: (t) => /\bCEDOLINO\b|\bBUSTA PAGA\b|\bPROSPETTO PAGA\b/.test(t),
  netto: (t) => /\bNETTO (DEL MESE|IN BUSTA|A PAGARE|BUSTA|MESE)\b|\bTOTALE NETTO\b/.test(t),
  imponibile: (t) => /\bIMPONIBILE (FISCALE|PREVIDENZIALE|IRPEF|INPS|CONTRIBUTIVO)\b|\bIMP\.? ?IRPEF\b/.test(t),
  inpsInail: (t) => /POSIZIONE INPS/.test(t) && /PAT INAIL/.test(t),
  riepilogoPaghe: (t) => /TOTALE CONTRIBUTI INPS|DIPENDENTI \(NORM\)|CO\.?CO\.?CO\.? \(NORM\)|\bF\.P\.L\.D\b|RETRIBUZIONE ORDINARIA/.test(t),
  tfr: (t) => /\bT\.?F\.?R\.?\b.*\b(QUOTA|FONDO|MATURATO|RIVALUT)/.test(t) || /RATEO (13|14|TREDICESIMA|QUATTORDICESIMA)/.test(t),
};
const PERIODO_RE = /(GENNAIO|FEBBRAIO|MARZO|APRILE|MAGGIO|GIUGNO|LUGLIO|AGOSTO|SETTEMBRE|OTTOBRE|NOVEMBRE|DICEMBRE) ?[/-]? ?(20\d\d)/;
const CENTRALI = ['competenzeTrattenute', 'periodoLiquidazione', 'cedolino'];

/** Dal testo: { paghe, segni, periodo: {anno, mese} | null } */
function sembraPaghe(testo) {
  const t = senzaAccenti(testo);
  const segni = Object.keys(SEGNI).filter(k => SEGNI[k](t));
  const paghe = segni.length >= 3 && segni.some(s => CENTRALI.includes(s));
  let periodo = null;
  const m = t.match(PERIODO_RE);
  if (m) periodo = { anno: Number(m[2]), mese: MESI.indexOf(m[1]) + 1 };
  return { paghe, segni, periodo };
}

/** Dal file: legge al massimo le prime 6 pagine. Non-PDF o PDF senza testo → non paghe. */
async function controllaFile(buffer, mime, nomeFile) {
  const pdf = /pdf/i.test(mime || '') || /\.pdf$/i.test(nomeFile || '');
  if (!pdf || !buffer?.length) return { paghe: false, segni: [], periodo: null };
  try {
    const r = await extractPdfText(buffer, { maxPages: 6, minChars: 0 });
    return sembraPaghe(typeof r === 'string' ? r : r?.text);
  } catch { return { paghe: false, segni: [], periodo: null }; }
}

/** Lo mette fra i «Prospetti del commercialista» (solo owner/admin). */
async function mettiInBuste({ companyId, userId, buffer, nomeFile, periodo, da }) {
  const ins = await inspectPdf(buffer).catch(() => null);
  const pagine = ins?.pageCount || 1;
  const mm = periodo ? String(periodo.mese).padStart(2, '0') : 'xx';
  const path = `payslips/${companyId}/_riepiloghi/${periodo?.anno || 'senza-data'}-${mm}-${crypto.randomUUID()}.pdf`;
  const up = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(up.error.message);
  const nome = `${String(nomeFile || 'Documento').slice(0, 120)} (caricato in Documenti)`;
  const { data, error } = await supabase.from('buste_caricamenti').insert({
    company_id: companyId, file_path: path, nome_file: String(nomeFile || '').slice(0, 200) || null, pagine,
    analisi: { daDocumenti: da || true }, created_by: userId || null, confermato_at: new Date().toISOString(),
    esito: { anno: periodo?.anno ?? null, mese: periodo?.mese ?? null, nome, daDocumenti: true },
    riepilogo_path: path, riepilogo_pagine: pagine,
  }).select('id').single();
  if (error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
  return data.id;
}

const MESSAGGIO = 'È una busta paga o un prospetto del commercialista: non la metto in Documenti, dove la vedono anche tecnici e coordinatori. L’ho messa in Persone › Buste paga, fra i «Prospetti del commercialista»: la vedono solo il titolare e gli amministratori. Per mandare le buste agli operai usa «Carica le buste del mese».';

/**
 * Da chiamare PRIMA di salvare in Documenti. Se è paghe la sposta in Buste paga
 * e ritorna { fermata: true, id, message }; altrimenti { fermata: false }.
 * `forza`: true quando chi carica ha già detto che è una busta (es. Ladia «busta_paga»).
 */
async function fermaPaghe({ companyId, userId, buffer, mime, nomeFile, da, forza = false }) {
  const c = await controllaFile(buffer, mime, nomeFile);
  const pdf = /pdf/i.test(mime || '') || /\.pdf$/i.test(nomeFile || '');
  if (!c.paghe && !(forza && pdf)) return { fermata: false };
  const id = await mettiInBuste({ companyId, userId, buffer, nomeFile, periodo: c.periodo, da });
  return { fermata: true, id, segni: c.segni, message: MESSAGGIO };
}

module.exports = { sembraPaghe, controllaFile, mettiInBuste, fermaPaghe, MESSAGGIO };
