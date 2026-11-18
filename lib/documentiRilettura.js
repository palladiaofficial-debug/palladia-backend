'use strict';
/**
 * lib/documentiRilettura.js — F-507 (AUDIT.md del frontend).
 *
 * La lettura IA dei documenti d'impresa e di cantiere parte una volta sola al
 * caricamento, senza aspettarla. Se fallisce (credito finito come in F-416,
 * rete, risposta non valida) ai_analyzed_at resta vuoto e il documento rimane
 * «Senza scadenza» per sempre. Chi carica da «Importa cartella» o da Ladia non
 * la fa nemmeno partire. Qui si ritrovano i documenti mai letti e si rileggono.
 *
 * Solo imprese vere (non le fixture dei test), solo PDF e immagini, caricati da
 * più di un'ora (la lettura al caricamento ha avuto il suo tempo), al massimo
 * MAX_PER_GIRO per giro: i crediti Anthropic si spendono con giudizio.
 */
const supabase = require('./supabase');
const { analyzeCompanyDoc, analyzeSiteDoc } = require('../services/documentAI');

const PROVA = /^(test|e2e)|test-|f184|prova|autoexplore/i;
const MAX_PER_GIRO = 25;
const TABELLE = { company_documents: analyzeCompanyDoc, site_documents: analyzeSiteDoc };

/** Documenti da rileggere, i più recenti prima: [{ tabella, id, file_path, mime_type, company }] */
async function daRileggere({ max = MAX_PER_GIRO } = {}) {
  const unOraFa = new Date(Date.now() - 3600 * 1000).toISOString();
  const tutti = [];
  for (const tabella of Object.keys(TABELLE)) {
    const { data, error } = await supabase.from(tabella)
      .select('id, file_path, mime_type, created_at, companies(name)')
      .is('ai_analyzed_at', null).is('ai_expiry_date', null)
      .not('file_path', 'is', null).lt('created_at', unOraFa)
      .or('mime_type.eq.application/pdf,mime_type.like.image/%')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error(`${tabella}: ${error.message}`);
    for (const r of data || []) {
      const company = r.companies?.name || '';
      if (PROVA.test(company)) continue;
      tutti.push({ tabella, id: r.id, file_path: r.file_path, mime_type: r.mime_type, created_at: r.created_at, company });
    }
  }
  tutti.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return tutti.slice(0, max);
}

/** Rilegge un giro di documenti uno alla volta. Ritorna { provati, letti }. */
async function rileggi(opts = {}) {
  const lista = await daRileggere(opts);
  let letti = 0;
  for (const d of lista) {
    if (await TABELLE[d.tabella](d.id, d.file_path, d.mime_type)) letti++;
  }
  if (lista.length) console.log(`[documentiRilettura] ${letti}/${lista.length} documenti riletti`);
  return { provati: lista.length, letti };
}

/** Ogni giorno alle 5:40 (ora di Roma), lontano dagli altri lavori della notte. */
function startDocumentiRiletturaCron() {
  const cron = require('node-cron');
  cron.schedule('40 5 * * *', () => {
    rileggi().catch(e => console.error('[documentiRilettura] fallita:', e.message));
  }, { timezone: 'Europe/Rome' });
}

module.exports = { daRileggere, rileggi, startDocumentiRiletturaCron, MAX_PER_GIRO };
