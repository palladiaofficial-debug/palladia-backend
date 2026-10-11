'use strict';
// ── Ore e assenze (F-265, AUDIT.md del frontend) ────────────────────────────
// Ufficio: riepilogo del mese, ferie/permessi/malattia, approvazione delle
// richieste dei lavoratori, foglio per il consulente. Solo titolare e
// amministratori (come la chiusura giornata, F-147). Nessuna rotta qui
// scrive presence_logs: le timbrature restano quelle che sono.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendDbError } = require('../../lib/httpErrors');
const { buildOreMese } = require('../../lib/oreMese');
const { generateFoglioHtml, generateFoglioXlsx, meseLabel } = require('../../lib/oreMeseFoglio');
const { rendererPool } = require('../../pdf-renderer');

const TIPI = ['ferie', 'permesso', 'malattia', 'infortunio', 'ingiustificata', 'altro'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const thisMonth = () => new Date().toISOString().slice(0, 7);

function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}

/** Valida un'assenza; ritorna { row } oppure { error }. */
function validaAssenza(b) {
  if (!TIPI.includes(b?.tipo)) return { error: `tipo deve essere uno tra: ${TIPI.join(', ')}` };
  if (!isDate(b.dal)) return { error: 'dal obbligatorio (YYYY-MM-DD)' };
  const al = b.al || b.dal;
  if (!isDate(al) || al < b.dal) return { error: 'al deve essere una data uguale o successiva a dal' };
  let dalle = null, alle = null;
  if (b.tipo === 'permesso' && (b.dalle || b.alle)) {
    if (!isTime(b.dalle) || !isTime(b.alle) || b.alle <= b.dalle) return { error: 'per un permesso a ore servono dalle e alle (HH:MM), con alle dopo dalle' };
    if (al !== b.dal) return { error: 'un permesso a ore è in un solo giorno' };
    dalle = b.dalle; alle = b.alle;
  }
  const s = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return { row: { tipo: b.tipo, date_from: b.dal, date_to: al, ora_dalle: dalle, ora_alle: alle, protocollo: b.tipo === 'malattia' ? s(b.protocollo, 60) : null, note: s(b.note, 500) } };
}

// GET /api/v1/ore/mese?month=YYYY-MM
router.get('/ore/mese', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  try {
    res.json(await buildOreMese(req.companyId, req.query.month || thisMonth()));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[ore/mese]', e.message);
    return res.status(500).json({ error: 'DATA_ERROR' });
  }
});

// POST /api/v1/assenze { worker_id, tipo, dal, al?, dalle?, alle?, protocollo?, note? } — registrata dall'ufficio
router.post('/assenze', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaAssenza(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { data: w } = await supabase.from('workers').select('id').eq('id', req.body.worker_id).eq('company_id', req.companyId).maybeSingle();
  if (!w) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  const { data, error } = await supabase.from('worker_absences').insert({
    ...v.row, company_id: req.companyId, worker_id: w.id, stato: 'approvata', da_lavoratore: false,
    created_by: req.user?.id || null, decided_by: req.user?.id || null, decided_at: new Date().toISOString(),
  }).select().single();
  if (error) return sendDbError(res, error);
  res.status(201).json(data);
});

// PATCH /api/v1/assenze/:id { stato: 'approvata' | 'rifiutata' } — risposta a una richiesta del lavoratore
router.patch('/assenze/:id', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const stato = req.body?.stato;
  if (!['approvata', 'rifiutata'].includes(stato)) return res.status(400).json({ error: 'stato deve essere approvata o rifiutata' });
  const { data: cur } = await supabase.from('worker_absences').select('id, stato').eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
  if (!cur) return res.status(404).json({ error: 'NOT_FOUND' });
  if (cur.stato !== 'richiesta') return res.status(409).json({ error: 'ALREADY_DECIDED', stato: cur.stato });
  const { data, error } = await supabase.from('worker_absences')
    .update({ stato, decided_by: req.user?.id || null, decided_at: new Date().toISOString() })
    .eq('id', cur.id).eq('company_id', req.companyId).eq('stato', 'richiesta').select().single();
  if (error) return sendDbError(res, error);
  res.json(data);
});

// DELETE /api/v1/assenze/:id — cancella un'assenza registrata per errore
router.delete('/assenze/:id', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const { data, error } = await supabase.from('worker_absences').delete().eq('id', req.params.id).eq('company_id', req.companyId).select('id');
  if (error) return sendDbError(res, error);
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ── Risposte alle domande del mese (F-335) ──────────────────────────────────
// Orario di lavoro, orario personale, "prima di Palladia", giorni da
// giustificare. Nessuna di queste rotte tocca le timbrature: cambiano solo
// le regole con cui si contano (lib/oreContrattuali.js).
const hm = (s) => (isTime(s) ? `${s}:00` : null);
const minOf = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// PATCH /api/v1/ore/orario { inizio, fine, pausaDa, pausaA, tolleranza?, straordSoglia?, straordBlocco? }
router.patch('/ore/orario', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const b = req.body || {};
  if (![b.inizio, b.fine, b.pausaDa, b.pausaA].every(isTime)) return res.status(400).json({ error: 'inizio, fine, pausaDa, pausaA obbligatori (HH:MM)' });
  if (minOf(b.fine) <= minOf(b.inizio)) return res.status(400).json({ error: 'la fine deve essere dopo l\'inizio' });
  if (minOf(b.pausaA) <= minOf(b.pausaDa) || minOf(b.pausaDa) < minOf(b.inizio) || minOf(b.pausaA) > minOf(b.fine)) return res.status(400).json({ error: 'la pausa deve stare dentro l\'orario' });
  const intero = (v, lo, hi) => (v === undefined ? undefined : Number.isInteger(v) && v >= lo && v <= hi ? v : NaN);
  const tol = intero(b.tolleranza, 0, 30), soglia = intero(b.straordSoglia, 0, 120), blocco = intero(b.straordBlocco, 1, 60);
  if ([tol, soglia, blocco].some(Number.isNaN)) return res.status(400).json({ error: 'tolleranza 0–30, straordSoglia 0–120, straordBlocco 1–60 (minuti)' });
  const patch = { orario_inizio: hm(b.inizio), orario_fine: hm(b.fine), pausa_inizio: hm(b.pausaDa), pausa_fine: hm(b.pausaA), orario_confermato_at: new Date().toISOString() };
  if (tol !== undefined) patch.orario_tolleranza_min = tol;
  if (soglia !== undefined) patch.straord_soglia_min = soglia;
  if (blocco !== undefined) patch.straord_blocco_min = blocco;
  const { error } = await supabase.from('companies').update(patch).eq('id', req.companyId);
  if (error) return sendDbError(res, error);
  res.json({ ok: true });
});

// PATCH /api/v1/ore/lavoratori/:id/orario { inizio, fine, pausaDa?, pausaA? } | { rifiuta: true } | { azzera: true }
router.patch('/ore/lavoratori/:id/orario', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const b = req.body || {};
  let patch;
  if (b.rifiuta === true) patch = { orario_personale_rifiutato: true, orario_inizio: null, orario_fine: null, pausa_inizio: null, pausa_fine: null };
  else if (b.azzera === true) patch = { orario_personale_rifiutato: false, orario_inizio: null, orario_fine: null, pausa_inizio: null, pausa_fine: null };
  else {
    if (!isTime(b.inizio) || !isTime(b.fine) || minOf(b.fine) <= minOf(b.inizio)) return res.status(400).json({ error: 'inizio e fine obbligatori (HH:MM), fine dopo inizio' });
    if ((b.pausaDa || b.pausaA) && (!isTime(b.pausaDa) || !isTime(b.pausaA) || minOf(b.pausaA) <= minOf(b.pausaDa))) return res.status(400).json({ error: 'pausa non valida' });
    patch = { orario_inizio: hm(b.inizio), orario_fine: hm(b.fine), pausa_inizio: b.pausaDa ? hm(b.pausaDa) : null, pausa_fine: b.pausaA ? hm(b.pausaA) : null, orario_personale_rifiutato: false };
  }
  const { data, error } = await supabase.from('workers').update(patch).eq('id', req.params.id).eq('company_id', req.companyId).select('id');
  if (error) return sendDbError(res, error);
  if (!data?.length) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  res.json({ ok: true });
});

// POST /api/v1/ore/prima { lavoratori: [{ id, dal }], motivo: 'assunto' | 'carta' }
// "Ha iniziato a timbrare con Palladia il …": prima di quel giorno non era in
// forza, o timbrava su carta. Quei giorni non sono "da giustificare".
router.post('/ore/prima', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const { lavoratori, motivo } = req.body || {};
  if (!['assunto', 'carta'].includes(motivo)) return res.status(400).json({ error: 'motivo deve essere assunto o carta' });
  if (!Array.isArray(lavoratori) || !lavoratori.length || lavoratori.length > 200 || !lavoratori.every(l => typeof l?.id === 'string' && isDate(l.dal))) {
    return res.status(400).json({ error: 'lavoratori: [{ id, dal: YYYY-MM-DD }] (da 1 a 200)' });
  }
  for (const l of lavoratori) {
    const { error } = await supabase.from('workers').update({ ore_da: l.dal, ore_da_motivo: motivo }).eq('id', l.id).eq('company_id', req.companyId);
    if (error) return sendDbError(res, error);
  }
  res.json({ ok: true });
});

// POST /api/v1/assenze/giorni { worker_id, tipo, giorni: ['YYYY-MM-DD', …], note? }
// Giorni senza timbrature giustificati in un tocco (anche non consecutivi).
const TIPI_GIORNO = ['ferie', 'permesso', 'malattia', 'infortunio', 'ingiustificata', 'altro'];
router.post('/assenze/giorni', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const { worker_id: workerId, tipo, giorni, note } = req.body || {};
  if (!TIPI_GIORNO.includes(tipo)) return res.status(400).json({ error: `tipo deve essere uno tra: ${TIPI_GIORNO.join(', ')}` });
  if (!Array.isArray(giorni) || !giorni.length || giorni.length > 31 || !giorni.every(isDate)) return res.status(400).json({ error: 'giorni: da 1 a 31 date YYYY-MM-DD' });
  const { data: w } = await supabase.from('workers').select('id').eq('id', workerId).eq('company_id', req.companyId).maybeSingle();
  if (!w) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  // Giorni consecutivi → un'assenza sola
  const sorted = [...new Set(giorni)].sort();
  const periodi = [];
  for (const g of sorted) {
    const last = periodi[periodi.length - 1];
    const next = last && new Date(Date.parse(`${last.al}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);
    if (last && next === g) last.al = g; else periodi.push({ dal: g, al: g });
  }
  const rows = periodi.map(p => ({
    company_id: req.companyId, worker_id: w.id, tipo, date_from: p.dal, date_to: p.al, stato: 'approvata', da_lavoratore: false,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null,
    created_by: req.user?.id || null, decided_by: req.user?.id || null, decided_at: new Date().toISOString(),
  }));
  const { data, error } = await supabase.from('worker_absences').insert(rows).select('id');
  if (error) return sendDbError(res, error);
  res.status(201).json({ ok: true, ids: (data || []).map(x => x.id) });
});

async function companyName(companyId) {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || '';
}

// GET /api/v1/ore/mese/foglio.pdf?month=YYYY-MM — per il consulente del lavoro
router.get('/ore/mese/foglio.pdf', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  let data;
  try { data = await buildOreMese(req.companyId, req.query.month || thisMonth()); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'DATA_ERROR' });
  }
  try {
    const pdf = await rendererPool.render(generateFoglioHtml(data, await companyName(req.companyId)), { docTitle: `Presenze ${meseLabel(data.month)}`, rev: 1 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="presenze-${data.month}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (e) {
    console.error('[ore/mese/foglio.pdf]', e.message);
    res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }
});

// GET /api/v1/ore/mese/foglio.xlsx?month=YYYY-MM
router.get('/ore/mese/foglio.xlsx', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  let data;
  try { data = await buildOreMese(req.companyId, req.query.month || thisMonth()); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'DATA_ERROR' });
  }
  const buf = await generateFoglioXlsx(data, await companyName(req.companyId));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="presenze-${data.month}.xlsx"`);
  res.send(Buffer.from(buf));
});

module.exports = { router, validaAssenza };
