'use strict';
/**
 * services/valueMetrics.js
 *
 * Layer "proof of value" — calcola i 4 numeri del widget dashboard impresa:
 *   - scadenze intercettate (notificate in anticipo E rinnovate prima della scadenza)
 *   - sanzioni potenziali evitate (solo sulle scadenze intercettate, solo tipi
 *     con una sanzione D.Lgs 81/2008 mappata — vedi migrazione 140)
 *   - documenti generati (pos_documents + document_exports)
 *   - ore di presenza tracciate (pairing ENTRY/EXIT via lib/presencePairing)
 *
 * REGOLA: ogni numero deve reggere un click — le stesse funzioni qui sotto
 * producono sia il conteggio aggregato (scritto in value_metrics dal cron
 * giornaliero) sia l'elenco `items` usato dal drill-down (routes/v1/valueMetrics.js,
 * calcolato live, sempre aggiornato).
 *
 * Non retroattivo per i tipi diversi da worker_certificates: expiry_interception_log
 * esiste solo da migrazione 141 (2026-07-28) — vedi memoria proof_of_value_layer.
 */

const supabase = require('../lib/supabase');
const { pairLogsByDay } = require('../lib/presencePairing');

const MS_DAY = 86_400_000;

function daysLeft(dateStr) {
  if (!dateStr) return null;
  return Math.floor((new Date(dateStr) - Date.now()) / MS_DAY);
}

// ── Scadenze intercettate + sanzioni evitate ──────────────────────────────────
// "Intercettata" = notificata in anticipo E poi risolta (rinnovata) prima della
// scadenza. resolved_at in expiry_interception_log è il segnale grezzo (scritto
// da pruneNotifications quando il problema esce dal set "in scadenza") — qui lo
// ri-verifichiamo sempre contro lo stato ATTUALE dell'entità, perché "risolto"
// può anche voler dire "il record è stato eliminato", non necessariamente
// rinnovato. Se l'entità non esiste più o è di nuovo in scadenza, l'evento non
// viene contato.
async function computeScadenzeESanzioni(companyId) {
  const items = [];

  const { data: generic } = await supabase
    .from('expiry_interception_log')
    .select('id, entity_type, entity_id, notification_type, notified_at, resolved_at')
    .eq('company_id', companyId)
    .not('resolved_at', 'is', null)
    .limit(5000);

  const byType = {};
  for (const row of generic || []) {
    (byType[row.entity_type] ??= []).push(row);
  }

  // ── company_document ──
  if (byType.company_document?.length) {
    const ids = byType.company_document.map(r => r.entity_id);
    const { data: docs } = await supabase.from('company_documents')
      .select('id, name, category, ai_expiry_date').in('id', ids);
    const byId = Object.fromEntries((docs || []).map(d => [d.id, d]));
    for (const row of byType.company_document) {
      const doc = byId[row.entity_id];
      if (!doc?.ai_expiry_date) continue;
      const dl = daysLeft(doc.ai_expiry_date);
      if (dl === null || dl <= 30) continue;
      items.push({
        entity_type: 'company_document', entity_id: row.entity_id,
        label: doc.name, category: doc.category,
        notified_at: row.notified_at, resolved_at: row.resolved_at,
      });
    }
  }

  // ── subcontractor (entity_id composito "<id>::field") ──
  if (byType.subcontractor?.length) {
    const subIds = [...new Set(byType.subcontractor.map(r => r.entity_id.split('::')[0]))];
    const { data: subs } = await supabase.from('subcontractors')
      .select('id, company_name, durc_expiry, insurance_expiry, soa_expiry').in('id', subIds);
    const byId = Object.fromEntries((subs || []).map(s => [s.id, s]));
    const FIELD_LABEL = { durc_expiry: 'DURC', insurance_expiry: 'Assicurazione', soa_expiry: 'SOA' };
    for (const row of byType.subcontractor) {
      const [subId, field] = row.entity_id.split('::');
      const sub = byId[subId];
      if (!sub?.[field]) continue;
      const dl = daysLeft(sub[field]);
      if (dl === null || dl <= 30) continue;
      items.push({
        entity_type: 'subcontractor', entity_id: row.entity_id,
        label: `${FIELD_LABEL[field] || field} — ${sub.company_name}`, category: null,
        notified_at: row.notified_at, resolved_at: row.resolved_at,
      });
    }
  }

  // ── equipment ──
  if (byType.equipment?.length) {
    const ids = byType.equipment.map(r => r.entity_id);
    const { data: eqs } = await supabase.from('equipment')
      .select('id, type, model, insurance_expiry').in('id', ids);
    const byId = Object.fromEntries((eqs || []).map(e => [e.id, e]));
    for (const row of byType.equipment) {
      const eq = byId[row.entity_id];
      if (!eq?.insurance_expiry) continue;
      const dl = daysLeft(eq.insurance_expiry);
      if (dl === null || dl <= 30) continue;
      items.push({
        entity_type: 'equipment', entity_id: row.entity_id,
        label: `${eq.type}${eq.model ? ' ' + eq.model : ''}`, category: null,
        notified_at: row.notified_at, resolved_at: row.resolved_at,
      });
    }
  }

  // ── worker_document ──
  if (byType.worker_document?.length) {
    const ids = byType.worker_document.map(r => r.entity_id);
    const { data: wds } = await supabase.from('worker_documents')
      .select('id, name, expiry_date, worker_id, workers(full_name)').in('id', ids);
    const byId = Object.fromEntries((wds || []).map(w => [w.id, w]));
    for (const row of byType.worker_document) {
      const wd = byId[row.entity_id];
      if (!wd?.expiry_date) continue;
      const dl = daysLeft(wd.expiry_date);
      if (dl === null || dl <= 30) continue;
      items.push({
        entity_type: 'worker_document', entity_id: row.entity_id,
        label: `${wd.name} — ${wd.workers?.full_name || 'lavoratore'}`, category: null,
        notified_at: row.notified_at, resolved_at: row.resolved_at,
      });
    }
  }

  // ── company (DURC impresa) ──
  if (byType.company?.length) {
    const { data: comp } = await supabase.from('companies')
      .select('durc_expiry').eq('id', companyId).maybeSingle();
    const dl = daysLeft(comp?.durc_expiry);
    if (dl !== null && dl > 30) {
      for (const row of byType.company) {
        items.push({
          entity_type: 'company', entity_id: row.entity_id,
          label: 'DURC impresa', category: 'durc',
          notified_at: row.notified_at, resolved_at: row.resolved_at,
        });
      }
    }
  }
  // 'site' (occupazione suolo pubblico): non è una violazione D.Lgs 81/2008 e non
  // ha una singola data di scadenza riverificabile allo stesso modo — escluso
  // deliberatamente dal conteggio in questa v1.

  // ── worker_certificate (Formazione — expiry_notifications, storico più lungo) ──
  const { data: certNotifs } = await supabase
    .from('expiry_notifications')
    .select('certificate_id, worker_id, notification_type, sent_at')
    .eq('company_id', companyId)
    .neq('notification_type', 'expired')
    .order('sent_at', { ascending: true })
    .limit(5000);

  const firstByCert = {};
  for (const n of certNotifs || []) {
    if (!firstByCert[n.certificate_id] || n.sent_at < firstByCert[n.certificate_id].sent_at) {
      firstByCert[n.certificate_id] = n;
    }
  }
  const certIds = Object.keys(firstByCert);
  if (certIds.length) {
    const { data: certs } = await supabase.from('worker_certificates')
      .select('id, worker_id, course_type_id, expiry_date, issue_date, course_types(name, violation_code)')
      .in('id', certIds);
    const certById = Object.fromEntries((certs || []).map(c => [c.id, c]));
    const workerIds = [...new Set((certs || []).map(c => c.worker_id))];

    const [{ data: allCerts }, { data: workers }] = await Promise.all([
      workerIds.length
        ? supabase.from('worker_certificates')
            .select('id, worker_id, course_type_id, issue_date, expiry_date').in('worker_id', workerIds)
        : Promise.resolve({ data: [] }),
      workerIds.length
        ? supabase.from('workers').select('id, full_name').in('id', workerIds)
        : Promise.resolve({ data: [] }),
    ]);
    const workerName = Object.fromEntries((workers || []).map(w => [w.id, w.full_name]));

    for (const certId of certIds) {
      const notif = firstByCert[certId];
      const cert  = certById[certId];
      if (!cert) continue; // certificato cancellato — non verificabile, escluso
      const renewal = (allCerts || []).find(c =>
        c.worker_id === cert.worker_id && c.course_type_id === cert.course_type_id &&
        c.id !== certId &&
        new Date(c.issue_date) >= new Date(notif.sent_at) &&
        new Date(c.expiry_date) > new Date(cert.expiry_date)
      );
      if (!renewal) continue;
      items.push({
        entity_type: 'worker_certificate', entity_id: certId,
        label: `${cert.course_types?.name || 'Formazione'} — ${workerName[cert.worker_id] || 'lavoratore'}`,
        category: null, violation_code: cert.course_types?.violation_code || null,
        notified_at: notif.sent_at, resolved_at: renewal.issue_date,
      });
    }
  }

  // ── Somma sanzioni: solo sugli item con una violation_code mappata ─────────
  const { data: catMap } = await supabase.from('document_category_sanction_map').select('category, violation_code');
  const catToViolation = Object.fromEntries((catMap || []).map(m => [m.category, m.violation_code]));
  for (const item of items) {
    if (!item.violation_code && item.category) item.violation_code = catToViolation[item.category] || null;
  }

  const codes = [...new Set(items.map(i => i.violation_code).filter(Boolean))];
  let sanzioniCents = 0;
  if (codes.length) {
    const { data: ranges } = await supabase.from('sanction_ranges')
      .select('violation_code, amount_min_cents, violation_label').in('violation_code', codes);
    const byCode = Object.fromEntries((ranges || []).map(r => [r.violation_code, r]));
    for (const item of items) {
      const r = item.violation_code && byCode[item.violation_code];
      if (r) {
        item.amount_min_cents = r.amount_min_cents;
        item.violation_label  = r.violation_label;
        sanzioniCents += r.amount_min_cents;
      }
    }
  }

  items.sort((a, b) => new Date(b.resolved_at) - new Date(a.resolved_at));
  return { count: items.length, sanzioniCents, items };
}

// ── Documenti generati ─────────────────────────────────────────────────────────
async function computeDocumentiGenerati(companyId) {
  const [{ data: pos }, { data: exp }] = await Promise.all([
    supabase.from('pos_documents')
      .select('id, revision, created_at, sites(name)').eq('company_id', companyId).limit(2000),
    supabase.from('document_exports')
      .select('id, export_type, title, created_at').eq('company_id', companyId).limit(2000),
  ]);

  const EXPORT_LABEL = {
    contratto_subappalto: 'Contratto di subappalto',
    report_chat_pdf:      'Report (PDF)',
    report_chat_excel:    'Report (Excel)',
    report_vigilanza:     'Report Vigilanza',
  };

  const items = [
    ...(pos || []).map(p => ({
      type: 'pos', label: `POS${p.sites?.name ? ' — ' + p.sites.name : ''} (rev. ${p.revision})`,
      created_at: p.created_at,
    })),
    ...(exp || []).map(e => ({
      type: e.export_type, label: e.title || EXPORT_LABEL[e.export_type] || e.export_type,
      created_at: e.created_at,
    })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { count: items.length, items };
}

// ── Ore di presenza tracciate ───────────────────────────────────────────────────
// Recompute completo (non incrementale) via lib/presencePairing.js — l'unico
// algoritmo di pairing usato in tutta la piattaforma. Self-correggente rispetto
// a rettifiche presenze (presenceCorrections.js), a costo di rileggere tutto lo
// storico ogni notte: accettabile per un job batch, non per request utente.
async function computeOrePresenza(companyId) {
  const { data: logs } = await supabase
    .from('presence_logs')
    .select('worker_id, site_id, event_type, timestamp_server')
    .eq('company_id', companyId)
    .order('timestamp_server', { ascending: true })
    .limit(50000);

  const byWorker = {};
  for (const l of logs || []) (byWorker[l.worker_id] ??= []).push(l);

  const workerIds = Object.keys(byWorker);
  const siteIds   = [...new Set((logs || []).map(l => l.site_id).filter(Boolean))];
  const [{ data: workers }, { data: sites }] = await Promise.all([
    workerIds.length ? supabase.from('workers').select('id, full_name').in('id', workerIds) : Promise.resolve({ data: [] }),
    siteIds.length   ? supabase.from('sites').select('id, name').in('id', siteIds)           : Promise.resolve({ data: [] }),
  ]);
  const workerName = Object.fromEntries((workers || []).map(w => [w.id, w.full_name]));
  const siteName   = Object.fromEntries((sites || []).map(s => [s.id, s.name]));

  let totalMs = 0;
  const shifts = [];
  for (const [workerId, wLogs] of Object.entries(byWorker)) {
    const byDay = pairLogsByDay(wLogs);
    for (const [dateKey, bucket] of byDay) {
      for (const { entry, exit } of bucket.pairs) {
        const ms = new Date(exit.timestamp_server) - new Date(entry.timestamp_server);
        // Scarta turni anomali (>16h): quasi certamente un'uscita mancata
        // corretta male, non un vero turno — evita di gonfiare il totale.
        if (ms > 0 && ms < 16 * 60 * 60 * 1000) {
          totalMs += ms;
          shifts.push({
            worker_id: workerId, worker_name: workerName[workerId] || 'lavoratore',
            site_id: entry.site_id, site_name: siteName[entry.site_id] || null, date: dateKey,
            hours: Math.round(ms / 36000) / 100,
          });
        }
      }
    }
  }
  shifts.sort((a, b) => b.date.localeCompare(a.date));

  return {
    totalHours: Math.round(totalMs / 3_600_000 * 10) / 10,
    totalShifts: shifts.length,
    items: shifts.slice(0, 200), // drill-down: ultimi 200 turni, non l'intera storia
  };
}

// ── Orchestratore — chiamato dal cron giornaliero per company ─────────────────
async function computeAndStoreValueMetrics(companyId) {
  const [scad, doc, pres] = await Promise.all([
    computeScadenzeESanzioni(companyId),
    computeDocumentiGenerati(companyId),
    computeOrePresenza(companyId),
  ]);

  const hasData = scad.count > 0 || doc.count > 0 || pres.totalHours > 0;

  const { error } = await supabase.from('value_metrics').upsert({
    company_id:             companyId,
    scadenze_intercettate:  scad.count,
    sanzioni_evitate_cents: scad.sanzioniCents,
    documenti_generati:     doc.count,
    ore_presenza_tracciate: pres.totalHours,
    has_data:               hasData,
    computed_at:            new Date().toISOString(),
  }, { onConflict: 'company_id' });

  if (error) throw error;
  return { scadenze: scad, documenti: doc, presenze: pres };
}

// ── Log di un export riuscito (contratto, report chat, ...) ───────────────────
// Best-effort: un fallimento qui non deve mai far fallire la risposta PDF/Excel
// già generata con successo — vedi routes/v1/chat.js (chiamato subito prima di
// inviare il file al client).
async function logDocumentExport({ companyId, userId, exportType, title }) {
  try {
    await supabase.from('document_exports').insert({
      company_id: companyId, user_id: userId, export_type: exportType, title: title || null,
    });
  } catch { /* best-effort */ }
}

module.exports = {
  computeScadenzeESanzioni,
  computeDocumentiGenerati,
  computeOrePresenza,
  computeAndStoreValueMetrics,
  logDocumentExport,
};
