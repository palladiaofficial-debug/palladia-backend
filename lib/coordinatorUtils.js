'use strict';
/**
 * lib/coordinatorUtils.js
 * Utility condivise per il portale coordinatore.
 * Calcolo stato sicurezza, issues attivi, presenze oggi, stato documenti.
 */

const supabase = require('./supabase');

const REQUIRED_DOC_CATEGORIES = ['pos', 'psc', 'notifica_asl', 'durc', 'dvr'];

// ── Stato sicurezza ───────────────────────────────────────────────────────────
// Calcola livello e motivazioni da workers (con compliance) e lista NC.
// Ritorna: { level, label, reasons, open_nc_count, critical_nc_count,
//            non_compliant_workers, expiring_workers }
function computeSafetyStatus(workers, ncList) {
  const openCritical = ncList.filter(n =>
    (n.status === 'aperta' || n.status === 'in_lavorazione') &&
    (n.severity === 'critica' || n.severity === 'alta')
  );
  const openAny = ncList.filter(n =>
    n.status === 'aperta' || n.status === 'in_lavorazione'
  );
  const nonCompliant = workers.filter(w => w.compliance?.overall === 'non_compliant');
  const expiring     = workers.filter(w => w.compliance?.overall === 'expiring');

  const base = {
    open_nc_count:        openAny.length,
    critical_nc_count:    openCritical.length,
    non_compliant_workers: nonCompliant.length,
    expiring_workers:     expiring.length,
  };

  // Nessun dato: non si può valutare
  if (!workers.length && !ncList.length) {
    return {
      ...base,
      level: 'dati_insufficienti',
      label: 'Dati insufficienti',
      reasons: ['Nessun lavoratore o non conformità registrati per questo cantiere.'],
    };
  }

  // Critico: NC alta/critica aperte OPPURE lavoratori non conformi
  if (openCritical.length > 0 || nonCompliant.length > 0) {
    const reasons = [];
    for (const nc of openCritical.slice(0, 3)) {
      const age = Math.floor((Date.now() - new Date(nc.created_at)) / 86_400_000);
      reasons.push(`NC ${nc.severity}: "${nc.title.slice(0, 60)}" — aperta da ${age} giorni`);
    }
    if (nonCompliant.length > 0) {
      reasons.push(
        `${nonCompliant.length} lavorator${nonCompliant.length > 1 ? 'i' : 'e'} ` +
        `con formazione o idoneità scaduta`
      );
    }
    return { ...base, level: 'critico', label: 'Situazione critica', reasons };
  }

  // Attenzione: NC di qualsiasi gravità aperte OPPURE lavoratori in scadenza
  if (openAny.length > 0 || expiring.length > 0) {
    const reasons = [];
    if (openAny.length > 0) {
      reasons.push(
        `${openAny.length} non conformit${openAny.length !== 1 ? 'à' : 'à'} ` +
        `${openAny.length !== 1 ? 'aperte' : 'aperta'}`
      );
    }
    if (expiring.length > 0) {
      reasons.push(
        `${expiring.length} lavorator${expiring.length > 1 ? 'i' : 'e'} ` +
        `con scadenze entro 30 giorni`
      );
    }
    return { ...base, level: 'attenzione', label: 'Elementi da verificare', reasons };
  }

  // Conforme: tutti i controlli OK
  return {
    ...base,
    level: 'conforme',
    label: 'Situazione regolare',
    reasons: ['Nessuna criticità rilevata nei dati registrati in piattaforma.'],
  };
}

// ── Issues attivi ─────────────────────────────────────────────────────────────
// Lista prioritizzata di NC aperte + problemi worker.
function buildActiveIssues(workers, ncList) {
  const issues = [];
  const sevOrder = { critica: 0, alta: 1, media: 2, bassa: 3 };

  const openNc = ncList
    .filter(n => n.status === 'aperta' || n.status === 'in_lavorazione')
    .sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));

  for (const nc of openNc.slice(0, 6)) {
    const age = Math.floor((Date.now() - new Date(nc.created_at)) / 86_400_000);
    issues.push({
      type:     'nc',
      id:       nc.id,
      title:    nc.title,
      severity: nc.severity,
      category: nc.category,
      status:   nc.status,
      age_days: age,
      date:     nc.created_at.split('T')[0],
    });
  }

  const nonCompliant = workers.filter(w => w.compliance?.overall === 'non_compliant');
  if (nonCompliant.length > 0) {
    issues.push({
      type:     'worker_compliance',
      title:    `${nonCompliant.length} lavorator${nonCompliant.length > 1 ? 'i' : 'e'} con formazione o idoneità scaduta`,
      severity: 'alta',
      age_days: 0,
      date:     new Date().toISOString().split('T')[0],
      workers:  nonCompliant.slice(0, 5).map(w => ({ id: w.id, name: w.full_name })),
    });
  }

  const expiring = workers.filter(w => w.compliance?.overall === 'expiring');
  if (expiring.length > 0) {
    issues.push({
      type:     'worker_expiring',
      title:    `${expiring.length} lavorator${expiring.length > 1 ? 'i' : 'e'} con scadenze entro 30 giorni`,
      severity: 'media',
      age_days: 0,
      date:     new Date().toISOString().split('T')[0],
      workers:  expiring.slice(0, 5).map(w => ({ id: w.id, name: w.full_name })),
    });
  }

  return issues;
}

// ── Presenze oggi ─────────────────────────────────────────────────────────────
async function getTodayPresences(siteId, companyId, workers) {
  const today = new Date().toISOString().split('T')[0];

  const { data: logs } = await supabase
    .from('presence_logs')
    .select('worker_id, event_type, timestamp_server')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .gte('timestamp_server', today + 'T00:00:00.000Z')
    .lte('timestamp_server', today + 'T23:59:59.999Z')
    .order('timestamp_server', { ascending: true })
    .limit(500);

  const firstEntry = {};
  const lastEvt    = {};
  for (const log of (logs || [])) {
    if (!firstEntry[log.worker_id] && log.event_type === 'ENTRY') {
      firstEntry[log.worker_id] = log.timestamp_server;
    }
    lastEvt[log.worker_id] = { type: log.event_type, time: log.timestamp_server };
  }

  const workerMap = {};
  for (const w of workers) workerMap[w.id] = w.full_name;

  const present      = [];
  const missingExits = [];

  for (const [workerId, evt] of Object.entries(lastEvt)) {
    const name = workerMap[workerId] || 'Lavoratore';
    if (evt.type === 'ENTRY') {
      missingExits.push({ worker_id: workerId, name, entry_time: firstEntry[workerId] || evt.time });
      present.push({ worker_id: workerId, name, status: 'in_cantiere', entry_time: firstEntry[workerId] || evt.time, exit_time: null });
    } else {
      present.push({ worker_id: workerId, name, status: 'uscito', entry_time: firstEntry[workerId] || null, exit_time: evt.time });
    }
  }

  present.sort((a, b) => (a.status === 'in_cantiere' ? -1 : 1));

  return {
    date:                today,
    present_count:       missingExits.length,
    workers_today:       present.length,
    missing_exits_count: missingExits.length,
    missing_exits:       missingExits,
    workers:             present,
  };
}

// ── Stato documenti ───────────────────────────────────────────────────────────
// Verifica quali categorie obbligatorie sono presenti e quali mancano.
async function getDocumentStatus(siteId, companyId) {
  const [uploadedRes, posRes] = await Promise.all([
    supabase.from('site_documents')
      .select('id, name, category, created_at')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false }),
    supabase.from('pos_documents')
      .select('id, revision, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  const uploaded = uploadedRes.data || [];
  const hasPosDoc = (posRes.data || []).length > 0;

  const byCategory = {};
  for (const doc of uploaded) {
    byCategory[doc.category] = (byCategory[doc.category] || 0) + 1;
  }
  if (hasPosDoc && !byCategory['pos']) byCategory['pos'] = 1;

  const missingRequired = REQUIRED_DOC_CATEGORIES.filter(cat => !byCategory[cat]);

  return {
    total_count:      uploaded.length + (hasPosDoc ? 1 : 0),
    by_category:      byCategory,
    missing_required: missingRequired,
    has_pos:          hasPosDoc || !!byCategory['pos'],
  };
}

// ── Timeline unificata ────────────────────────────────────────────────────────
// Merge verifiche + NC + note in ordine cronologico inverso.
function buildTimeline(verifications, ncList, notes) {
  const events = [];

  for (const v of verifications) {
    events.push({
      type:          'verifica',
      id:            v.id,
      title:         `Verifica effettuata — ${safetyLabel(v.safety_status)}`,
      safety_status: v.safety_status,
      note:          v.note || null,
      meta: {
        open_nc:       v.open_nc_count,
        critical_nc:   v.critical_nc_count,
        non_compliant: v.non_compliant_workers,
        present_today: v.workers_present_today,
      },
      author:    v.coordinator_name,
      date:      v.created_at,
    });
  }

  for (const nc of ncList) {
    events.push({
      type:     'nc_aperta',
      id:       nc.id,
      title:    `Non conformità aperta: ${nc.title}`,
      severity: nc.severity,
      category: nc.category,
      nc_status: nc.status,
      author:   nc.coordinator_name,
      date:     nc.created_at,
    });
    if (nc.resolved_at) {
      events.push({
        type:     'nc_risolta',
        id:       `${nc.id}_r`,
        title:    `NC risolta dall\'impresa: ${nc.title}`,
        severity: nc.severity,
        author:   'Impresa',
        date:     nc.resolved_at,
      });
    }
    if (nc.closed_by_coordinator_at) {
      events.push({
        type:     'nc_chiusa',
        id:       `${nc.id}_c`,
        title:    `NC chiusa dal coordinatore: ${nc.title}`,
        severity: nc.severity,
        author:   nc.coordinator_name,
        date:     nc.closed_by_coordinator_at,
      });
    }
  }

  for (const n of notes) {
    events.push({
      type:      'nota',
      id:        n.id,
      title:     n.content.slice(0, 100) + (n.content.length > 100 ? '…' : ''),
      note_type: n.note_type,
      author:    n.coordinator_name,
      date:      n.created_at,
    });
  }

  return events.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function safetyLabel(level) {
  const labels = {
    conforme:           'Situazione regolare',
    attenzione:         'Elementi da verificare',
    critico:            'Situazione critica',
    dati_insufficienti: 'Dati insufficienti',
  };
  return labels[level] || level;
}

module.exports = {
  computeSafetyStatus,
  buildActiveIssues,
  getTodayPresences,
  getDocumentStatus,
  buildTimeline,
  safetyLabel,
};
