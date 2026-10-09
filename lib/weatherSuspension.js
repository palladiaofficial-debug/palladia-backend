'use strict';
/**
 * lib/weatherSuspension.js — conferma / scarta / annulla una giornata di
 * maltempo di un cantiere.
 *
 * Estratto senza cambiamenti da routes/v1/siteWeather.js (F-318, AUDIT.md del
 * frontend): la stessa conferma serve ora anche a "Pioggia da confermare" di
 * Ore e assenze (lib/pioggiaDaConfermare.js), che deve produrre lo stesso
 * record legale (site_suspension_days), la stessa proroga di fine lavori e le
 * stesse notifiche della scheda Meteo del cantiere. Ogni funzione ritorna
 * { status, body } come la risposta HTTP di prima.
 */
const supabase = require('./supabase');
const { calcEndDate } = require('./calcEndDate');

const SITE_COLS = 'id, name, address, comune, client, start_date, end_date, contract_days, days_type';

async function loadSite(siteId, companyId) {
  const { data } = await supabase.from('sites').select(SITE_COLS)
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  return data || null;
}

async function recalcEndDate(site, companyId, tag) {
  const { data: suspRows } = await supabase.from('site_suspension_days').select('day').eq('site_id', site.id);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows || []).map(r => r.day), site.comune ?? null);
  if (newEnd) {
    const { error } = await supabase.from('sites').update({ end_date: newEnd }).eq('id', site.id).eq('company_id', companyId);
    if (error) console.error(`[${tag}] ${site.id}: end_date non aggiornata:`, error.message);
  }
  return newEnd;
}

async function pendingDaysOf(siteId) {
  const { data } = await supabase.from('site_weather_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true)
    .eq('suspension_confirmed', false).eq('suspension_dismissed', false);
  return (data || []).map(r => r.log_date);
}

async function upsertPendingNotification(companyId, site, pendingDays) {
  const listIt = pendingDays.sort().map(d => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }));
  await supabase.from('notifications').upsert({
    company_id: companyId, type: 'weather_suspension', severity: 'warning',
    title: `Meteo — ${pendingDays.length} ${pendingDays.length === 1 ? 'giornata' : 'giornate'} da confermare`,
    body: `${site.name}\n${listIt.join(' · ')}`,
    entity_type: 'site', entity_id: site.id, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id,type' });
}

async function deletePendingNotification(companyId, siteId) {
  await supabase.from('notifications').delete()
    .eq('company_id', companyId).eq('entity_type', 'site')
    .eq('entity_id', siteId).eq('type', 'weather_suspension');
}

/** Conferma la sospensione per maltempo di un giorno. */
async function confirmSuspension({ companyId, site, date, notes = null, userId = null }) {
  const { data: log } = await supabase
    .from('site_weather_logs')
    .select('id, threshold_reason, precipitation_mm, wind_max_kmh, weather_desc, data_source, arpal_station_name')
    .eq('site_id', site.id).eq('log_date', date).maybeSingle();
  if (!log) return { status: 404, body: { error: 'LOG_NOT_FOUND' } };

  // F-199 (AUDIT.md): la nota finisce in site_suspension_days.notes, un
  // documento legale — deve riflettere la fonte reale del giorno.
  const fonteLabel = log.data_source === 'arpal_certified'
    ? `ARPAL${log.arpal_station_name ? ` (stazione ${log.arpal_station_name})` : ''}`
    : log.data_source === 'era5_confirmed' ? 'ERA5 (Open-Meteo)' : 'stima Open-Meteo, in attesa di certificazione ARPAL';
  const autoNotes = [
    log.weather_desc,
    log.precipitation_mm > 0 ? `${log.precipitation_mm}mm pioggia` : null,
    log.wind_max_kmh > 0 ? `vento ${log.wind_max_kmh}km/h max` : null,
    notes ? `— ${notes}` : null,
    `| Fonte: ${fonteLabel}`,
  ].filter(Boolean).join(' · ');

  const { data: suspension, error: suspErr } = await supabase
    .from('site_suspension_days')
    .upsert({
      company_id: companyId, site_id: site.id, day: date,
      reason: log.threshold_reason || 'pioggia', notes: autoNotes, created_by: userId ?? null,
    }, { onConflict: 'site_id,day' })
    .select('id').single();
  if (suspErr) return { status: 500, body: { error: 'DB_ERROR', message: suspErr.message } };

  // F-202 (AUDIT.md): l'update del log va controllato, altrimenti il giorno
  // resterebbe "da confermare" con la sospensione già creata.
  const { data: logUpdated, error: logUpdateErr } = await supabase
    .from('site_weather_logs').update({ suspension_confirmed: true, suspension_id: suspension.id })
    .eq('id', log.id).select('id');
  if (logUpdateErr) return { status: 500, body: { error: 'DB_ERROR', message: logUpdateErr.message } };
  if (!logUpdated?.length) return { status: 500, body: { error: 'DB_ERROR', message: 'Sospensione creata ma il log meteo non è stato aggiornato: il giorno risulterebbe ancora "da confermare".' } };

  const newEnd = await recalcEndDate(site, companyId, 'weatherConfirm');

  const pendingDays = await pendingDaysOf(site.id);
  if (pendingDays.length === 0) await deletePendingNotification(companyId, site.id);
  else await upsertPendingNotification(companyId, site, pendingDays);

  return { status: 200, body: { ok: true, suspension, newEndDate: newEnd ?? null } };
}

/** "Non era maltempo" per un giorno. */
async function dismissSuspension({ companyId, site, date }) {
  // F-201 (AUDIT.md): un update senza righe toccate non è un successo.
  const { data: updated, error: updateErr } = await supabase
    .from('site_weather_logs').update({ suspension_dismissed: true })
    .eq('site_id', site.id).eq('log_date', date).select('id');
  if (updateErr) return { status: 500, body: { error: 'DB_ERROR', message: updateErr.message } };
  if (!updated?.length) return { status: 404, body: { error: 'LOG_NOT_FOUND' } };

  const pendingDays = await pendingDaysOf(site.id);
  if (!pendingDays.length) await deletePendingNotification(companyId, site.id);
  return { status: 200, body: { ok: true } };
}

/** Annulla una sospensione confermata (o uno scarto): il giorno torna pendente. */
async function undoSuspension({ companyId, site, date, allowDismissed = false }) {
  const { data: log } = await supabase
    .from('site_weather_logs').select('id, suspension_id, suspension_confirmed, suspension_dismissed, threshold_exceeded')
    .eq('site_id', site.id).eq('log_date', date).maybeSingle();
  if (!log) return { status: 404, body: { error: 'LOG_NOT_FOUND' } };
  const wasDismissed = allowDismissed && log.suspension_dismissed && !log.suspension_confirmed;
  if (!log.suspension_confirmed && !wasDismissed) return { status: 409, body: { error: 'NOT_CONFIRMED' } };

  let newEnd = null;
  if (log.suspension_confirmed) {
    // F-202 (AUDIT.md): né la delete né il reset dei flag andavano persi in silenzio.
    const suspensionDelete = log.suspension_id
      ? supabase.from('site_suspension_days').delete().eq('id', log.suspension_id).eq('site_id', site.id).eq('company_id', companyId)
      : supabase.from('site_suspension_days').delete().eq('site_id', site.id).eq('day', date).eq('company_id', companyId);
    const { error: suspDeleteErr } = await suspensionDelete;
    if (suspDeleteErr) return { status: 500, body: { error: 'DB_ERROR', message: suspDeleteErr.message } };
  }

  const { data: logReset, error: logResetErr } = await supabase
    .from('site_weather_logs').update({ suspension_confirmed: false, suspension_dismissed: false, suspension_id: null })
    .eq('id', log.id).select('id');
  if (logResetErr) return { status: 500, body: { error: 'DB_ERROR', message: logResetErr.message } };
  if (!logReset?.length) return { status: 500, body: { error: 'DB_ERROR', message: 'Sospensione rimossa ma il log meteo non è stato azzerato.' } };

  if (log.suspension_confirmed) newEnd = await recalcEndDate(site, companyId, 'weatherUndo');

  if (log.threshold_exceeded) await upsertPendingNotification(companyId, site, await pendingDaysOf(site.id));

  return { status: 200, body: { ok: true, newEndDate: newEnd ?? null } };
}

module.exports = { confirmSuspension, dismissSuspension, undoSuspension, loadSite };
