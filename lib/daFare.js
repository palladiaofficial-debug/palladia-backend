'use strict';
// ── Da fare: una sola lista di cose da sistemare (F-236, Le quattro porte) ────
// Unisce in un elenco ordinato per urgenza quello che prima stava in sei posti
// diversi (Scadenzario, Notifiche, Copertura formativa, banner delle uscite
// mancanti, card meteo del cantiere, cartella "Scaduti"):
//
//   - scadenze sui campi (lavoratore: formazione/idoneità; azienda: DURC;
//     cantiere: suolo pubblico, fine lavori) — stessa fonte di expiry-calendar
//   - documenti con scadenza (tabella unificata `documents`, stessa regola della
//     cartella "Scaduti": expiry_date, altrimenti ai_expiry_date)
//   - giornate di pioggia/vento oltre soglia non ancora confermate né scartate
//   - uscite non timbrate chiuse in automatico ieri o oggi (stessi metodi che il
//     report ore marca come anomalia, F-146)
//   - avvisi che non hanno un'altra fonte: richiesta di aiuto dalla timbratura,
//     allerta meteo, documenti obbligatori mancanti
//
// Regole che evitano doppioni e rumore:
//   - un campo del lavoratore/azienda con la stessa data di un documento dello
//     stesso titolare è lo stesso fatto: resta la riga del documento
//   - tra più documenti dello stesso titolare e della stessa categoria conta
//     solo quello con la scadenza più lontana (un DURC rinnovato non lascia in
//     lista quello vecchio)
//   - moduli congelati (subappaltatori, economia) non entrano mai
//   - "Già prenotato / rinnovo in corso" (snooze della notifica, F-182) sposta
//     la riga in fondo, nella sezione "In corso"
// ──────────────────────────────────────────────────────────────────────────────
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');

const WINDOW_DAYS = 30;          // oltre 30 giorni non è ancora "da fare"
const WEATHER_LOOKBACK_DAYS = 30; // giornate meteo da confermare più vecchie: ignorate
const AUTO_EXIT_METHODS = ['ladia_action', 'auto_exit_stale_before_reopen', 'auto_exit_on_site_change'];
// F-318: anche l'infortunio dichiarato dall'operaio all'uscita
const NOTIF_TYPES_OWN = ['punch_help_request', 'weather_alert', 'worker_doc_missing', 'worker_injury', 'worker_illness'];

const BUCKET_ORDER = ['scaduto', 'settimana', 'mese', 'in_corso'];

// ── Date (sempre in ora italiana) ─────────────────────────────────────────────
function romeDate(d = new Date()) {
  return new Date(d).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(`${toStr}T12:00:00Z`) - Date.parse(`${fromStr}T12:00:00Z`)) / 86400000);
}
function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }

function bucketFor(days) {
  if (days < 0) return 'scaduto';
  if (days <= 7) return 'settimana';
  return 'mese';
}
function severityFor(days) {
  if (days < 0) return 'critical';
  if (days <= 7) return 'critical';
  return 'warning';
}
function whenLabel(days) {
  if (days < -1) return `scaduto da ${-days} giorni`;
  if (days === -1) return 'scaduto ieri';
  if (days === 0) return 'scade oggi';
  if (days === 1) return 'scade domani';
  return `scade tra ${days} giorni`;
}
function fmtIt(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const CATEGORY_LABEL = {
  idoneita_medica: 'Idoneità medica',
  idoneita_sanitaria: 'Idoneità medica',
  polizza: 'Polizza',
  patente_guida: 'Patente',
  idoneita: 'Idoneità medica',
  certificato_formazione: 'Formazione',
  attestato_formazione: 'Formazione',
  durc: 'DURC',
  visura: 'Visura camerale',
  assicurazione: 'Assicurazione',
  revisione: 'Revisione',
  libretto: 'Libretto',
  pos: 'POS',
};
function categoryLabel(cat) {
  if (!cat) return 'Documento';
  return CATEGORY_LABEL[cat] || cat.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}
// Tabelle di origine dove "Fatto" (F-246, lib/daFareFatto.js) sa scrivere la
// nuova scadenza. Tenuto qui e non importato per evitare un require circolare.
const FATTO_DOC_SOURCES = new Set(['worker_documents', 'worker_certificates', 'company_documents',
  'site_documents', 'subcontractor_documents', 'equipment_documents']);

function categoryType(cat) {
  if (!cat) return 'documento';
  if (cat.startsWith('idoneita')) return 'idoneita';
  if (cat.includes('formazione')) return 'formazione';
  if (cat === 'durc') return 'durc';
  if (cat === 'assicurazione' || cat === 'polizza' || cat === 'insurance') return 'assicurazione';
  if (cat === 'soa') return 'soa';
  if (cat === 'revisione') return 'revisione';
  return 'documento';
}

function ownerKey(doc) {
  if (doc.worker_id) return `worker:${doc.worker_id}`;
  if (doc.equipment_id) return `equipment:${doc.equipment_id}`;
  if (doc.subcontractor_id) return `sub:${doc.subcontractor_id}`;
  if (doc.site_id) return `site:${doc.site_id}`;
  if (doc.owner_type === 'company') return 'company';
  return null;
}

/**
 * Costruisce la lista Da fare per un'azienda e un utente (lo stato "letto"
 * degli avvisi è per utente). `todayStr` iniettabile per i test.
 */
async function buildDaFare(companyId, userId, { todayStr = romeDate() } = {}) {
  const horizon = addDays(todayStr, WINDOW_DAYS);
  const [subsEnabled] = await Promise.all([isFeatureEnabled(companyId, 'subappaltatori')]);

  const yesterday = addDays(todayStr, -1);
  const [workersRes, equipRes, companyRes, sitesRes, docsRes, notifRes, weatherRes, exitsRes, subsRes, prenRes, fixRes] = await Promise.all([
    supabase.from('workers').select('id, full_name, safety_training_expiry, health_fitness_expiry')
      .eq('company_id', companyId).eq('is_active', true),
    supabase.from('equipment').select('id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date')
      .eq('company_id', companyId).eq('is_active', true),
    supabase.from('companies').select('id, name, durc_expiry').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, status, suolo_occupazione, suolo_occupazione_end, end_date')
      .eq('company_id', companyId).in('status', ['attivo', 'sospeso']),
    supabase.from('documents')
      .select('id, source_table, legacy_id, owner_type, site_id, worker_id, subcontractor_id, equipment_id, category, name, expiry_date, ai_expiry_date')
      .eq('company_id', companyId).is('deleted_at', null)
      .neq('source_table', 'ladia_document_templates')
      .or('expiry_date.not.is.null,ai_expiry_date.not.is.null'),
    supabase.from('notifications')
      .select('id, type, severity, title, body, entity_type, entity_id, read_by, snoozed_until, updated_at')
      .eq('company_id', companyId),
    supabase.from('site_weather_logs')
      .select('id, site_id, log_date, precipitation_mm, wind_max_kmh, threshold_reason')
      .eq('company_id', companyId).eq('threshold_exceeded', true)
      .eq('suspension_confirmed', false).eq('suspension_dismissed', false)
      .gte('log_date', addDays(todayStr, -WEATHER_LOOKBACK_DAYS)).lte('log_date', todayStr),
    // Finestra larga di 2h per CET/CEST, filtro preciso sul giorno italiano sotto
    supabase.from('presence_logs')
      .select('id, worker_id, site_id, event_type, method, timestamp_server')
      .eq('company_id', companyId)
      .gte('timestamp_server', new Date(Date.parse(`${yesterday}T00:00:00Z`) - 2 * 3600e3).toISOString())
      .in('method', [...AUTO_EXIT_METHODS, 'admin_manual_correction'])
      .limit(2000),
    // F-244: scadenze sulla scheda dei subappaltatori (solo se il modulo è acceso)
    subsEnabled
      ? supabase.from('subcontractors').select('id, company_name, durc_expiry, insurance_expiry, soa_expiry')
          .eq('company_id', companyId).eq('is_active', true)
      : Promise.resolve({ data: [], error: null }),
    // F-243: righe "prenotate" ancora in corso (visita prenotata, corso fissato…)
    supabase.from('da_fare_prenotazioni').select('item_id, torna_il')
      .eq('company_id', companyId).gte('torna_il', todayStr),
    // Timbrature da sistemare (mockup 2026-10-03): casi aperti degli ultimi 7 giorni
    supabase.from('presence_fix_requests')
      .select('id, worker_id, site_id, kind, day, entry_at, exit_at, touch_at, proposed_at')
      .eq('company_id', companyId).eq('status', 'aperta').gte('day', addDays(todayStr, -7)),
  ]);

  for (const r of [workersRes, equipRes, companyRes, sitesRes, docsRes, notifRes, weatherRes, exitsRes, subsRes, prenRes, fixRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const workers = new Map((workersRes.data || []).map(w => [w.id, w]));
  const equipment = new Map((equipRes.data || []).map(e => [e.id, { ...e, name: [e.type, e.model, e.plate_or_serial].filter(Boolean).join(' — ') }]));
  const sites = new Map((sitesRes.data || []).map(s => [s.id, s]));
  const company = companyRes.data;

  // ── Snooze "già prenotato": notifica worker_document → documento legacy ──
  const today = todayStr;
  // Stessa regola di isSnoozeActive (services/expiryHelper.js) e del PATCH
  // /notifications/:id/snooze: una scadenza critica non è mai "in corso".
  const snoozedDocLegacyIds = new Set();
  const docNotifByLegacyId = new Map();
  for (const n of (notifRes.data || [])) {
    if (n.type !== 'worker_doc_expiry' || n.entity_type !== 'worker_document') continue;
    docNotifByLegacyId.set(String(n.entity_id), n);
    const active = n.snoozed_until && n.snoozed_until >= today && n.severity !== 'critical';
    if (active) snoozedDocLegacyIds.add(String(n.entity_id));
  }

  const items = [];
  const push = (it) => items.push(it);

  // ── Documenti con scadenza ────────────────────────────────────────────────
  // Solo titolari vivi (lavoratore attivo, mezzo attivo, cantiere attivo/sospeso,
  // azienda); subappaltatori solo se il modulo è acceso.
  const docs = (docsRes.data || []).filter(d => {
    if (d.worker_id) return workers.has(d.worker_id);
    if (d.equipment_id) return equipment.has(d.equipment_id);
    if (d.subcontractor_id) return subsEnabled;
    if (d.site_id) return sites.has(d.site_id);
    return d.owner_type === 'company';
  });
  // Per titolare+categoria conta solo la scadenza più lontana (rinnovo fatto).
  const latestByOwnerCat = new Map();
  for (const d of docs) {
    const exp = dateOnly(d.expiry_date || d.ai_expiry_date);
    const key = d.category ? `${ownerKey(d)}|${d.category}` : `doc:${d.id}`;
    const prev = latestByOwnerCat.get(key);
    if (!prev || exp > prev.exp) latestByOwnerCat.set(key, { d, exp });
  }
  // Scadenza documentale più lontana per titolare e tipo (idoneita/formazione/
  // durc): un campo con data uguale o precedente è lo stesso fatto o un fatto
  // già superato da un rinnovo, quindi non diventa una riga a sé.
  const docMaxByOwnerType = new Map();
  for (const { d, exp } of latestByOwnerCat.values()) {
    const k = `${ownerKey(d)}|${categoryType(d.category)}`;
    if (!docMaxByOwnerType.has(k) || exp > docMaxByOwnerType.get(k)) docMaxByOwnerType.set(k, exp);
  }
  const coveredByDoc = (owner, type, exp) => {
    const max = docMaxByOwnerType.get(`${owner}|${type}`);
    return !!max && max >= exp;
  };
  for (const { d, exp } of latestByOwnerCat.values()) {
    if (exp > horizon) continue;
    const days = daysBetween(today, exp);
    const label = categoryLabel(d.category);
    let who = '', link = '/documenti/azienda';
    if (d.worker_id) { who = workers.get(d.worker_id)?.full_name || ''; link = `/lavoratori/${d.worker_id}/documenti`; }
    else if (d.equipment_id) { who = equipment.get(d.equipment_id)?.name || ''; link = `/mezzi/${d.equipment_id}/documenti`; }
    else if (d.subcontractor_id) { link = `/subappaltatori/${d.subcontractor_id}/documenti`; }
    else if (d.site_id) { who = sites.get(d.site_id)?.name || ''; link = `/cantieri/${d.site_id}/documenti`; }
    const snoozed = d.source_table === 'worker_documents' && snoozedDocLegacyIds.has(String(d.legacy_id));
    const notif = d.source_table === 'worker_documents' ? docNotifByLegacyId.get(String(d.legacy_id)) : null;
    push({
      id: `doc:${d.id}`,
      entityId: d.worker_id || d.equipment_id || d.site_id || d.subcontractor_id || null,
      // "Già prenotato": possibile solo se esiste la notifica del cron e non è critica
      snoozeNotificationId: notif?.id || null,
      snoozable: !!notif && notif.severity !== 'critical' && days >= 0,
      // "Fatto" (F-246): solo dove lib/daFareFatto.js sa dove scrivere la data
      fattibile: FATTO_DOC_SOURCES.has(d.source_table),
      kind: 'scadenza',
      type: categoryType(d.category),
      title: who ? `${label} — ${who}` : `${label}${d.name && label === 'Documento' ? ` — ${d.name}` : ''}`,
      subtitle: snoozed ? `${whenLabel(days)} · già prenotato` : `${whenLabel(days)} · ${fmtIt(exp)}`,
      date: exp, days,
      bucket: snoozed ? 'in_corso' : bucketFor(days),
      severity: severityFor(days),
      link,
    });
  }

  // ── Campi del lavoratore (formazione / idoneità) ──────────────────────────
  for (const w of workers.values()) {
    for (const [field, type, label] of [
      ['safety_training_expiry', 'formazione', 'Formazione sicurezza'],
      ['health_fitness_expiry', 'idoneita', 'Idoneità medica'],
    ]) {
      const exp = dateOnly(w[field]);
      if (!exp || exp > horizon) continue;
      if (coveredByDoc(`worker:${w.id}`, type, exp)) continue; // già una riga documento, o rinnovato
      const days = daysBetween(today, exp);
      push({
        id: `worker:${w.id}:${type}`, entityId: w.id, kind: 'scadenza', type,
        title: `${label} — ${w.full_name}`,
        subtitle: `${whenLabel(days)} · ${fmtIt(exp)}`,
        date: exp, days, bucket: bucketFor(days), severity: severityFor(days),
        link: `/lavoratori/${w.id}/documenti`,
      });
    }
  }

  // ── Mezzi: assicurazione, revisione, tagliando (campi, stesse etichette
  //    del cron equipmentExpiryCron) ────────────────────────────────────────
  for (const e of equipment.values()) {
    for (const [field, type, label] of [
      ['insurance_expiry', 'assicurazione', 'Assicurazione'],
      ['inspection_date', 'revisione', 'Revisione periodica'],
      ['maintenance_date', 'manutenzione', 'Tagliando / Manutenzione'],
    ]) {
      const exp = dateOnly(e[field]);
      if (!exp || exp > horizon) continue;
      if (coveredByDoc(`equipment:${e.id}`, type, exp)) continue;
      const days = daysBetween(today, exp);
      push({
        id: `equipment:${e.id}:${type}`, entityId: e.id, kind: 'scadenza', type,
        title: `${label} — ${e.name}`,
        subtitle: `${whenLabel(days)} · ${fmtIt(exp)}`,
        date: exp, days, bucket: bucketFor(days), severity: severityFor(days),
        link: `/mezzi/${e.id}/scheda`,
      });
    }
  }

  // ── Subappaltatori: DURC, assicurazione, SOA sulla scheda (F-244) ─────────
  for (const sub of (subsRes.data || [])) {
    for (const [field, type, label] of [
      ['durc_expiry', 'durc', 'DURC'],
      ['insurance_expiry', 'assicurazione', 'Assicurazione'],
      ['soa_expiry', 'soa', 'SOA'],
    ]) {
      const exp = dateOnly(sub[field]);
      if (!exp || exp > horizon) continue;
      if (coveredByDoc(`sub:${sub.id}`, type, exp)) continue;
      const days = daysBetween(today, exp);
      push({
        id: `sub:${sub.id}:${type}`, entityId: sub.id, kind: 'scadenza', type,
        title: `${label} — ${sub.company_name}`,
        subtitle: `${whenLabel(days)} · ${fmtIt(exp)}`,
        date: exp, days, bucket: bucketFor(days), severity: severityFor(days),
        link: `/subappaltatori/${sub.id}/scheda`,
      });
    }
  }

  // ── DURC aziendale (campo) ────────────────────────────────────────────────
  const durc = dateOnly(company?.durc_expiry);
  if (durc && durc <= horizon && !coveredByDoc('company', 'durc', durc)) {
    const days = daysBetween(today, durc);
    push({
      id: `company:durc`, kind: 'scadenza', type: 'durc', title: 'DURC aziendale',
      subtitle: `${whenLabel(days)} · ${fmtIt(durc)}`,
      date: durc, days, bucket: bucketFor(days), severity: severityFor(days), link: '/documenti/azienda',
    });
  }

  // ── Cantieri: suolo pubblico, fine lavori ─────────────────────────────────
  for (const s of sites.values()) {
    const suolo = s.suolo_occupazione ? dateOnly(s.suolo_occupazione_end) : null;
    if (suolo && suolo <= horizon) {
      const days = daysBetween(today, suolo);
      push({
        id: `site:${s.id}:suolo`, entityId: s.id, kind: 'scadenza', type: 'suolo', title: `Suolo pubblico — ${s.name}`,
        subtitle: `${whenLabel(days)} · ${fmtIt(suolo)}`,
        date: suolo, days, bucket: bucketFor(days), severity: severityFor(days), link: `/cantieri/${s.id}/cantiere`,
      });
    }
    const end = dateOnly(s.end_date);
    if (end && end <= horizon) {
      const days = daysBetween(today, end);
      push({
        id: `site:${s.id}:fine`, entityId: s.id, kind: 'scadenza', type: 'fine_cantiere', title: `Fine lavori — ${s.name}`,
        subtitle: days < 0 ? `data di fine superata da ${-days} giorni: aggiornala o chiudi il cantiere` : `${whenLabel(days).replace('scade', 'finisce')} · ${fmtIt(end)}`,
        date: end, days, bucket: bucketFor(days), severity: severityFor(days), link: `/cantieri/${s.id}/cantiere`,
      });
    }
  }

  // ── Meteo: giornate oltre soglia da confermare ────────────────────────────
  for (const l of (weatherRes.data || [])) {
    const s = sites.get(l.site_id);
    if (!s) continue;
    // precipitation_mm è NOT NULL DEFAULT 0: il motivo decide cosa mostrare.
    const reason = String(l.threshold_reason || '').toLowerCase();
    const what = reason.includes('vento')
      ? `vento a ${Math.round(Number(l.wind_max_kmh) || 0)} km/h`
      : reason.includes('neve') ? 'neve'
      : reason.includes('temporale') ? 'temporale'
      : `${Number(l.precipitation_mm || 0).toLocaleString('it-IT', { maximumFractionDigits: 1 })} mm di pioggia`;
    push({
      id: `weather:${l.id}`, kind: 'meteo', type: 'pioggia',
      title: `Conferma sospensione ${fmtIt(l.log_date)} — ${s.name}`,
      subtitle: `${what} · confermi o scarti?`,
      date: l.log_date, days: daysBetween(today, l.log_date),
      // F-318: si conferma in Ore e assenze, con chi è uscito e le ore di ciascuno
      bucket: 'settimana', severity: 'warning', link: '/persone?tab=ore',
    });
  }

  // ── Uscite non timbrate chiuse in automatico (ieri e oggi) ────────────────
  const logs = (exitsRes.data || []).map(l => ({ ...l, day: romeDate(l.timestamp_server) }))
    .filter(l => l.day === yesterday || l.day === today);
  const corrected = new Set(logs.filter(l => l.method === 'admin_manual_correction').map(l => `${l.worker_id}|${l.day}`));
  const seenAuto = new Set();
  for (const l of logs) {
    if (l.event_type !== 'EXIT' || !AUTO_EXIT_METHODS.includes(l.method)) continue;
    const key = `${l.worker_id}|${l.day}`;
    if (corrected.has(key) || seenAuto.has(key)) continue;
    seenAuto.add(key);
    const w = workers.get(l.worker_id);
    if (!w) continue;
    const s = sites.get(l.site_id);
    push({
      id: `exit:${l.id}`, kind: 'uscita', type: 'uscita',
      title: `Uscita non timbrata — ${w.full_name}`,
      subtitle: `${l.day === today ? 'oggi' : 'ieri'}${s ? `, ${s.name}` : ''} · chiusa in automatico, controlla l'orario`,
      date: l.day, days: daysBetween(today, l.day),
      bucket: 'settimana', severity: 'warning', link: '/persone?tab=presenze',
    });
  }

  // ── Timbrature da sistemare (mockup 2026-10-03): proposta già pronta, il
  //    titolare la conferma con un tocco (lib/presenceFix.js) ──────────────
  const hm = (iso) => iso ? new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }) : '';
  for (const fr of (fixRes.data || [])) {
    const w = workers.get(fr.worker_id);
    if (!w) continue;
    // Uscita già chiusa in automatico (cron delle 20): c'è già la riga "Uscita
    // non timbrata" sopra, e la correzione in un tocco non vale più.
    if (fr.kind === 'missing_exit' && logs.some(l => l.worker_id === fr.worker_id && l.day === fr.day && l.event_type === 'EXIT' && AUTO_EXIT_METHODS.includes(l.method))) continue;
    const s = sites.get(fr.site_id);
    const when = fr.day === today ? 'oggi' : fr.day === yesterday ? 'ieri' : fmtIt(fr.day);
    const where = s ? ` · ${s.name}` : '';
    const base = {
      id: `fix:${fr.id}`, fixId: fr.id, kind: 'timbratura', type: fr.kind,
      date: fr.day, days: daysBetween(today, fr.day), bucket: 'settimana', severity: 'warning',
      link: '/persone?tab=presenze', urgent: true, fixAltTime: false, fixAction: null, fixDismiss: null,
    };
    if (fr.kind === 'missing_exit') {
      push({ ...base, title: `${w.full_name} · uscita mancante`,
        subtitle: `${when}: entrata ${hm(fr.entry_at)}, nessuna uscita${where}${fr.proposed_at ? `. Di solito esce alle ${hm(fr.proposed_at)}` : ''}`,
        fixAction: fr.proposed_at ? { label: `Uscita alle ${hm(fr.proposed_at)}` } : null, fixAltTime: true, fixAltLabel: 'Ora di uscita' });
    } else if (fr.kind === 'forgot_entry') {
      push({ ...base, title: `${w.full_name} · entrata dimenticata`,
        subtitle: `${when}: primo tocco alle ${hm(fr.touch_at)}, ha risposto "sto andando via"${where}${fr.proposed_at ? `. Di solito entra alle ${hm(fr.proposed_at)}` : ''}`,
        fixAction: fr.proposed_at ? { label: `${hm(fr.proposed_at)} → ${hm(fr.touch_at)}` } : null, fixAltTime: true, fixAltLabel: 'Ora di entrata' });
    } else if (fr.kind === 'entry_not_exit') {
      push({ ...base, title: `${w.full_name} · uscita sbagliata`,
        subtitle: `${when}: entrata ${hm(fr.entry_at)}, uscita ${hm(fr.exit_at)} dopo pochi minuti; alle ${hm(fr.touch_at)} ha detto che stava andando via${where}`,
        fixAction: { label: `Uscita alle ${hm(fr.touch_at)}` }, fixAltTime: true, fixAltLabel: 'Ora di uscita' });
    } else if (fr.kind === 'late_entry') {
      // Nessuna correzione automatica: il tocco del pomeriggio è già un'ENTRATA
      // scritta; se era in realtà l'uscita, si sistema da Presenze.
      push({ ...base, title: `${w.full_name} · primo tocco alle ${hm(fr.touch_at)}`,
        subtitle: `${when}: di solito entra alle ${hm(fr.proposed_at)}. Forse ha dimenticato l'entrata di stamattina e questa era l'uscita${where}`,
        fixDismiss: { label: 'È giusta' } });
    } else if (fr.kind === 'short_shift') {
      const min = fr.entry_at && fr.exit_at ? Math.round((new Date(fr.exit_at) - new Date(fr.entry_at)) / 60000) : null;
      push({ ...base, title: `${w.full_name} · turno di ${min ?? 'pochi'} minuti`,
        subtitle: `${when}: entrata ${hm(fr.entry_at)}, uscita ${hm(fr.exit_at)}, confermata da lui${where}`,
        fixDismiss: { label: 'È giusta' } });
    }
  }

  // ── Timbrature senza internet (F-284, mockup 2026-10-05) ────────────────
  //    "registrata": già nelle ore all'ora del telefono → "È giusta" / Correggi.
  //    "da_decidere": non scritta (orologio cambiato, senza posizione, lontano…)
  //    → la registra il titolare, all'ora del telefono o a un altro orario.
  //    Mai bloccante: un errore qui lascia il resto del Da fare intatto.
  try {
    const { FLAG_LABELS } = require('./offlinePunch');
    const { data: offline, error: offErr } = await supabase.from('presence_offline_punches')
      .select('id, worker_id, site_id, event_type, punched_at, received_at, distance_m, flags, status')
      .eq('company_id', companyId).in('status', ['registrata', 'da_decidere'])
      .gte('punched_at', new Date(Date.parse(`${addDays(todayStr, -7)}T00:00:00Z`)).toISOString())
      .order('punched_at', { ascending: true }).limit(200);
    if (offErr) throw new Error(offErr.message);
    for (const op of (offline || [])) {
      const w = workers.get(op.worker_id);
      if (!w) continue;
      const s = sites.get(op.site_id);
      const day = new Date(op.punched_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
      const when = day === today ? 'oggi' : day === yesterday ? 'ieri' : fmtIt(day);
      const what = op.event_type === 'ENTRY' ? 'entrata' : 'uscita';
      const where = s ? ` · ${s.name}${op.distance_m != null ? ` a ${op.distance_m} m` : ''}` : '';
      const base = {
        id: `offline:${op.id}`, fixId: op.id, fixEndpoint: `/api/v1/presence/offline-punches/${op.id}`,
        kind: 'timbratura', type: 'offline', date: day, days: daysBetween(today, day), bucket: 'settimana',
        link: '/persone?tab=presenze', fixAltTime: false, fixAction: null, fixDismiss: null,
      };
      if (op.status === 'registrata') {
        push({ ...base, severity: 'warning', urgent: false,
          title: `${w.full_name} · ${what} ${hm(op.punched_at)} senza internet`,
          subtitle: `${when}${where}. Arrivata alle ${hm(op.received_at)}`,
          fixDismiss: { label: 'È giusta' } });
      } else {
        const why = (op.flags || []).map(f => FLAG_LABELS[f] || f).join('. ');
        push({ ...base, severity: 'critical', urgent: true,
          title: `${w.full_name} · ${what} ${hm(op.punched_at)} senza internet, da controllare`,
          subtitle: `${when}${where}. ${why}. Non è ancora nelle ore`,
          fixAction: { label: `Registra ${what} alle ${hm(op.punched_at)}` }, fixAltTime: true, fixAltLabel: `Ora di ${what}` });
      }
    }
  } catch (e) {
    console.error('[daFare] timbrature senza internet:', e.message);
  }

  // ── Richieste dei coordinatori (F-270): POS, PSC da accettare, NC aperte ──
  //    Solo per le imprese che hanno collegato il loro account all'invito.
  //    Mai bloccante: un errore qui lascia il resto del Da fare intatto.
  try {
    const { data: inviti } = await supabase.from('psc_imprese')
      .select('id, invite_token, pos_status, pos_due_date, psc_accettato_rev, project_id, psc_projects(title, status, deleted_at, revision, soggetti)')
      .eq('linked_company_id', companyId).limit(50);
    const vivi = (inviti || []).filter(x => x.psc_projects && !x.psc_projects.deleted_at && x.psc_projects.status !== 'archiviato' && x.invite_token);
    const ids = vivi.map(x => x.id);
    const { data: ncs } = ids.length
      ? await supabase.from('psc_nc').select('id, impresa_id, descrizione, sospensione, scadenza, close_token, status, created_at').in('impresa_id', ids).eq('status', 'aperta').limit(50)
      : { data: [] };
    for (const x of vivi) {
      const p = x.psc_projects;
      const cse = (p.soggetti && p.soggetti.cse && p.soggetti.cse.nome) || 'Il coordinatore';
      const link = `/psc/invito/${x.invite_token}`;
      const base = { kind: 'coordinatore', link, date: x.pos_due_date || today, days: x.pos_due_date ? daysBetween(today, x.pos_due_date) : 0, bucket: 'settimana', severity: 'warning', urgent: false };
      if (['richiesto', 'da_integrare'].includes(x.pos_status)) {
        push({ ...base, id: `psc-pos:${x.id}`, type: 'pos_richiesto', title: x.pos_status === 'da_integrare' ? `POS da integrare · ${p.title}` : `POS richiesto · ${p.title}`,
          subtitle: `${cse}${x.pos_due_date ? ` lo aspetta entro il ${fmtIt(x.pos_due_date)}` : ' lo aspetta'}. Caricalo o fallo con Palladia.`, urgent: !!(x.pos_due_date && x.pos_due_date <= today) });
      }
      if (p.status === 'firmato' && (x.psc_accettato_rev == null || x.psc_accettato_rev < p.revision)) {
        push({ ...base, id: `psc-acc:${x.id}:${p.revision}`, type: 'psc_da_accettare', title: `PSC da accettare · ${p.title}`, subtitle: `${cse} ha firmato la revisione ${p.revision}: leggila e accettala dal link.` });
      }
    }
    for (const n of ncs || []) {
      const x = vivi.find(v => v.id === n.impresa_id);
      push({ id: `psc-nc:${n.id}`, kind: 'coordinatore', type: 'non_conformita', link: `/psc/nc/${n.close_token}`,
        title: `${n.sospensione ? 'Lavorazione sospesa' : 'Non conformità'} · ${x ? x.psc_projects.title : 'cantiere'}`, subtitle: `${n.descrizione}. Quando hai risolto mandala con una foto.`,
        date: n.scadenza || dateOnly(n.created_at), days: n.scadenza ? daysBetween(today, n.scadenza) : 0, bucket: 'settimana', severity: n.sospensione ? 'critical' : 'warning', urgent: !!n.sospensione });
    }
  } catch (e) { console.error('[daFare] richieste coordinatori:', e && e.message); }

  // ── Avvisi senza altra fonte (non letti da questo utente) ─────────────────
  for (const n of (notifRes.data || [])) {
    if (!NOTIF_TYPES_OWN.includes(n.type)) continue;
    if (userId && (n.read_by || []).includes(userId)) continue;
    // Un'allerta meteo è una previsione: passati 2 giorni riguarda giornate
    // già trascorse e non c'è più niente da fare (resta nel meteo del cantiere).
    if (n.type === 'weather_alert' && dateOnly(n.updated_at) < addDays(today, -2)) continue;
    const snoozed = n.snoozed_until && n.snoozed_until >= today;
    let link = '/scadenze';
    if (n.type === 'weather_alert' && n.entity_id) link = `/cantieri/${n.entity_id}/cantiere`;
    else if (n.type === 'punch_help_request') link = '/persone?tab=presenze';
    else if (n.type === 'worker_injury' || n.type === 'worker_illness') link = '/persone?tab=ore';
    else if (n.type === 'worker_doc_missing' && n.entity_type === 'worker' && n.entity_id) link = `/lavoratori/${n.entity_id}/documenti`;
    push({
      id: `notif:${n.id}`, notificationId: n.id, kind: 'avviso', type: n.type,
      entityId: n.type === 'worker_doc_missing' ? n.entity_id : null,
      snoozeNotificationId: n.type === 'worker_doc_missing' ? n.id : null,
      snoozable: n.type === 'worker_doc_missing' && !snoozed,
      title: n.title, subtitle: n.body || '',
      date: dateOnly(n.updated_at), days: 0,
      bucket: snoozed ? 'in_corso' : n.type === 'worker_injury' ? 'scaduto' : (n.type === 'weather_alert' ? 'mese' : 'settimana'),
      severity: n.severity || 'warning', link,
      urgent: n.type === 'punch_help_request' || n.type === 'worker_injury',
    });
  }

  // ── "Prenotata" (F-243): ogni scadenza si può mettere da parte fino a una
  //    data; poi torna da sola. Se nel frattempo arriva il documento nuovo la
  //    riga non esiste più (scadenza risolta) e la prenotazione non conta. ──
  const prenotate = new Map((prenRes.data || []).map(r => [r.item_id, r.torna_il]));
  for (const it of items) {
    if (it.kind !== 'scadenza') continue;
    it.prenotabile = true;
    if (it.fattibile === undefined) it.fattibile = it.type !== 'fine_cantiere';
    const until = prenotate.get(it.id);
    if (until) {
      it.bucket = 'in_corso';
      it.prenotataFino = until;
      it.subtitle = `prenotata · torna il ${fmtIt(until)} se non arriva il documento nuovo`;
    }
  }

  // ── Ordine: per sezione, poi urgenti in cima, poi per data ────────────────
  items.sort((a, b) =>
    BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
    (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) ||
    a.days - b.days || a.title.localeCompare(b.title, 'it'));

  const counts = { scaduto: 0, settimana: 0, mese: 0, in_corso: 0 };
  for (const it of items) counts[it.bucket]++;
  return { today, items, counts, attention: counts.scaduto + counts.settimana };
}

module.exports = { buildDaFare, romeDate, addDays, daysBetween, AUTO_EXIT_METHODS };
