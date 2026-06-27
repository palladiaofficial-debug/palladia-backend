'use strict';
/**
 * services/ladiaEngine.js
 * Costruisce il contesto arricchito per Ladia.
 *
 * Produce due livelli:
 * 1. SNAPSHOT — stato inferito del cantiere (ritardo, salute, blocchi) → Ladia parte già informata
 * 2. DETTAGLIO — fasi, costi, lavoratori, NC, note → Ladia può ragionare sui dati grezzi
 */

const supabase = require('../lib/supabase');
const { getWeatherSummary } = require('./weatherService');

function fmt(num) {
  if (num == null || isNaN(num)) return '—';
  return '€' + parseFloat(num).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Calcola inferenze di alto livello sul cantiere — ritardo, salute, blocchi.
 * Nessuna query DB: lavora sui dati già caricati da buildEnrichedContext.
 */
function computeSiteInferences(site, phases, costs, ncCount) {
  const today = new Date();
  const sal = parseFloat(site.sal_percentuale) || 0;
  const inf = {
    health_score: null,
    days_to_deadline: null,
    expected_progress: null,
    progress_gap: null,
    delay_days: null,
    budget_consumed_pct: null,
    over_budget: false,
    blockers: [],
  };

  // ── Scadenza ──
  if (site.end_date) {
    inf.days_to_deadline = Math.round((new Date(site.end_date) - today) / 86400000);
  }

  // ── Avanzamento vs piano ──
  if (site.start_date && site.end_date) {
    const start     = new Date(site.start_date);
    const end       = new Date(site.end_date);
    const totalDays = Math.max(1, (end - start) / 86400000);
    const elapsed   = Math.max(0, (today - start) / 86400000);
    inf.expected_progress = Math.min(100, Math.round((elapsed / totalDays) * 100));
    inf.progress_gap      = inf.expected_progress - sal;

    // Stima ritardo: giorni necessari all'attuale velocità vs giorni rimasti
    if (inf.progress_gap > 5 && elapsed > 0 && sal < 100) {
      const dailySpeed    = sal / Math.max(elapsed, 1);
      const daysNeeded    = dailySpeed > 0 ? (100 - sal) / dailySpeed : null;
      const daysRemaining = Math.max(0, (end - today) / 86400000);
      if (daysNeeded !== null) {
        inf.delay_days = Math.round(Math.max(0, daysNeeded - daysRemaining));
      }
    }
  }

  // ── Budget ──
  const totalCosts = costs.reduce((s, c) => s + (parseFloat(c.importo) || 0), 0);
  const budget     = parseFloat(site.budget_totale) || 0;
  if (budget > 0) {
    inf.budget_consumed_pct = Math.round((totalCosts / budget) * 100);
    inf.over_budget         = inf.budget_consumed_pct > 100;
  }

  // ── Blocchi ──
  if (ncCount > 0) {
    inf.blockers.push(`${ncCount} NC ${ncCount > 1 ? 'aperte' : 'aperta'}`);
  }
  if (inf.budget_consumed_pct > 90 && sal < 75) {
    inf.blockers.push('Budget quasi esaurito, SAL incompleto');
  }
  if (inf.over_budget) {
    inf.blockers.push('Budget sforato');
  }
  const costsByPhaseId = {};
  for (const c of costs) {
    if (c.phase_id) costsByPhaseId[c.phase_id] = (costsByPhaseId[c.phase_id] || 0) + (parseFloat(c.importo) || 0);
  }
  for (const p of phases) {
    if (p.importo_contratto && (costsByPhaseId[p.id] || 0) > parseFloat(p.importo_contratto)) {
      inf.blockers.push(`Sforamento: ${p.nome}`);
    }
  }
  if (inf.days_to_deadline !== null && inf.days_to_deadline >= 0 && inf.days_to_deadline <= 7) {
    inf.blockers.push(`Scadenza tra ${inf.days_to_deadline} giorni`);
  }

  // ── Health score (0–10) ──
  let score = 10;
  if (ncCount >= 1) score -= Math.min(3, ncCount);
  if (inf.progress_gap > 10)  score -= 2;
  if (inf.progress_gap > 20)  score -= 1;
  if (inf.budget_consumed_pct > 85 && sal < 75) score -= 2;
  if (inf.over_budget)        score -= 2;
  if (inf.days_to_deadline !== null && inf.days_to_deadline >= 0 && inf.days_to_deadline < 7) score -= 1;
  inf.health_score = Math.max(0, Math.min(10, score));

  return inf;
}

/**
 * Formatta le inferenze come blocco di testo compatto per il system prompt.
 */
function formatSnapshotBlock(site, inf) {
  const lines = [];

  // Intestazione con deadline
  let header = `Cantiere: ${site.name}`;
  if (site.end_date) {
    const deadlineStr = new Date(site.end_date).toLocaleDateString('it-IT');
    header += ` — Scadenza: ${deadlineStr}`;
    if (inf.days_to_deadline !== null) {
      header += inf.days_to_deadline < 0
        ? ` (SCADUTO da ${Math.abs(inf.days_to_deadline)} giorni)`
        : ` (${inf.days_to_deadline} giorni)`;
    }
  }
  lines.push(header);

  // Avanzamento
  const salStr  = `SAL: ${parseFloat(site.sal_percentuale || 0).toFixed(0)}%`;
  const expeStr = inf.expected_progress !== null ? ` | Atteso: ${inf.expected_progress}%` : '';
  const delStr  = inf.delay_days > 0 ? ` | Ritardo stimato: ~${inf.delay_days} giorni` : '';
  if (expeStr || delStr) lines.push(salStr + expeStr + delStr);

  // Salute e budget
  const healthStr  = inf.health_score !== null ? `Salute: ${inf.health_score}/10` : '';
  const budgetStr  = inf.budget_consumed_pct !== null ? `Budget consumato: ${inf.budget_consumed_pct}%${inf.over_budget ? ' ⚠️ SFORATO' : ''}` : '';
  if (healthStr || budgetStr) lines.push([healthStr, budgetStr].filter(Boolean).join(' | '));

  // Blocchi
  if (inf.blockers.length > 0) {
    lines.push(`Blocchi: ${inf.blockers.join(' · ')}`);
  }

  return lines.join('\n');
}

/**
 * Costruisce il contesto arricchito per Ladia.
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
      .select('name, address, status, budget_totale, sal_percentuale, descrizione, latitude, longitude, start_date, end_date, client')
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
        new Promise(resolve => { setTimeout(() => resolve(''), 3000); }),
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

  // ── Fasi proattive ──
  const fasiSforamento = phases.filter(p =>
    p.importo_contratto != null &&
    (costsByPhase[p.id] || 0) > parseFloat(p.importo_contratto)
  );
  const prossimaFase = phases
    .filter(p => p.stato === 'non_iniziata')
    .find(p => {
      if (!p.data_inizio_prevista) return true;
      return (new Date(p.data_inizio_prevista) - today) < 14 * 86400000;
    });

  // ── Lavoratori attivi (timbrature ultimi 3gg) ──
  const workerIds    = [...new Set(timb.map(t => t.worker_id))];
  const workerMap    = Object.fromEntries(workers.map(w => [w.id, w.full_name]));
  const workersAttivi = workerIds.map(id => workerMap[id]).filter(Boolean);

  // ── SNAPSHOT (inferenze di alto livello) ──
  const inf = computeSiteInferences(site, phases, costs, ncCount);

  // ── Costruzione testo ──
  const lines = [];

  // LIVELLO 1: SNAPSHOT compatto — Ladia parte già informata
  lines.push('━━━ SNAPSHOT CANTIERE ━━━');
  lines.push(formatSnapshotBlock(site, inf));
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');

  // LIVELLO 2: DETTAGLIO operativo
  if (site.address)  lines.push(`\nIndirizzo: ${site.address}`);
  if (site.status)   lines.push(`Stato: ${site.status}`);
  if (site.client)   lines.push(`Committente: ${site.client}`);
  if (weather)       lines.push(`Meteo: ${weather}`);

  // Budget complessivo
  if (totalContratto > 0) {
    const margine = totalContratto - totalCostiReali;
    const pct     = Math.round((totalCostiReali / totalContratto) * 100);
    lines.push(`\nBUDGET`);
    lines.push(`  Contratto: ${fmt(totalContratto)} | Speso: ${fmt(totalCostiReali)} (${pct}%) | Margine: ${fmt(margine)}`);
    if (pct > 85) lines.push(`  ⚠️ ATTENZIONE: spesa vicina al budget contrattuale`);
  } else if (site.budget_totale) {
    lines.push(`\nBudget totale: ${fmt(site.budget_totale)}`);
  }

  // Capitolato summary
  if (cfg?.capitolato_summary) {
    lines.push(`\nCAPITOLATO\n  ${cfg.capitolato_summary}`);
  }

  // Fasi di lavoro
  if (phases.length > 0) {
    lines.push(`\nFASI DI LAVORO (${phases.length} totali)`);
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

  // Ultimi costi
  if (costs.length > 0) {
    lines.push(`\nULTIMI COSTI`);
    for (const c of costs.slice(0, 5)) {
      const data = c.data_documento ? new Date(c.data_documento).toLocaleDateString('it-IT') : 'n.d.';
      lines.push(`  • ${c.descrizione}${c.fornitore ? ` (${c.fornitore})` : ''} — ${fmt(parseFloat(c.importo))} [${data}]`);
    }
  }

  // Presenza lavoratori
  if (workersAttivi.length > 0) {
    lines.push(`\nLAVORATORI ATTIVI (ultimi 3gg): ${workersAttivi.slice(0, 8).join(', ')}`);
  }

  // NC aperte
  if (ncCount > 0) {
    lines.push(`\nNon conformità aperte: ${ncCount}`);
  }

  // Note recenti
  if (notes.length > 0) {
    lines.push(`\nNOTE RECENTI`);
    for (const n of notes.slice(0, 4)) {
      const data = new Date(n.created_at).toLocaleDateString('it-IT');
      lines.push(`  [${data}] ${n.content?.slice(0, 120)}${n.content?.length > 120 ? '…' : ''}`);
    }
  }

  return lines.join('\n');
}

module.exports = { buildEnrichedContext, computeSiteInferences };
