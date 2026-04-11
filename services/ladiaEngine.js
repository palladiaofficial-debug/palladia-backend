'use strict';
/**
 * services/ladiaEngine.js
 * Costruisce il contesto arricchito per Ladia In Cantiere.
 *
 * Estende il buildSiteContext di telegramLadia.js aggiungendo:
 * - Fasi di lavoro (stato, progresso, lavoratori assegnati)
 * - Costi reali vs. capitolato (con alert sforamento)
 * - Riassunto capitolato
 * - Timbrature degli ultimi 3 giorni (chi sta lavorando su cosa)
 * - Analisi proattiva: fasi a rischio, fasi bloccate, prossima fase
 */

const supabase = require('../lib/supabase');
const { getWeatherSummary } = require('./weatherService');

/**
 * Formatta importo in euro locale italiano.
 */
function fmt(num) {
  if (num == null || isNaN(num)) return '—';
  return '€' + parseFloat(num).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Builds the enriched Ladia context string for a given site.
 * Usato sia nel briefing mattutino che nelle risposte Telegram.
 *
 * @returns {string} — testo strutturato da iniettare nel system prompt
 */
async function buildEnrichedContext(companyId, siteId) {
  const today     = new Date();
  const threeDays = new Date(today.getTime() - 3 * 86400000).toISOString();

  const [
    siteRes, phasesRes, costsRes, voceContrattoRes,
    workersRes, timbratureRes, notesRes, ncRes, cfgRes,
  ] = await Promise.all([
    supabase.from('sites')
      .select('name, address, status, budget_totale, sal_percentuale, descrizione, latitude, longitude')
      .eq('id', siteId).maybeSingle(),
    supabase.from('site_phases')
      .select('id, nome, stato, progresso_percentuale, data_inizio_prevista, data_fine_prevista, importo_contratto, importo_maturato, note')
      .eq('site_id', siteId)
      .order('sort_order').order('created_at'),
    supabase.from('site_costs')
      .select('phase_id, importo, data_documento, descrizione, fornitore, tipo')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase.from('capitolato_voci')
      .select('categoria, importo_contratto')
      .eq('site_id', siteId),
    supabase.from('workers')
      .select('id, full_name, qualification, role')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .limit(60),
    supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId)
      .gte('timestamp_server', threeDays)
      .order('timestamp_server', { ascending: false })
      .limit(200),
    supabase.from('site_notes')
      .select('category, content, urgency, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(8),
    supabase.from('site_notes')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId)
      .eq('category', 'non_conformita')
      .is('resolved_at', null),
    supabase.from('ladia_site_config')
      .select('capitolato_summary, is_active')
      .eq('site_id', siteId).maybeSingle(),
  ]);

  const site    = siteRes.data;
  const phases  = phasesRes.data  || [];
  const costs   = costsRes.data   || [];
  const vociCap = voceContrattoRes.data || [];
  const workers = workersRes.data || [];
  const timb    = timbratureRes.data || [];
  const notes   = notesRes.data   || [];
  const ncCount = ncRes.count     || 0;
  const cfg     = cfgRes.data;

  if (!site) return 'Cantiere non trovato.';

  // ── Meteo (fire-and-forget, no block) ──
  let weather = '';
  if (site.latitude && site.longitude) {
    try {
      weather = await Promise.race([
        getWeatherSummary(site.latitude, site.longitude),
        new Promise(resolve => setTimeout(() => resolve(''), 3000)),
      ]);
    } catch { /* noop */ }
  }

  // ── Analisi costi per fase ──
  const costsByPhase = {};
  for (const c of costs) {
    if (c.phase_id) costsByPhase[c.phase_id] = (costsByPhase[c.phase_id] || 0) + (parseFloat(c.importo) || 0);
  }
  const totalCostiReali = costs.reduce((s, c) => s + (parseFloat(c.importo) || 0), 0);

  // Totale contrattuale dal capitolato
  const totalContratto = vociCap.reduce((s, v) => s + (parseFloat(v.importo_contratto) || 0), 0);

  // ── Analisi fasi proattiva ──
  const fasiInCorso     = phases.filter(p => p.stato === 'in_corso');
  const fasiCompletate  = phases.filter(p => p.stato === 'completata');
  const fasiNonInit     = phases.filter(p => p.stato === 'non_iniziata');

  // Fasi a rischio sforamento: costi reali > importo_contratto
  const fasiSforamento = phases.filter(p =>
    p.importo_contratto != null &&
    (costsByPhase[p.id] || 0) > parseFloat(p.importo_contratto)
  );

  // Prossima fase da iniziare (entro 14 giorni o prima non_iniziata)
  const prossimaFase = fasiNonInit.find(p => {
    if (!p.data_inizio_prevista) return true;
    const diff = new Date(p.data_inizio_prevista) - today;
    return diff < 14 * 86400000;
  });

  // ── Lavoratori attivi (timbrature ultimi 3gg) ──
  const workerIds = [...new Set(timb.map(t => t.worker_id))];
  const workerMap = Object.fromEntries(workers.map(w => [w.id, w.full_name]));
  const workersAttivi = workerIds.map(id => workerMap[id]).filter(Boolean);

  // ── Costruzione testo contesto ──
  const lines = [];

  lines.push(`🏗️ CANTIERE: ${site.name}`);
  if (site.address)    lines.push(`📍 ${site.address}`);
  if (site.status)     lines.push(`📋 Stato: ${site.status}`);
  if (weather)         lines.push(`🌤️ Meteo: ${weather}`);

  // Budget complessivo
  if (totalContratto > 0) {
    const margine = totalContratto - totalCostiReali;
    const pct     = totalContratto > 0 ? Math.round((totalCostiReali / totalContratto) * 100) : 0;
    lines.push(`\n💶 BUDGET`);
    lines.push(`  Contratto: ${fmt(totalContratto)} | Speso: ${fmt(totalCostiReali)} (${pct}%) | Margine: ${fmt(margine)}`);
    if (pct > 85) lines.push(`  ⚠️ ATTENZIONE: spesa vicina al budget contrattuale`);
  } else if (site.budget_totale) {
    lines.push(`\n💶 Budget totale: ${fmt(site.budget_totale)}`);
  }

  // Capitolato summary
  if (cfg?.capitolato_summary) {
    lines.push(`\n📄 CAPITOLATO`);
    lines.push(`  ${cfg.capitolato_summary}`);
  }

  // Fasi di lavoro
  if (phases.length > 0) {
    lines.push(`\n📊 FASI DI LAVORO (${phases.length} totali)`);

    for (const fase of phases) {
      const ico   = { non_iniziata: '⬜', in_corso: '🔵', completata: '✅', sospesa: '⏸️' }[fase.stato] || '⬜';
      const contr = fase.importo_contratto ? ` | Contratto: ${fmt(parseFloat(fase.importo_contratto))}` : '';
      const speso = costsByPhase[fase.id]   ? ` | Speso: ${fmt(costsByPhase[fase.id])}` : '';
      const sfor  = fasiSforamento.some(f => f.id === fase.id) ? ' 🔴 SFORAMENTO' : '';
      const prog  = fase.stato === 'in_corso' ? ` [${fase.progresso_percentuale}%]` : '';
      const date  = fase.data_fine_prevista ? ` | Fine prevista: ${new Date(fase.data_fine_prevista).toLocaleDateString('it-IT')}` : '';
      lines.push(`  ${ico} ${fase.nome}${prog}${contr}${speso}${sfor}${date}`);
    }

    if (fasiSforamento.length > 0) {
      lines.push(`\n  🔴 ALERT SFORAMENTO su: ${fasiSforamento.map(f => f.nome).join(', ')}`);
    }
    if (prossimaFase) {
      lines.push(`\n  ➡️ PROSSIMA FASE DA AVVIARE: "${prossimaFase.nome}"` +
        (prossimaFase.data_inizio_prevista ? ` (prevista ${new Date(prossimaFase.data_inizio_prevista).toLocaleDateString('it-IT')})` : ''));
    }
  }

  // Ultimi costi registrati
  if (costs.length > 0) {
    lines.push(`\n🧾 ULTIMI COSTI REGISTRATI`);
    for (const c of costs.slice(0, 5)) {
      const data = c.data_documento ? new Date(c.data_documento).toLocaleDateString('it-IT') : 'n.d.';
      lines.push(`  • ${c.descrizione}${c.fornitore ? ` (${c.fornitore})` : ''} — ${fmt(parseFloat(c.importo))} [${data}]`);
    }
  }

  // Presenza lavoratori
  if (workersAttivi.length > 0) {
    lines.push(`\n👷 LAVORATORI ATTIVI (ultimi 3gg): ${workersAttivi.slice(0, 8).join(', ')}`);
  }

  // NC aperte
  if (ncCount > 0) {
    lines.push(`\n⚠️ Non conformità aperte: ${ncCount}`);
  }

  // Note recenti
  if (notes.length > 0) {
    lines.push(`\n📝 NOTE RECENTI`);
    for (const n of notes.slice(0, 4)) {
      const data = new Date(n.created_at).toLocaleDateString('it-IT');
      lines.push(`  [${data}] ${n.content?.slice(0, 120)}${n.content?.length > 120 ? '…' : ''}`);
    }
  }

  return lines.join('\n');
}

module.exports = { buildEnrichedContext };
