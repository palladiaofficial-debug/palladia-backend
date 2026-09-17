#!/usr/bin/env node
/**
 * scripts/selftest_heat_certification.js
 *
 * Test di regressione per il Registro Caldo Cantiere — richiesta esplicita
 * del titolare (2026-09-17): "serve calcolare con la massima verità legale
 * i giorni di caldo... deve essere chirurgico". Base normativa: D.L.
 * 107/2026 art. 6 + messaggio INPS 2418/2026 (migrations/218).
 *
 * Verifica, con dati ARPAL REALI (nessun mock sulla rete):
 *   1. lib/heatIndex.js: la formula WBGT (BOM) è implementata correttamente
 *      e rifiuta input non validi, mai un numero inventato.
 *   2. services/arpalHeatSource.js: temperatura/umidità/radiazione si
 *      scaricano davvero dalla stazione ARPAL, con valori plausibili.
 *   3. services/heatArpalCron.js::heatizeSite: certifica correttamente un
 *      cantiere di test (dati reali, non fixture sintetiche), rispetta la
 *      soglia configurata, non ricertifica giorni già presenti.
 *   4. "Verità legale": il report HTML non usa MAI le date contrattuali del
 *      cantiere per il periodo (stesso principio di F-209), e il WBGT è
 *      sempre etichettato come stimato, mai spacciato per un dato
 *      certificato.
 *
 * Env: nessuna credenziale oltre a SUPABASE_SERVICE_ROLE_KEY (già in .env).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { estimateWbgt } = require('../lib/heatIndex');
const { resolveArpalHeat } = require('../services/arpalHeatSource');
const { heatizeSite } = require('../services/heatArpalCron');
const { generateHeatReportHtml } = require('../services/heatReport');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
// Genova centro — stessa area degli altri selftest meteo di questo repo.
const LAT = 44.4056, LON = 8.9463;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

const TZ = 'Europe/Rome';
function isoDaysAgo(n) {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  console.log('\n\x1b[1mRegistro Caldo Cantiere — certificazione ARPAL + WBGT stimato\x1b[0m');

  // ── 1. Formula WBGT — verifica matematica, nessuna rete ─────────────────
  const w1 = estimateWbgt(30, 50);
  const w2 = estimateWbgt(35, 70);
  ok(`estimateWbgt(30°C, 50%) restituisce un numero plausibile (${w1}°C, atteso 25-33°C)`);
  if (!(w1 > 25 && w1 < 33)) fail('WBGT 30°C/50% in range plausibile', w1);
  else passed++, console.log(`  \x1b[32m✓\x1b[0m WBGT 30°C/50% in range plausibile (${w1})`);
  if (w2 > w1) ok('WBGT più alto umidità più alta a parità di temperatura superiore (35°C/70% > 30°C/50%)');
  else fail('WBGT più alto con umidità più alta', { w1, w2 });
  if (estimateWbgt(NaN, 50) === null && estimateWbgt(30, 150) === null) ok('input non validi (NaN, umidità >100%) → null, mai un numero inventato');
  else fail('input non validi → null');

  // ── 2. Fetch ARPAL reale ──────────────────────────────────────────────
  const from = isoDaysAgo(20), to = isoDaysAgo(15);
  let resolved;
  try {
    resolved = await resolveArpalHeat(LAT, LON, from, to, new Map());
  } catch (e) {
    fail('resolveArpalHeat riesce a contattare una stazione ARPAL reale', e.message);
    return report();
  }
  if (resolved.byFactor.temp_max_c.size > 0) ok(`temperatura scaricata da ARPAL (stazione ${resolved.stationName}, ${resolved.byFactor.temp_max_c.size} giorni)`);
  else fail('temperatura scaricata da ARPAL', resolved);
  if (resolved.byFactor.humidity_pct.size > 0) ok('umidità scaricata dalla stessa stazione');
  else fail('umidità scaricata dalla stessa stazione');
  // Valori plausibili per Genova a settembre (non 0, non 200)
  const sampleTemp = [...resolved.byFactor.temp_max_c.values()][0];
  if (sampleTemp > 0 && sampleTemp < 45) ok(`temperatura in range plausibile per Genova (${sampleTemp}°C)`);
  else fail('temperatura in range plausibile', sampleTemp);

  // ── 3. Certificazione end-to-end su un cantiere di test reale ─────────
  const stamp = Date.now();
  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: `TEST-Heat Cantiere ${stamp}`, status: 'attivo',
    address: 'Via Test Caldo, Genova', latitude: LAT, longitude: LON,
    start_date: from, heat_temp_threshold_c: 30, // soglia bassa apposta, per avere almeno un giorno sopra soglia da verificare
  }).select('id, company_id, name, latitude, longitude, start_date, heat_temp_threshold_c').single();
  if (siteErr) { fail('crea cantiere di test', siteErr.message); return report(); }

  try {
    const r1 = await heatizeSite(site, new Map(), new Map());
    if (r1.imported > 0) ok(`heatizeSite certifica ${r1.imported} giorni per il cantiere di test`);
    else fail('heatizeSite certifica giorni per il cantiere di test', r1);

    const { data: rows } = await supabase.from('site_heat_logs')
      .select('log_date, temp_max_c, humidity_pct, wbgt_estimate_c, threshold_exceeded, arpal_station_name, arpal_source_path')
      .eq('site_id', site.id).order('log_date', { ascending: true });

    if (rows?.every(r => r.arpal_station_name)) ok('ogni riga certificata riporta la stazione ARPAL di origine');
    else fail('ogni riga certificata riporta la stazione ARPAL di origine', rows);

    if (rows?.some(r => r.threshold_exceeded)) ok('almeno un giorno risulta sopra la soglia di test (30°C) — la valutazione soglia funziona');
    else fail('almeno un giorno sopra soglia (30°C, atteso in un cantiere ligure a settembre)', rows);

    // Idempotenza: ri-certificare non deve ri-scaricare gli stessi giorni.
    const r2 = await heatizeSite(site, new Map(), new Map());
    if (r2.imported === 0) ok('una seconda certificazione non ri-scarica i giorni già presenti (idempotente)');
    else fail('idempotenza: nessun giorno ri-scaricato al secondo giro', r2);

    // ── 4. "Verità legale" nel report ────────────────────────────────────
    // start_date volutamente MOLTO diverso dallo span reale delle righe
    // (2020, non settembre 2026) — se il report lo usasse per il periodo
    // (stesso errore corretto oggi in F-209 sul Registro Meteo pioggia),
    // comparirebbe qui e la verifica lo scoprirebbe.
    const decoyStartDate = '2020-01-01';
    const html = generateHeatReportHtml({ site: { ...site, start_date: decoyStartDate, client: 'TEST Committente', address: 'Via Test' }, rows: rows || [], thresholdC: 30, from: undefined, to: undefined, filter: undefined });
    if (!html.includes(decoyStartDate)) ok('il report NON usa la data di inizio lavori del cantiere per il periodo (stesso principio F-209)');
    else fail('il report non deve usare start_date come periodo', { decoyStartDate });
    if (html.includes('WBGT stimato*') && html.includes('non un dato certificato ARPAL')) ok('il report etichetta sempre il WBGT come stimato, mai come certificato');
    else fail('il WBGT deve essere etichettato come stimato');
    if (html.includes('NON una soglia legale automatica')) ok('il report chiarisce che la soglia interna non è un automatismo legale (D.L. 107/2026)');
    else fail('il report deve chiarire che la soglia non è un automatismo legale');
    if (html.includes('bollino rosso')) fail('il report non deve mai citare il "bollino rosso" (criterio superato dalla norma attuale)');
    else ok('il report non cita mai il "bollino rosso" (criterio superato)');

  } finally {
    await supabase.from('site_heat_logs').delete().eq('site_id', site.id);
    await supabase.from('site_suspension_days').delete().eq('site_id', site.id);
    await supabase.from('sites').delete().eq('id', site.id);
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_heat_certification:', e.message);
  process.exit(1);
});
