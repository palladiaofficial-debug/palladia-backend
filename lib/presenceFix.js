'use strict';
// ── Timbrature da sistemare (mockup "Timbrature senza errori", 2026-10-03) ────
// Un caso per riga in presence_fix_requests (migrazione 235), con la proposta
// già pronta. Il titolare la conferma con un tocco da Da fare. presence_logs
// resta append-only: la correzione è una riga admin_manual_correction (o
// un'annotazione), esattamente come la Correzione manuale di Presenze — ma
// SOLO se lo stato è ancora quello del caso: se l'operaio nel frattempo ha
// timbrato, non si scrive niente (STATE_CHANGED) e il caso va guardato a mano.
const supabase = require('./supabase');
const { romeDay, romeAt, hhmm } = require('./usualTimes');

const KINDS = ['missing_exit', 'forgot_entry', 'entry_not_exit', 'short_shift'];
const APPLICABLE = ['missing_exit', 'forgot_entry', 'entry_not_exit'];

/**
 * Caso aperto dalla risposta dell'operaio "No, sto andando via":
 *   FORGOT_ENTRY   (primo tocco nel pomeriggio) → entrata proposta all'orario abituale, uscita all'ora del tocco
 *   ENTRY_NOT_EXIT (dopo un turno di pochi minuti, F-266) → l'uscita di pochi minuti si annota, uscita vera all'ora del tocco
 */
async function fixRequestFromWorker({ worker, siteId, reason, now = new Date() }) {
  const day = romeDay(now);
  const base = { company_id: worker.company_id, worker_id: worker.id, site_id: siteId || null, day, touch_at: now.toISOString() };
  if (reason === 'FORGOT_ENTRY') {
    const { usualTimesFor } = require('./usualTimes');
    let entryMin = null;
    try { entryMin = (await usualTimesFor(worker.company_id, [worker.id], { today: day })).get(worker.id)?.entryMin ?? null; } catch { /* nessuna proposta */ }
    const proposed = entryMin != null ? romeAt(day, entryMin) : null;
    return createFixRequest({ ...base, kind: 'forgot_entry', proposed_at: proposed && new Date(proposed) < now ? proposed : null });
  }
  if (reason === 'ENTRY_NOT_EXIT') {
    const [l0, l1] = await lastLogs(worker.id, worker.company_id, 2);
    if (l0?.event_type !== 'EXIT' || l1?.event_type !== 'ENTRY') return false;
    return createFixRequest({
      ...base, site_id: siteId || l0.site_id, kind: 'entry_not_exit', day: romeDay(l0.timestamp_server),
      entry_log_id: l1.id, entry_at: l1.timestamp_server, exit_log_id: l0.id, exit_at: l0.timestamp_server, proposed_at: now.toISOString(),
    });
  }
  return false;
}

/** Crea un caso (ignorato se ne esiste già uno per lavoratore, tipo e giorno). */
async function createFixRequest(row) {
  if (!KINDS.includes(row.kind)) throw new Error(`kind non valido: ${row.kind}`);
  const { error } = await supabase.from('presence_fix_requests')
    .upsert({ status: 'aperta', ...row }, { onConflict: 'worker_id,kind,day', ignoreDuplicates: true });
  if (error) console.error('[presenceFix] create error:', error.message);
  return !error;
}

async function lastLogs(workerId, companyId, n = 1) {
  const { data, error } = await supabase.from('presence_logs').select('id, event_type, timestamp_server, site_id')
    .eq('worker_id', workerId).eq('company_id', companyId)
    .order('timestamp_server', { ascending: false }).limit(n);
  if (error) throw new Error(error.message);
  return data || [];
}

function correctionRow(fr, eventType, ts) {
  return {
    company_id: fr.company_id, site_id: fr.site_id, worker_id: fr.worker_id, event_type: eventType,
    timestamp_server: ts, method: 'admin_manual_correction', ip_address: null, user_agent: 'da-fare:timbrature-da-sistemare',
  };
}

/** "HH:MM" del giorno del caso → ISO; null se non valido. */
function atToIso(day, at) {
  if (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return null;
  const [h, m] = at.split(':').map(Number);
  return romeAt(day, h * 60 + m);
}

/**
 * Applica la proposta (o l'orario `at` scelto dal titolare, "HH:MM").
 * @returns {{ ok: true, written: string[] } | { ok: false, code: string, message: string }}
 */
async function applyFixRequest({ id, companyId, userId, userRole, at = null }) {
  const { data: fr, error } = await supabase.from('presence_fix_requests').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, code: 'DB_ERROR', message: error.message };
  if (!fr) return { ok: false, code: 'NOT_FOUND', message: 'Caso non trovato.' };
  if (fr.status !== 'aperta') return { ok: false, code: 'ALREADY_DONE', message: 'Questo caso è già stato sistemato.' };
  if (!APPLICABLE.includes(fr.kind)) return { ok: false, code: 'NOT_APPLICABLE', message: 'Questo caso si corregge da Presenze.' };
  if (!fr.site_id) return { ok: false, code: 'NO_SITE', message: 'Cantiere non noto: correggi da Presenze.' };

  const chosen = at != null ? atToIso(fr.day, at) : fr.proposed_at;
  if (at != null && !chosen) return { ok: false, code: 'INVALID_TIME', message: 'Orario non valido (HH:MM).' };
  const now = new Date();
  const [last] = await lastLogs(fr.worker_id, companyId);
  const rows = [];
  let annotateExitLogId = null;

  if (fr.kind === 'missing_exit') {
    if (!last || last.id !== fr.entry_log_id || last.event_type !== 'ENTRY') return { ok: false, code: 'STATE_CHANGED', message: 'Nel frattempo ha timbrato: controlla da Presenze.' };
    if (!chosen || new Date(chosen) <= new Date(fr.entry_at) || new Date(chosen) > now) return { ok: false, code: 'INVALID_TIME', message: `L'uscita deve essere dopo l'entrata (${hhmm(minOf(fr.entry_at))}) e non nel futuro.` };
    rows.push(correctionRow(fr, 'EXIT', chosen));
  } else if (fr.kind === 'forgot_entry') {
    // Nessuna timbratura dell'operaio quel giorno prima del suo tocco, e nessuna dopo
    const dayStart = romeAt(fr.day, 0);
    const { count } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true })
      .eq('worker_id', fr.worker_id).eq('company_id', companyId).gte('timestamp_server', dayStart);
    if (count) return { ok: false, code: 'STATE_CHANGED', message: 'Nel frattempo ha timbrato: controlla da Presenze.' };
    if (!chosen || new Date(chosen) >= new Date(fr.touch_at)) return { ok: false, code: 'INVALID_TIME', message: `L'entrata deve essere prima delle ${hhmm(minOf(fr.touch_at))}.` };
    rows.push(correctionRow(fr, 'ENTRY', chosen), correctionRow(fr, 'EXIT', fr.touch_at));
  } else if (fr.kind === 'entry_not_exit') {
    // L'uscita di pochi minuti era sbagliata: si annota (le ore la ignorano,
    // come i glitch di F-184) e si registra l'uscita vera all'ora del tocco.
    if (!last || last.id !== fr.exit_log_id) return { ok: false, code: 'STATE_CHANGED', message: 'Nel frattempo ha timbrato: controlla da Presenze.' };
    const exitAt = at != null ? chosen : fr.touch_at;
    if (!exitAt || new Date(exitAt) <= new Date(fr.exit_at) || new Date(exitAt) > now) return { ok: false, code: 'INVALID_TIME', message: 'Orario di uscita non valido.' };
    annotateExitLogId = fr.exit_log_id;
    rows.push(correctionRow(fr, 'EXIT', exitAt));
  }

  // Prende il caso (solo se ancora aperto: due tocchi del titolare non scrivono due volte)
  const { data: claimed } = await supabase.from('presence_fix_requests')
    .update({ status: 'risolta', resolved_by: userId, resolved_at: now.toISOString() })
    .eq('id', id).eq('status', 'aperta').select('id');
  if (!claimed?.length) return { ok: false, code: 'ALREADY_DONE', message: 'Questo caso è già stato sistemato.' };

  if (annotateExitLogId) {
    const { error: aErr } = await supabase.from('admin_audit_log').insert([{
      company_id: companyId, user_id: userId, user_role: userRole, action: 'presence.log_annotation',
      target_type: 'presence_log', target_id: annotateExitLogId,
      payload: { note: "Uscita di pochi minuti sbagliata: l'operaio stava andando via più tardi (Timbrature da sistemare)", worker_id: fr.worker_id, event_type: 'EXIT', timestamp_server: fr.exit_at },
    }]);
    if (aErr) {
      await supabase.from('presence_fix_requests').update({ status: 'aperta', resolved_by: null, resolved_at: null }).eq('id', id);
      return { ok: false, code: 'DB_ERROR', message: aErr.message };
    }
  }
  const { data: written, error: insErr } = await supabase.from('presence_logs').insert(rows).select('id');
  if (insErr) {
    await supabase.from('presence_fix_requests').update({ status: 'aperta', resolved_by: null, resolved_at: null }).eq('id', id);
    return { ok: false, code: 'DB_ERROR', message: insErr.message };
  }
  const ids = (written || []).map(r => r.id);
  await supabase.from('presence_fix_requests').update({ resolution: { action: 'apply', at: at || null, logs: ids, annotated: annotateExitLogId } }).eq('id', id);
  for (const r of rows) {
    supabase.from('admin_audit_log').insert([{
      company_id: companyId, user_id: userId, user_role: userRole, action: 'presence.manual_correction',
      target_type: 'presence_fix_request', target_id: id,
      payload: { worker_id: fr.worker_id, site_id: fr.site_id, event_type: r.event_type, timestamp: r.timestamp_server, note: `Timbrature da sistemare: ${fr.kind}` },
    }]).then(({ error: e }) => { if (e) console.error('[presenceFix] audit error:', e.message); });
  }
  return { ok: true, written: ids };
}

/** "È giusta" / "Va bene così": il caso si chiude senza scrivere niente. */
async function dismissFixRequest({ id, companyId, userId }) {
  const { data, error } = await supabase.from('presence_fix_requests')
    .update({ status: 'ignorata', resolved_by: userId, resolved_at: new Date().toISOString(), resolution: { action: 'dismiss' } })
    .eq('id', id).eq('company_id', companyId).eq('status', 'aperta').select('id');
  if (error) return { ok: false, code: 'DB_ERROR', message: error.message };
  if (!data?.length) return { ok: false, code: 'ALREADY_DONE', message: 'Questo caso è già stato sistemato.' };
  return { ok: true };
}

function minOf(iso) {
  const [h, m] = new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return h * 60 + m;
}

module.exports = { fixRequestFromWorker, createFixRequest, applyFixRequest, dismissFixRequest, KINDS, APPLICABLE, romeDay };
