'use strict';
/**
 * routes/v1/siteHeat.js
 *
 * Registro caldo cantiere — richiesta esplicita del titolare (2026-09-17),
 * base normativa D.L. 107/2026 art. 6 + messaggio INPS 2418/2026 (vedi
 * migrations/218 per i dettagli, incluso perché NON è il "bollino rosso"
 * del Ministero della Salute).
 *
 * F-210 (AUDIT.md, 2026-09-17): la prima versione calcolava un WBGT stimato
 * da dati ARPAL. Il titolare ha corretto: Worklimate (INAIL-CNR) è la fonte
 * che le ordinanze citano esplicitamente per il "bollino rosso" — più
 * autorevole legalmente della nostra stima. Worklimate però non ha API
 * pubblica: solo un archivio storico con login (archivio.worklimate.it),
 * max 5 ricerche/mese, finestra max 4 mesi (verificato via web il
 * 2026-09-17). Quindi qui non c'è più un cron automatico: un utente
 * consulta l'archivio Worklimate e REGISTRA quei giorni esatti — mai un
 * calcolo interno, mai un'invenzione. Vedi migrations/219.
 *
 * Stesso identico pattern di conferma/dismiss/undo di routes/v1/
 * siteWeather.js (site_suspension_days condiviso — un giorno di caldo
 * confermato estende sites.end_date esattamente come un giorno di pioggia).
 */
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { calcEndDate }       = require('../../lib/calcEndDate');
const { generateHeatReportHtml, generateHeatReportXlsx } = require('../../services/heatReport');
const { rendererPool }      = require('../../pdf-renderer');

const RISK_LEVELS = ['verde', 'giallo', 'arancione', 'rosso'];

async function getSiteOrFail(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id, company_id, name, address, client, start_date, end_date, contract_days, days_type, comune')
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' }); return null; }
  return data;
}

const LOG_COLS = 'id, log_date, risk_level, comune, source_note, entered_by, entered_at, suspension_confirmed, suspension_dismissed, suspension_id';

// Aggiorna/rimuove la notifica "giorni da confermare" — stesso pattern di
// upsertHeatNotification che viveva nel cron ora rimosso (services/
// heatArpalCron.js), qui invocato dopo un inserimento manuale invece che
// dopo un fetch automatico.
async function syncPendingNotification(companyId, siteId, siteName) {
  const { data: pending } = await supabase.from('site_heat_logs')
    .select('log_date').eq('site_id', siteId)
    .eq('risk_level', 'rosso').eq('suspension_confirmed', false).eq('suspension_dismissed', false);
  const pendingDays = (pending || []).map(r => r.log_date);

  if (pendingDays.length === 0) {
    await supabase.from('notifications').delete()
      .eq('company_id', companyId).eq('entity_type', 'site').eq('entity_id', siteId).eq('type', 'heat_suspension');
    return;
  }
  const sorted = [...pendingDays].sort();
  const listIt = sorted.map(d => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }));
  const title = `Caldo — ${pendingDays.length} ${pendingDays.length === 1 ? 'giornata bollino rosso da confermare' : 'giornate bollino rosso da confermare'}`;
  const body  = `${siteName}\n${listIt.join(' · ')}\nVai al cantiere → Caldo per confermare o ignorare.`;
  await supabase.from('notifications').upsert({
    company_id: companyId, type: 'heat_suspension', severity: 'warning', title, body,
    entity_type: 'site', entity_id: siteId, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id,type' });
}

// ── GET /api/v1/sites/:siteId/heat-log ─────────────────────────────────────────
router.get('/sites/:siteId/heat-log', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data, error } = await supabase.from('site_heat_logs').select(LOG_COLS)
    .eq('site_id', siteId).order('log_date', { ascending: false }).limit(1100);
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  res.json({ logs: data || [] });
});

// ── POST /api/v1/sites/:siteId/heat-log/batch ─────────────────────────────────
// Registra i giorni letti a mano dall'archivio Worklimate — mai un fetch
// automatico. Un utente in genere trascrive qui il risultato di UNA ricerca
// sul portale (max 5/mese), quindi accetta più giorni in una chiamata sola.
router.post('/sites/:siteId/heat-log/batch', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { comune, source_note, entries } = req.body || {};
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'NO_ENTRIES', message: 'Nessun giorno da registrare.' });
  }
  if (!comune || typeof comune !== 'string' || !comune.trim()) {
    return res.status(400).json({ error: 'NO_COMUNE', message: 'Indica il comune usato per la ricerca su Worklimate.' });
  }
  for (const e of entries) {
    if (!e || typeof e.log_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.log_date)) {
      return res.status(400).json({ error: 'INVALID_DATE', message: `Data non valida: ${e?.log_date}` });
    }
    if (!RISK_LEVELS.includes(e.risk_level)) {
      return res.status(400).json({ error: 'INVALID_RISK_LEVEL', message: `Livello non valido per ${e.log_date}: ${e?.risk_level}` });
    }
  }

  const nowIso = new Date().toISOString();
  const rows = entries.map(e => ({
    company_id: req.companyId, site_id: siteId, log_date: e.log_date, risk_level: e.risk_level,
    comune: comune.trim(), source_note: source_note || null,
    entered_by: req.user?.id ?? null, entered_at: nowIso,
  }));

  const { data: upserted, error } = await supabase.from('site_heat_logs')
    .upsert(rows, { onConflict: 'site_id,log_date' }).select('log_date, risk_level');
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  await syncPendingNotification(req.companyId, siteId, site.name || 'Cantiere');

  res.json({
    imported: upserted?.length || 0,
    red_flag_days: (upserted || []).filter(r => r.risk_level === 'rosso').length,
  });
});

// ── DELETE /api/v1/sites/:siteId/heat-log/:date ───────────────────────────────
// Correzione di un errore di trascrizione — inserimento manuale, capita.
// Non tocca site_suspension_days: se il giorno era già confermato va prima
// annullato (undo), questa route rifiuta la cancellazione altrimenti per
// non lasciare una sospensione orfana senza il log che la giustifica.
router.delete('/sites/:siteId/heat-log/:date', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: log } = await supabase.from('site_heat_logs')
    .select('id, suspension_confirmed').eq('site_id', siteId).eq('log_date', date).maybeSingle();
  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });
  if (log.suspension_confirmed) return res.status(409).json({ error: 'CONFIRMED', message: 'Annulla prima la sospensione confermata.' });

  const { error } = await supabase.from('site_heat_logs').delete().eq('id', log.id);
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  await syncPendingNotification(req.companyId, siteId, site.name || 'Cantiere');
  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/confirm ─────────────────────────
router.post('/sites/:siteId/heat-log/:date/confirm', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const { notes } = req.body || {};
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: log } = await supabase.from('site_heat_logs')
    .select('id, risk_level, comune, source_note').eq('site_id', siteId).eq('log_date', date).maybeSingle();
  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  const autoNotes = [
    `Bollino rosso Worklimate${log.comune ? ` — ${log.comune}` : ''}`,
    log.source_note ? `(${log.source_note})` : null,
    notes ? `— ${notes}` : null,
    '| Fonte: archivio.worklimate.it',
  ].filter(Boolean).join(' ');

  const { data: suspension, error: suspErr } = await supabase.from('site_suspension_days')
    .upsert({ company_id: req.companyId, site_id: siteId, day: date, reason: 'caldo', notes: autoNotes, created_by: req.user?.id ?? null },
      { onConflict: 'site_id,day' }).select('id').single();
  if (suspErr) return res.status(500).json({ error: 'DB_ERROR', message: suspErr.message });

  const { data: logUpdated, error: logUpdateErr } = await supabase.from('site_heat_logs')
    .update({ suspension_confirmed: true, suspension_id: suspension.id }).eq('id', log.id).select('id');
  if (logUpdateErr) return res.status(500).json({ error: 'DB_ERROR', message: logUpdateErr.message });
  if (!logUpdated?.length) return res.status(500).json({ error: 'DB_ERROR', message: 'Sospensione creata ma il log caldo non è stato aggiornato.' });

  const { data: suspRows } = await supabase.from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows || []).map(r => r.day), site.comune ?? null);
  if (newEnd) {
    const { error: endDateErr } = await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);
    if (endDateErr) console.error(`[heatConfirm] ${siteId}: end_date non aggiornata:`, endDateErr.message);
  }

  await syncPendingNotification(req.companyId, siteId, site.name || 'Cantiere');
  res.json({ ok: true, suspension, newEndDate: newEnd ?? null });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/dismiss ─────────────────────────
router.post('/sites/:siteId/heat-log/:date/dismiss', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: updated, error: updateErr } = await supabase.from('site_heat_logs')
    .update({ suspension_dismissed: true }).eq('site_id', siteId).eq('log_date', date).select('id');
  if (updateErr) return res.status(500).json({ error: 'DB_ERROR', message: updateErr.message });
  if (!updated?.length) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  await syncPendingNotification(req.companyId, siteId, site.name || 'Cantiere');
  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/undo ────────────────────────────
router.post('/sites/:siteId/heat-log/:date/undo', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: log } = await supabase.from('site_heat_logs')
    .select('id, suspension_id, suspension_confirmed').eq('site_id', siteId).eq('log_date', date).maybeSingle();
  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });
  if (!log.suspension_confirmed) return res.status(409).json({ error: 'NOT_CONFIRMED' });

  const suspensionDelete = log.suspension_id
    ? supabase.from('site_suspension_days').delete().eq('id', log.suspension_id).eq('site_id', siteId).eq('company_id', req.companyId)
    : supabase.from('site_suspension_days').delete().eq('site_id', siteId).eq('day', date).eq('company_id', req.companyId);
  const { error: suspDeleteErr } = await suspensionDelete;
  if (suspDeleteErr) return res.status(500).json({ error: 'DB_ERROR', message: suspDeleteErr.message });

  const { data: logReset, error: logResetErr } = await supabase.from('site_heat_logs')
    .update({ suspension_confirmed: false, suspension_dismissed: false, suspension_id: null }).eq('id', log.id).select('id');
  if (logResetErr) return res.status(500).json({ error: 'DB_ERROR', message: logResetErr.message });
  if (!logReset?.length) return res.status(500).json({ error: 'DB_ERROR', message: 'Sospensione rimossa ma il log caldo non è stato azzerato.' });

  const { data: suspRows } = await supabase.from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows || []).map(r => r.day), site.comune ?? null);
  if (newEnd) {
    const { error: endDateErr } = await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);
    if (endDateErr) console.error(`[heatUndo] ${siteId}: end_date non aggiornata:`, endDateErr.message);
  }

  await syncPendingNotification(req.companyId, siteId, site.name || 'Cantiere');
  res.json({ ok: true, newEndDate: newEnd ?? null });
});

// ── GET /api/v1/sites/:siteId/heat-report.pdf ──────────────────────────────────
router.get('/sites/:siteId/heat-report.pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase.from('site_heat_logs').select(LOG_COLS).eq('site_id', siteId).order('log_date', { ascending: true });
  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('risk_level', 'rosso');
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);
  const { data: logs } = await q;

  try {
    const html = generateHeatReportHtml({ site, rows: logs || [], from, to, filter });
    const pdfBuf = await rendererPool.render(html, {
      docTitle: `Relazione Tecnica Caldo — ${site.name}`, rev: 1,
      footerLeft: 'D.L. 107/2026 art. 6 · msg. INPS 2418/2026',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="caldo_${siteId}_${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[heat-report.pdf]', err.message);
    res.status(500).json({ error: 'PDF_ERROR', message: err.message });
  }
});

// ── GET /api/v1/sites/:siteId/heat-report.xlsx ─────────────────────────────────
router.get('/sites/:siteId/heat-report.xlsx', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase.from('site_heat_logs').select(LOG_COLS).eq('site_id', siteId).order('log_date', { ascending: true });
  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('risk_level', 'rosso');
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);
  const { data: logs } = await q;

  const wb = generateHeatReportXlsx({ site, rows: logs || [], from, to, filter });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="caldo_${siteId}_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
