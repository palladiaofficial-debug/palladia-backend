'use strict';
/**
 * services/safetyCopilot.js
 *
 * SAFETY COPILOT — Motore predittivo di rischio cantiere.
 *
 * Calcola un Risk Score 0-100 per ogni cantiere combinando 6 dimensioni:
 *   1. Compliance documentale (formazione, idoneità, docs obbligatori)
 *   2. Meteo (previsioni prossime 24h)
 *   3. Ore consecutive lavorate (fatica = rischio)
 *   4. Presenze anomale (assenze improvvise, orari insoliti)
 *   5. Non conformità aperte (NC critiche/alte irrisolte)
 *   6. Subappaltatori con documenti scaduti
 *
 * Score: 0 = nessun rischio, 100 = rischio massimo
 * Livelli: 0-30 verde, 31-60 giallo, 61-100 rosso
 */

const supabase = require('../lib/supabase');
const { getForecast, evalThresholds } = require('./weatherService');
const { daysUntil } = require('./expiryHelper');

// ── Pesi delle dimensioni (totale = 100) ────────────────────────────────────
const WEIGHTS = {
  compliance:     30,   // documenti scaduti/mancanti — il più pesante
  weather:        15,   // meteo avverso domani
  fatigue:        15,   // ore consecutive eccessive
  attendance:     10,   // anomalie presenze
  nonConformity:  20,   // NC aperte critiche/alte
  subcontractors: 10,   // subappaltatori non in regola
};

// ── Soglie ──────────────────────────────────────────────────────────────────
const FATIGUE_HOURS_WARN     = 10;   // ore consecutive → warning (9h è routine in edilizia)
const FATIGUE_HOURS_CRITICAL = 12;   // ore consecutive → critical
const ATTENDANCE_DROP_PCT    = 40;   // calo presenze vs media → anomalia (30% era troppo sensibile)
const ATTENDANCE_MIN_HOUR    = 10;   // non valutare presenze prima delle 10:00 (arrivi scaglionati)

// ── Livelli ─────────────────────────────────────────────────────────────────
function riskLevel(score) {
  if (score <= 30) return 'verde';
  if (score <= 60) return 'giallo';
  return 'rosso';
}

function riskLabel(level) {
  return {
    verde:  'Rischio basso',
    giallo: 'Attenzione richiesta',
    rosso:  'Rischio alto',
  }[level] || 'Sconosciuto';
}

function riskIcon(level) {
  return { verde: '🟢', giallo: '🟡', rosso: '🔴' }[level] || '⚪';
}

// ── Funzione principale ─────────────────────────────────────────────────────

/**
 * Calcola il Risk Score completo per un cantiere.
 *
 * @param {string} siteId
 * @param {string} companyId
 * @returns {Promise<RiskReport>}
 */
async function computeRiskScore(siteId, companyId) {
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayObj = new Date(today + 'T00:00:00.000Z');

  // ── Fetch dati base in parallelo ────────────────────────────────────────
  const [siteRes, assignRes] = await Promise.all([
    supabase.from('sites')
      .select('name, address, latitude, longitude, geofence_radius_m, status')
      .eq('id', siteId)
      .maybeSingle(),
    supabase.from('worksite_workers')
      .select('worker_id')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(300),
  ]);

  const site = siteRes.data;
  const siteName = site?.name || site?.address || 'Cantiere';
  const workerIds = (assignRes.data || []).map(a => a.worker_id);

  // ── Fetch tutte le dimensioni in parallelo ──────────────────────────────
  const [
    complianceData,
    weatherData,
    fatigueData,
    attendanceData,
    ncData,
    subData,
  ] = await Promise.all([
    _checkCompliance(workerIds, companyId, todayObj),
    _checkWeather(site),
    _checkFatigue(siteId, companyId, today),
    _checkAttendance(siteId, companyId, today),
    _checkNonConformities(siteId, companyId),
    _checkSubcontractors(siteId, companyId, todayObj),
  ]);

  // ── Calcola score pesato ────────────────────────────────────────────────
  const dimensions = {
    compliance:     { ...complianceData,  weight: WEIGHTS.compliance },
    weather:        { ...weatherData,     weight: WEIGHTS.weather },
    fatigue:        { ...fatigueData,     weight: WEIGHTS.fatigue },
    attendance:     { ...attendanceData,  weight: WEIGHTS.attendance },
    nonConformity:  { ...ncData,          weight: WEIGHTS.nonConformity },
    subcontractors: { ...subData,         weight: WEIGHTS.subcontractors },
  };

  let totalScore = 0;
  for (const dim of Object.values(dimensions)) {
    totalScore += (dim.severity / 100) * dim.weight;
  }
  totalScore = Math.round(Math.min(100, Math.max(0, totalScore)));

  const level = riskLevel(totalScore);

  return {
    siteId,
    siteName,
    companyId,
    score: totalScore,
    level,
    label: riskLabel(level),
    icon: riskIcon(level),
    workerCount: workerIds.length,
    dimensions,
    computedAt: new Date().toISOString(),
  };
}

// ── Dimensione 1: Compliance documentale ────────────────────────────────────

async function _checkCompliance(workerIds, _companyId, _todayObj) {
  if (!workerIds.length) {
    return { severity: 0, detail: 'Nessun lavoratore assegnato', items: [] };
  }

  const [workersRes, docsRes] = await Promise.all([
    supabase.from('workers')
      .select('id, full_name, safety_training_expiry, health_fitness_expiry')
      .in('id', workerIds)
      .limit(300),
    supabase.from('worker_documents')
      .select('worker_id, doc_type, expiry_date')
      .in('worker_id', workerIds)
      .in('doc_type', ['idoneita_medica', 'formazione_sicurezza'])
      .limit(1000),
  ]);

  const workers = workersRes.data || [];
  const docs = docsRes.data || [];

  const items = [];
  let expiredCount = 0;
  let expiringCount = 0;
  let missingCount = 0;

  const docMap = new Map();
  for (const d of docs) {
    const key = `${d.worker_id}:${d.doc_type}`;
    if (!docMap.has(key) || (d.expiry_date && d.expiry_date > (docMap.get(key)?.expiry_date || ''))) {
      docMap.set(key, d);
    }
  }

  for (const w of workers) {
    const trainDays = daysUntil(w.safety_training_expiry);
    const fitDays = daysUntil(w.health_fitness_expiry);

    if (trainDays !== null && trainDays < 0) {
      expiredCount++;
      items.push({ worker: w.full_name, issue: 'formazione scaduta', days: trainDays, severity: 'critical' });
    } else if (trainDays !== null && trainDays <= 7) {
      expiringCount++;
      items.push({ worker: w.full_name, issue: 'formazione in scadenza', days: trainDays, severity: 'warning' });
    } else if (trainDays === null) {
      const hasDoc = docMap.has(`${w.id}:formazione_sicurezza`);
      if (!hasDoc) {
        missingCount++;
        items.push({ worker: w.full_name, issue: 'formazione mancante', days: null, severity: 'critical' });
      }
    }

    if (fitDays !== null && fitDays < 0) {
      expiredCount++;
      items.push({ worker: w.full_name, issue: 'idoneità scaduta', days: fitDays, severity: 'critical' });
    } else if (fitDays !== null && fitDays <= 7) {
      expiringCount++;
      items.push({ worker: w.full_name, issue: 'idoneità in scadenza', days: fitDays, severity: 'warning' });
    } else if (fitDays === null) {
      const hasDoc = docMap.has(`${w.id}:idoneita_medica`);
      if (!hasDoc) {
        missingCount++;
        items.push({ worker: w.full_name, issue: 'idoneità mancante', days: null, severity: 'critical' });
      }
    }
  }

  const total = workers.length;
  const problemPct = total ? ((expiredCount + missingCount) / total) * 100 : 0;
  const warnPct = total ? (expiringCount / total) * 100 : 0;

  // severity 0-100: proporzionale ai problemi
  const severity = Math.min(100, problemPct * 2 + warnPct * 0.5);

  const detail = expiredCount + missingCount > 0
    ? `${expiredCount + missingCount} lavorator${(expiredCount + missingCount) > 1 ? 'i' : 'e'} non in regola` + (expiringCount ? `, ${expiringCount} in scadenza` : '')
    : expiringCount > 0
      ? `${expiringCount} document${expiringCount > 1 ? 'i' : 'o'} in scadenza entro 7gg`
      : 'Tutti i documenti in regola';

  return { severity: Math.round(severity), detail, items, expiredCount, expiringCount, missingCount };
}

// ── Dimensione 2: Meteo ─────────────────────────────────────────────────────

async function _checkWeather(site) {
  if (!site?.latitude || !site?.longitude) {
    return { severity: 0, detail: 'GPS non configurato', forecast: null };
  }

  try {
    const forecast = await getForecast(site.latitude, site.longitude);
    const tomorrow = forecast?.[1]; // domani
    const today = forecast?.[0];

    if (!tomorrow && !today) {
      return { severity: 0, detail: 'Previsioni non disponibili', forecast: null };
    }

    let severity = 0;
    const alerts = [];

    // Controlla oggi
    if (today) {
      const todayEval = evalThresholds({
        precipitation_mm: today.precipProb > 70 ? 15 : today.precipProb > 40 ? 5 : 0,
        wind_max_kmh: 0,
        weather_code: today.weatherCode,
      });
      if (todayEval.exceeded) {
        severity += 40;
        alerts.push(`Oggi: ${todayEval.reason} (${today.description})`);
      } else if (today.precipProb > 50) {
        severity += 20;
        alerts.push(`Oggi: pioggia probabile ${today.precipProb}%`);
      }
    }

    // Controlla domani
    if (tomorrow) {
      const tomEval = evalThresholds({
        precipitation_mm: tomorrow.precipProb > 70 ? 15 : tomorrow.precipProb > 40 ? 5 : 0,
        wind_max_kmh: 0,
        weather_code: tomorrow.weatherCode,
      });
      if (tomEval.exceeded) {
        severity += 50;
        alerts.push(`Domani: ${tomEval.reason} (${tomorrow.description})`);
      } else if (tomorrow.precipProb > 50) {
        severity += 15;
        alerts.push(`Domani: pioggia probabile ${tomorrow.precipProb}%`);
      }
    }

    // Temperatura estrema
    const maxTemp = Math.max(today?.tempMax ?? 0, tomorrow?.tempMax ?? 0);
    const minTemp = Math.min(today?.tempMin ?? 99, tomorrow?.tempMin ?? 99);
    if (maxTemp >= 38) {
      severity += 30;
      alerts.push(`Caldo estremo: ${maxTemp}°C`);
    } else if (maxTemp >= 35) {
      severity += 15;
      alerts.push(`Caldo intenso: ${maxTemp}°C`);
    }
    if (minTemp <= -2) {
      severity += 20;
      alerts.push(`Gelo: ${minTemp}°C`);
    }

    severity = Math.min(100, severity);

    return {
      severity,
      detail: alerts.length ? alerts.join(' · ') : `${today?.description || 'variabile'}, ${today?.tempMin ?? '?'}–${today?.tempMax ?? '?'}°C`,
      forecast: { today, tomorrow },
      alerts,
    };
  } catch {
    return { severity: 0, detail: 'Meteo non disponibile', forecast: null };
  }
}

// ── Dimensione 3: Fatica (ore consecutive) ──────────────────────────────────

async function _checkFatigue(siteId, companyId, today) {
  const dayStart = `${today}T00:00:00.000Z`;
  const dayEnd = `${today}T23:59:59.999Z`;

  const { data: logs } = await supabase.from('presence_logs')
    .select('worker_id, event_type, timestamp_server')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .gte('timestamp_server', dayStart)
    .lte('timestamp_server', dayEnd)
    .order('timestamp_server', { ascending: true })
    .limit(2000);

  if (!logs?.length) {
    return { severity: 0, detail: 'Nessuna presenza oggi', items: [] };
  }

  // Calcola ore per ogni lavoratore
  const byWorker = new Map();
  for (const log of logs) {
    if (!byWorker.has(log.worker_id)) byWorker.set(log.worker_id, []);
    byWorker.get(log.worker_id).push(log);
  }

  const items = [];
  let maxHours = 0;
  const now = Date.now();

  for (const [workerId, workerLogs] of byWorker) {
    let entryTime = null;
    let totalMs = 0;

    for (const log of workerLogs) {
      if (log.event_type === 'ENTRY') {
        entryTime = new Date(log.timestamp_server).getTime();
      } else if (log.event_type === 'EXIT' && entryTime) {
        totalMs += new Date(log.timestamp_server).getTime() - entryTime;
        entryTime = null;
      }
    }

    // Se ancora dentro (no EXIT), conta fino ad ora
    if (entryTime) {
      totalMs += now - entryTime;
    }

    const hours = totalMs / 3_600_000;
    if (hours > maxHours) maxHours = hours;

    if (hours >= FATIGUE_HOURS_CRITICAL) {
      items.push({ workerId, hours: Math.round(hours * 10) / 10, level: 'critical' });
    } else if (hours >= FATIGUE_HOURS_WARN) {
      items.push({ workerId, hours: Math.round(hours * 10) / 10, level: 'warning' });
    }
  }

  let severity = 0;
  if (maxHours >= FATIGUE_HOURS_CRITICAL) severity = 80;
  else if (maxHours >= FATIGUE_HOURS_WARN) severity = 40;
  else if (maxHours >= 8) severity = 10;

  const detail = items.length
    ? `${items.length} lavorator${items.length > 1 ? 'i' : 'e'} con orario prolungato (max ${Math.round(maxHours * 10) / 10}h)`
    : `Orari nella norma (max ${Math.round(maxHours * 10) / 10}h)`;

  return { severity, detail, items, maxHours: Math.round(maxHours * 10) / 10 };
}

// ── Dimensione 4: Presenze anomale ──────────────────────────────────────────

async function _checkAttendance(siteId, companyId, today) {
  // Prima delle 10:00 Rome gli arrivi sono scaglionati — non ha senso confrontare
  const romeHour = new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Rome' });
  if (parseInt(romeHour) < ATTENDANCE_MIN_HOUR) {
    return { severity: 0, detail: 'Arrivi in corso (prima delle 10)', todayPresent: 0, avgPresent: 0 };
  }

  // Presenze di oggi
  const dayStart = `${today}T00:00:00.000Z`;
  const dayEnd = `${today}T23:59:59.999Z`;

  const { data: todayEntries } = await supabase
    .from('presence_logs')
    .select('worker_id', { count: 'exact', head: false })
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('event_type', 'ENTRY')
    .gte('timestamp_server', dayStart)
    .lte('timestamp_server', dayEnd)
    .limit(300);

  const todayWorkers = new Set((todayEntries || []).map(e => e.worker_id));
  const todayPresent = todayWorkers.size;

  // Media ultimi 5 giorni lavorativi
  const avgDays = [];
  const dayMs = 86_400_000;
  let checkDate = new Date(today + 'T00:00:00.000Z');
  for (let i = 0; i < 10 && avgDays.length < 5; i++) {
    checkDate = new Date(checkDate.getTime() - dayMs);
    const dow = checkDate.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekend
    avgDays.push(checkDate.toISOString().split('T')[0]);
  }

  let avgPresent = 0;
  if (avgDays.length) {
    const firstDay = avgDays[avgDays.length - 1];
    const lastDay = avgDays[0];

    const { data: histLogs } = await supabase.from('presence_logs')
      .select('worker_id, timestamp_server')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('event_type', 'ENTRY')
      .gte('timestamp_server', `${firstDay}T00:00:00.000Z`)
      .lte('timestamp_server', `${lastDay}T23:59:59.999Z`)
      .limit(5000);

    // Conta lavoratori unici per giorno
    const byDay = new Map();
    for (const log of histLogs || []) {
      const d = log.timestamp_server.split('T')[0];
      if (!byDay.has(d)) byDay.set(d, new Set());
      byDay.get(d).add(log.worker_id);
    }

    const dailyCounts = [...byDay.values()].map(s => s.size);
    avgPresent = dailyCounts.length ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0;
  }

  let severity = 0;
  let detail = '';

  if (avgPresent > 0 && todayPresent > 0) {
    const dropPct = ((avgPresent - todayPresent) / avgPresent) * 100;
    if (dropPct >= ATTENDANCE_DROP_PCT) {
      severity = Math.min(80, dropPct * 1.5);
      detail = `Calo presenze: ${todayPresent} oggi vs media ${Math.round(avgPresent)} (−${Math.round(dropPct)}%)`;
    } else {
      detail = `${todayPresent} present${todayPresent > 1 ? 'i' : 'e'} oggi (media ${Math.round(avgPresent)})`;
    }
  } else if (todayPresent === 0) {
    // Nessuna presenza oggi — potrebbe essere weekend o festivo
    const dow = new Date(today + 'T00:00:00.000Z').getDay();
    if (dow !== 0 && dow !== 6 && avgPresent > 2) {
      severity = 30;
      detail = `Nessuna presenza oggi (media feriale: ${Math.round(avgPresent)})`;
    } else {
      detail = 'Nessuna presenza oggi';
    }
  } else {
    detail = `${todayPresent} present${todayPresent > 1 ? 'i' : 'e'} oggi`;
  }

  return { severity: Math.round(severity), detail, todayPresent, avgPresent: Math.round(avgPresent * 10) / 10 };
}

// ── Dimensione 5: Non conformità aperte ─────────────────────────────────────

async function _checkNonConformities(siteId, companyId) {
  const { data: ncs } = await supabase.from('site_notes')
    .select('id, urgency, content, ai_summary, created_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('category', 'non_conformita')
    .is('resolved_at', null)
    .order('urgency', { ascending: false })
    .limit(20);

  const items = ncs || [];
  const critica = items.filter(n => n.urgency === 'critica').length;
  const alta = items.filter(n => n.urgency === 'alta').length;
  const normale = items.filter(n => n.urgency === 'normale').length;

  let severity = 0;
  if (critica > 0) severity = Math.min(100, 60 + critica * 15);
  else if (alta > 0) severity = Math.min(80, 30 + alta * 12);
  else if (normale > 0) severity = Math.min(20, normale * 5);

  const parts = [];
  if (critica) parts.push(`${critica} critica${critica > 1 ? 'e' : ''}`);
  if (alta) parts.push(`${alta} alta${alta > 1 ? 'e' : ''}`);
  if (normale) parts.push(`${normale} normale${normale > 1 ? 'i' : ''}`);

  const detail = parts.length
    ? `${items.length} NC apert${items.length > 1 ? 'e' : 'a'}: ${parts.join(', ')}`
    : 'Nessuna non conformità aperta';

  return {
    severity,
    detail,
    items: items.map(n => ({
      id: n.id,
      urgency: n.urgency,
      summary: n.ai_summary || n.content?.slice(0, 80),
      daysOpen: Math.floor((Date.now() - new Date(n.created_at).getTime()) / 86_400_000),
    })),
    critica,
    alta,
  };
}

// ── Dimensione 6: Subappaltatori ────────────────────────────────────────────

async function _checkSubcontractors(siteId, companyId, _todayObj) {
  const { data: subs } = await supabase.from('subcontractors')
    .select('id, company_name, durc_expiry, insurance_expiry, soa_expiry')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .limit(50);

  if (!subs?.length) {
    return { severity: 0, detail: 'Nessun subappaltatore attivo', items: [] };
  }

  const items = [];
  let expiredCount = 0;
  let expiringCount = 0;

  for (const sub of subs) {
    const fields = [
      { key: 'durc_expiry', label: 'DURC' },
      { key: 'insurance_expiry', label: 'Assicurazione' },
      { key: 'soa_expiry', label: 'SOA' },
    ];

    for (const { key, label } of fields) {
      const days = daysUntil(sub[key]);
      if (days === null) continue;
      if (days < 0) {
        expiredCount++;
        items.push({ subName: sub.company_name, doc: label, days, severity: 'critical' });
      } else if (days <= 14) {
        expiringCount++;
        items.push({ subName: sub.company_name, doc: label, days, severity: 'warning' });
      }
    }
  }

  let severity = 0;
  if (expiredCount > 0) severity = Math.min(100, 50 + expiredCount * 20);
  else if (expiringCount > 0) severity = Math.min(50, expiringCount * 15);

  const detail = expiredCount > 0
    ? `${expiredCount} document${expiredCount > 1 ? 'i scaduti' : 'o scaduto'} subappaltatori`
    : expiringCount > 0
      ? `${expiringCount} document${expiringCount > 1 ? 'i in scadenza' : 'o in scadenza'} subappaltatori`
      : `${subs.length} subappaltator${subs.length > 1 ? 'i' : 'e'} in regola`;

  return { severity, detail, items, expiredCount, expiringCount };
}

// ── Scudo Ispezione ─────────────────────────────────────────────────────────

/**
 * Genera un dossier completo di compliance per un cantiere.
 * Usato per lo "Scudo Ispezione" — tutto quello che serve se arriva l'ASL.
 */
async function generateInspectionShield(siteId, companyId) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

  const [siteRes, assignRes] = await Promise.all([
    supabase.from('sites')
      .select('name, address, latitude, longitude, status, created_at')
      .eq('id', siteId)
      .maybeSingle(),
    supabase.from('worksite_workers')
      .select('worker_id')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(300),
  ]);

  const site = siteRes.data;
  const workerIds = (assignRes.data || []).map(a => a.worker_id);

  // Fetch tutto in parallelo
  const [workersRes, docsRes, presRes, ncRes, subsRes, compDocRes, compRes] = await Promise.all([
    workerIds.length
      ? supabase.from('workers')
          .select('id, full_name, fiscal_code, safety_training_expiry, health_fitness_expiry, badge_code, hire_date, qualification, role')
          .in('id', workerIds)
      : Promise.resolve({ data: [] }),

    workerIds.length
      ? supabase.from('worker_documents')
          .select('id, worker_id, doc_type, name, expiry_date, file_url')
          .in('worker_id', workerIds)
          .limit(2000)
      : Promise.resolve({ data: [] }),

    supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .gte('timestamp_server', `${today}T00:00:00.000Z`)
      .order('timestamp_server', { ascending: true })
      .limit(2000),

    supabase.from('site_notes')
      .select('id, category, urgency, content, ai_summary, created_at, resolved_at')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase.from('subcontractors')
      .select('id, company_name, durc_expiry, insurance_expiry, soa_expiry, fiscal_code')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .limit(50),

    supabase.from('company_documents')
      .select('id, name, category, ai_expiry_date, file_url')
      .eq('company_id', companyId)
      .limit(200),

    supabase.from('companies')
      .select('name')
      .eq('id', companyId)
      .maybeSingle(),
  ]);

  const workers = workersRes.data || [];
  const workerDocs = docsRes.data || [];
  const presenceLogs = presRes.data || [];
  const notes = ncRes.data || [];
  const subcontractors = subsRes.data || [];
  const companyDocs = compDocRes.data || [];
  const companyName = compRes.data?.name || 'Azienda';

  // Organizza documenti per lavoratore
  const docsByWorker = new Map();
  for (const d of workerDocs) {
    if (!docsByWorker.has(d.worker_id)) docsByWorker.set(d.worker_id, []);
    docsByWorker.get(d.worker_id).push(d);
  }

  // Stato compliance per lavoratore
  const workersCompliance = workers.map(w => {
    const wDocs = docsByWorker.get(w.id) || [];
    const trainDays = daysUntil(w.safety_training_expiry);
    const fitDays = daysUntil(w.health_fitness_expiry);

    return {
      id: w.id,
      name: w.full_name,
      fiscalCode: w.fiscal_code,
      badgeCode: w.badge_code,
      qualification: w.qualification,
      role: w.role,
      hireDate: w.hire_date,
      training: {
        expiry: w.safety_training_expiry,
        daysLeft: trainDays,
        status: trainDays === null ? 'missing' : trainDays < 0 ? 'expired' : trainDays <= 7 ? 'expiring' : 'ok',
      },
      health: {
        expiry: w.health_fitness_expiry,
        daysLeft: fitDays,
        status: fitDays === null ? 'missing' : fitDays < 0 ? 'expired' : fitDays <= 7 ? 'expiring' : 'ok',
      },
      documents: wDocs.map(d => ({
        type: d.doc_type,
        name: d.name,
        expiry: d.expiry_date,
        daysLeft: daysUntil(d.expiry_date),
        hasFile: !!d.file_url,
      })),
    };
  });

  // Presenze di oggi
  const presentToday = new Set();
  for (const log of presenceLogs) {
    if (log.event_type === 'ENTRY') presentToday.add(log.worker_id);
  }

  // NC e stato
  const openNCs = notes.filter(n => n.category === 'non_conformita' && !n.resolved_at);
  const resolvedNCs = notes.filter(n => n.category === 'non_conformita' && n.resolved_at);

  // Subappaltatori con stato
  const subsCompliance = subcontractors.map(s => ({
    name: s.company_name,
    fiscalCode: s.fiscal_code,
    durc: { expiry: s.durc_expiry, daysLeft: daysUntil(s.durc_expiry), status: _docStatus(daysUntil(s.durc_expiry)) },
    insurance: { expiry: s.insurance_expiry, daysLeft: daysUntil(s.insurance_expiry), status: _docStatus(daysUntil(s.insurance_expiry)) },
    soa: { expiry: s.soa_expiry, daysLeft: daysUntil(s.soa_expiry), status: _docStatus(daysUntil(s.soa_expiry)) },
  }));

  // Documenti aziendali
  const companyDocsStatus = companyDocs.map(d => ({
    name: d.name,
    category: d.category,
    expiry: d.ai_expiry_date,
    daysLeft: daysUntil(d.ai_expiry_date),
    status: _docStatus(daysUntil(d.ai_expiry_date)),
    hasFile: !!d.file_url,
  }));

  // Conteggi rapidi
  const totalWorkers = workers.length;
  const compliantWorkers = workersCompliance.filter(w =>
    w.training.status === 'ok' && w.health.status === 'ok'
  ).length;
  const presentCount = presentToday.size;

  // Risk Score attuale
  let riskScore = null;
  try {
    riskScore = await computeRiskScore(siteId, companyId);
  } catch { /* non blocca lo scudo */ }

  return {
    generatedAt: new Date().toISOString(),
    riskScore: riskScore ? { score: riskScore.score, level: riskScore.level, label: riskScore.label, icon: riskScore.icon, dimensions: riskScore.dimensions } : null,
    site: {
      id: siteId,
      name: site?.name,
      address: site?.address,
      status: site?.status,
      openedAt: site?.created_at,
    },
    company: { id: companyId, name: companyName },
    summary: {
      totalWorkers,
      compliantWorkers,
      nonCompliantWorkers: totalWorkers - compliantWorkers,
      presentToday: presentCount,
      openNCs: openNCs.length,
      resolvedNCs: resolvedNCs.length,
      subcontractors: subcontractors.length,
      companyDocs: companyDocs.length,
    },
    workers: workersCompliance,
    presentToday: [...presentToday],
    nonConformities: {
      open: openNCs.map(n => ({
        id: n.id,
        urgency: n.urgency,
        summary: n.ai_summary || n.content?.slice(0, 120),
        createdAt: n.created_at,
        daysOpen: Math.floor((Date.now() - new Date(n.created_at).getTime()) / 86_400_000),
      })),
      resolved: resolvedNCs.slice(0, 10).map(n => ({
        id: n.id,
        summary: n.ai_summary || n.content?.slice(0, 80),
        resolvedAt: n.resolved_at,
      })),
    },
    subcontractors: subsCompliance,
    companyDocuments: companyDocsStatus,
  };
}

function _docStatus(days) {
  if (days === null) return 'missing';
  if (days < 0) return 'expired';
  if (days <= 14) return 'expiring';
  return 'ok';
}

// ── Calcolo batch per tutte le company ──────────────────────────────────────

/**
 * Calcola il risk score per tutti i cantieri attivi di tutte le company.
 * Usato dal cron.
 */
async function computeAllRiskScores() {
  const { data: sites } = await supabase.from('sites')
    .select('id, company_id, name')
    .neq('status', 'chiuso')
    .limit(500);

  if (!sites?.length) return [];

  const results = [];
  // Process in batches of 5 to avoid overwhelming APIs
  for (let i = 0; i < sites.length; i += 5) {
    const batch = sites.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(s => computeRiskScore(s.id, s.company_id).catch(err => {
        console.error(`[safetyCopilot] errore calcolo risk score per ${s.id}:`, err.message);
        return null;
      }))
    );
    results.push(...batchResults.filter(Boolean));
  }

  return results;
}

module.exports = {
  computeRiskScore,
  computeAllRiskScores,
  generateInspectionShield,
  riskLevel,
  riskLabel,
  riskIcon,
  WEIGHTS,
};
