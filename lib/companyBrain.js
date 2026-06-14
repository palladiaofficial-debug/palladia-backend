'use strict';
// ── Company Brain — snapshot aziendale per Ladia ─────────────────────────────
// Assembla un quadro completo dell'azienda (organico, compliance, cantieri,
// scadenze, non-conformità) e lo converte in testo compatto da iniettare
// nel system prompt di Ladia.  Cache per company: TTL 5 min.
// ─────────────────────────────────────────────────────────────────────────────

const { complianceStatus, overallStatus } = require('./compliance');

const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

// ── API pubblica ───────────────────────────────────────────────────────────────

async function getCompanyBrain(supabase, companyId) {
  const cached = _cache.get(companyId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

  const data = await _buildBrain(supabase, companyId);
  _cache.set(companyId, { ts: Date.now(), data });
  return data;
}

function clearBrainCache(companyId) {
  if (companyId) _cache.delete(companyId);
  else _cache.clear();
}

// ── Builder ────────────────────────────────────────────────────────────────────

async function _buildBrain(supabase, companyId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch parallelo — tutto in un colpo
  const [workersRes, sitesRes, equipRes, ncRes, workerSitesRes] = await Promise.allSettled([
    supabase
      .from('workers')
      .select('id, full_name, role, qualification, is_active, safety_training_expiry, health_fitness_expiry, employer_name')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .limit(500),

    supabase
      .from('sites')
      .select('id, name, status, address, budget_totale, sal_percentuale')
      .eq('company_id', companyId)
      .neq('status', 'eliminato')
      .limit(200),

    supabase
      .from('equipment')
      .select('id, nome, tipo, targa, data_scadenza_assicurazione, status')
      .eq('company_id', companyId)
      .limit(200),

    supabase
      .from('site_notes')
      .select('id, site_id, category, urgency, resolved_at')
      .eq('company_id', companyId)
      .eq('category', 'non_conformita')
      .is('resolved_at', null)
      .limit(100),

    supabase
      .from('worksite_workers')
      .select('worker_id, site_id')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(1000),
  ]);

  // Estrai i dati con fallback sicuro
  const workers   = workersRes.status === 'fulfilled'    ? (workersRes.value.data   || []) : [];
  const sites     = sitesRes.status === 'fulfilled'      ? (sitesRes.value.data     || []) : [];
  const equipment = equipRes.status === 'fulfilled'      ? (equipRes.value.data     || []) : [];
  const openNCs   = ncRes.status === 'fulfilled'         ? (ncRes.value.data        || []) : [];
  const workerSites = workerSitesRes.status === 'fulfilled' ? (workerSitesRes.value.data || []) : [];

  // Lookup site_id → nome
  const siteNameMap = new Map(sites.map(s => [s.id, s.name]));

  // Mappa worker_id → cantieri attivi (nomi)
  const workerSiteMap = new Map();
  workerSites.forEach(ws => {
    if (!workerSiteMap.has(ws.worker_id)) workerSiteMap.set(ws.worker_id, []);
    const siteName = siteNameMap.get(ws.site_id);
    if (siteName) workerSiteMap.get(ws.worker_id).push(siteName);
  });

  // Enrichment lavoratori con compliance + cantieri
  const enrichedWorkers = workers.map(w => {
    const safetyStatus = complianceStatus(w.safety_training_expiry);
    const healthStatus = complianceStatus(w.health_fitness_expiry);
    const overall      = overallStatus(w);

    const safetyDays = w.safety_training_expiry
      ? Math.ceil((new Date(w.safety_training_expiry) - today) / 86400000) : null;
    const healthDays = w.health_fitness_expiry
      ? Math.ceil((new Date(w.health_fitness_expiry) - today) / 86400000) : null;

    return {
      ...w,
      safetyStatus, healthStatus, overall,
      safetyDays, healthDays,
      activeSites: workerSiteMap.get(w.id) || [],
    };
  });

  // Scadenze entro 90 giorni (lavoratori + mezzi), ordinate per urgenza
  const deadlines = _buildDeadlines(enrichedWorkers, equipment, today);

  const text = _buildText(enrichedWorkers, sites, equipment, deadlines, openNCs);

  return { workers: enrichedWorkers, sites, equipment, deadlines, openNCs, text };
}

// ── Deadlines builder ─────────────────────────────────────────────────────────

function _buildDeadlines(workers, equipment, today, horizonDays = 90) {
  const list = [];

  workers.forEach(w => {
    if (w.safetyDays !== null && w.safetyDays <= horizonDays) {
      list.push({ soggetto: w.full_name, tipo: 'Formazione sicurezza', expiry: w.safety_training_expiry, days: w.safetyDays, status: w.safetyStatus });
    }
    if (w.healthDays !== null && w.healthDays <= horizonDays) {
      list.push({ soggetto: w.full_name, tipo: 'Idoneità medica', expiry: w.health_fitness_expiry, days: w.healthDays, status: w.healthStatus });
    }
  });

  equipment.forEach(eq => {
    if (!eq.data_scadenza_assicurazione) return;
    const today2 = new Date(); today2.setHours(0,0,0,0);
    const days = Math.ceil((new Date(eq.data_scadenza_assicurazione) - today2) / 86400000);
    if (days <= horizonDays) {
      list.push({
        soggetto: eq.nome || eq.tipo,
        tipo:     'Assicurazione mezzo',
        targa:    eq.targa,
        expiry:   eq.data_scadenza_assicurazione,
        days,
        status:   days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'ok',
      });
    }
  });

  return list.sort((a, b) => a.days - b.days);
}

// ── Text builder — genera sezione compatta per il system prompt ───────────────

function _fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function _buildText(workers, sites, equipment, deadlines, openNCs) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  const dateStr = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });

  const nonCompliant = workers.filter(w => w.overall === 'non_compliant');
  const expiring30   = workers.filter(w => w.overall === 'expiring');
  const upcoming90   = workers.filter(w => {
    if (w.overall === 'non_compliant' || w.overall === 'expiring') return false; // già mostrati sopra
    return (w.safetyDays !== null && w.safetyDays > 30 && w.safetyDays <= 90) ||
           (w.healthDays !== null && w.healthDays > 30 && w.healthDays <= 90);
  });
  const conformiPuri = workers.filter(w =>
    w.overall === 'compliant' &&
    (w.safetyDays === null || w.safetyDays > 90) &&
    (w.healthDays === null || w.healthDays > 90)
  );
  const incompleti   = workers.filter(w => w.overall === 'incomplete');
  const activeSites  = sites.filter(s => s.status === 'attivo');
  const sospesoSites = sites.filter(s => s.status === 'sospeso');

  let t = '\n';
  t += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  t += `DATI AZIENDA IN TEMPO REALE — ${timeStr} del ${dateStr}\n`;
  t += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  // ── Organico summary ──────────────────────────────────────────────────────
  t += `ORGANICO ATTIVO: ${workers.length} lavoratori`;
  const statParts = [];
  if (conformiPuri.length > 0)  statParts.push(`${conformiPuri.length} ✅ conformi`);
  if (upcoming90.length > 0)    statParts.push(`${upcoming90.length} ⚠️ scadenza 31-90gg`);
  if (expiring30.length > 0)    statParts.push(`${expiring30.length} 🔴 scadenza critica <30gg`);
  if (nonCompliant.length > 0)  statParts.push(`${nonCompliant.length} ❌ NON CONFORMI`);
  if (incompleti.length > 0)    statParts.push(`${incompleti.length} ○ dati mancanti`);
  if (statParts.length > 0) t += ` — ${statParts.join(' · ')}`;
  t += '\n';

  // ── Lavoratori critici (non conformi + scadenza <30gg) ────────────────────
  if (nonCompliant.length > 0 || expiring30.length > 0) {
    t += '\n⚠ LAVORATORI CON DOCUMENTI CRITICI (azione richiesta):\n';
    const critical = [...nonCompliant, ...expiring30].slice(0, 20);
    critical.forEach(w => {
      const issues = [];
      if (w.safetyStatus === 'expired')   issues.push(`Formazione SCADUTA il ${_fmtDate(w.safety_training_expiry)}`);
      else if (w.safetyStatus === 'expiring') issues.push(`Formazione scade ${_fmtDate(w.safety_training_expiry)} (${w.safetyDays}gg)`);
      if (w.healthStatus === 'expired')   issues.push(`Idoneità SCADUTA il ${_fmtDate(w.health_fitness_expiry)}`);
      else if (w.healthStatus === 'expiring') issues.push(`Idoneità scade ${_fmtDate(w.health_fitness_expiry)} (${w.healthDays}gg)`);
      if (issues.length) {
        const cantieri = w.activeSites.length > 0 ? ` [cantieri: ${w.activeSites.join(', ')}]` : '';
        t += `  • ${w.full_name}${w.role ? ` (${w.role})` : ''}${cantieri} → ${issues.join(' | ')}\n`;
      }
    });
    if ([...nonCompliant, ...expiring30].length > 20) t += `  ... e altri ${[...nonCompliant, ...expiring30].length - 20}\n`;
  }

  // ── Scadenze 31-90 giorni ─────────────────────────────────────────────────
  if (upcoming90.length > 0) {
    t += '\nSCADENZE 31–90 GIORNI:\n';
    upcoming90.slice(0, 10).forEach(w => {
      const items = [];
      if (w.safetyDays !== null && w.safetyDays > 30 && w.safetyDays <= 90)
        items.push(`Formazione ${_fmtDate(w.safety_training_expiry)} (${w.safetyDays}gg)`);
      if (w.healthDays !== null && w.healthDays > 30 && w.healthDays <= 90)
        items.push(`Idoneità ${_fmtDate(w.health_fitness_expiry)} (${w.healthDays}gg)`);
      if (items.length) t += `  ⚠️ ${w.full_name} — ${items.join(' | ')}\n`;
    });
    if (upcoming90.length > 10) t += `  ... e altri ${upcoming90.length - 10}\n`;
  }

  // ── Cantieri ──────────────────────────────────────────────────────────────
  t += `\nCANTIERI: ${activeSites.length} attivi`;
  if (sospesoSites.length) t += ` · ${sospesoSites.length} sospesi`;
  t += '\n';
  activeSites.slice(0, 15).forEach(s => {
    t += `  • ${s.name}`;
    if (s.sal_percentuale != null) t += ` — SAL ${s.sal_percentuale}%`;
    if (s.budget_totale)           t += ` — Budget €${Number(s.budget_totale).toLocaleString('it-IT')}`;
    t += '\n';
  });
  if (activeSites.length > 15) t += `  ... e altri ${activeSites.length - 15}\n`;

  // ── Mezzi con scadenze imminenti ──────────────────────────────────────────
  if (equipment.length > 0) {
    const eqNow = new Date(); eqNow.setHours(0,0,0,0);
    const eqWarning = equipment.filter(eq => {
      if (!eq.data_scadenza_assicurazione) return false;
      const d = Math.ceil((new Date(eq.data_scadenza_assicurazione) - eqNow) / 86400000);
      return d <= 90;
    });
    if (eqWarning.length > 0) {
      t += '\nMEZZI — SCADENZE IMMINENTI:\n';
      eqWarning.forEach(eq => {
        const d = Math.ceil((new Date(eq.data_scadenza_assicurazione) - eqNow) / 86400000);
        const em = d <= 0 ? '❌' : d <= 30 ? '🔴' : '⚠️';
        t += `  ${em} ${eq.nome || eq.tipo}${eq.targa ? ` (${eq.targa})` : ''} — Assicurazione ${_fmtDate(eq.data_scadenza_assicurazione)} (${d > 0 ? d+'gg' : 'SCADUTA'})\n`;
      });
    } else {
      t += `\nMEZZI: ${equipment.length} registrati — tutti in regola ✅\n`;
    }
  }

  // ── Non conformità ────────────────────────────────────────────────────────
  if (openNCs.length > 0) {
    const urgenti = openNCs.filter(n => n.urgency === 'alta').length;
    t += `\nNON CONFORMITÀ APERTE: ${openNCs.length}`;
    if (urgenti) t += ` (di cui ${urgenti} URGENTI ❌)`;
    t += '\n';
  } else {
    t += '\nNON CONFORMITÀ APERTE: nessuna ✅\n';
  }

  t += '\nUSO: questi dati sono il tuo punto di partenza. Per presenze in tempo reale, storico timbrature, economia cantiere usa i tool appositi.\n';
  t += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  return t;
}

module.exports = { getCompanyBrain, clearBrainCache, _buildDeadlines };
