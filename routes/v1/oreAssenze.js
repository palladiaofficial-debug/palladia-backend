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

const TIPI = ['ferie', 'permesso', 'malattia', 'altro'];
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
