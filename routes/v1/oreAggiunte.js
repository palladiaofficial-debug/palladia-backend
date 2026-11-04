'use strict';
// ── Ore in più aggiunte dall'ufficio (F-432, AUDIT.md del frontend) ─────────
// Il titolare segna ore di straordinario che il badge non ha visto, anche per
// i giorni passati. Stanno in ore_aggiunte (migr. 272) e lib/oreMese.js le
// somma allo straordinario del giorno. Niente qui scrive presence_logs.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendDbError } = require('../../lib/httpErrors');

// Giornate intere di assenza: lì non si aggiungono ore in più
const ASSENZA_INTERA = ['ferie', 'malattia', 'infortunio', 'ingiustificata', 'sospensione', 'altro'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const oggiRoma = () => new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });

/** Valida il corpo; ritorna { row } oppure { error }. */
function validaOreAggiunte(b, oggi = oggiRoma()) {
  const uuid = (x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x);
  if (!uuid(b?.worker_id)) return { error: 'worker_id obbligatorio' };
  if (b.site_id != null && b.site_id !== '' && !uuid(b.site_id)) return { error: 'site_id non valido' };
  if (!isDate(b.giorno)) return { error: 'giorno obbligatorio (YYYY-MM-DD)' };
  if (b.giorno > oggi) return { error: 'Si possono aggiungere ore solo per oggi o i giorni passati' };
  const minuti = Number(b.minuti);
  if (!Number.isInteger(minuti) || minuti <= 0) return { error: 'minuti deve essere un numero intero maggiore di zero' };
  if (minuti > 960) return { error: 'Al massimo 16 ore in più in un giorno' };
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null;
  return { row: { worker_id: b.worker_id, giorno: b.giorno, minuti, note, site_id: b.site_id || null } };
}

function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}

// POST /api/v1/ore/aggiunte { worker_id, giorno, minuti, note?, site_id? }
router.post('/ore/aggiunte', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaOreAggiunte(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { row } = v;

  const { data: w, error: wErr } = await supabase.from('workers').select('id').eq('id', row.worker_id).eq('company_id', req.companyId).maybeSingle();
  if (wErr) return sendDbError(res, wErr);
  if (!w) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  if (row.site_id) {
    const { data: s, error: sErr } = await supabase.from('sites').select('id').eq('id', row.site_id).eq('company_id', req.companyId).maybeSingle();
    if (sErr) return sendDbError(res, sErr);
    if (!s) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  }
  const { data: abs, error: aErr } = await supabase.from('worker_absences').select('tipo')
    .eq('company_id', req.companyId).eq('worker_id', row.worker_id).eq('stato', 'approvata')
    .lte('date_from', row.giorno).gte('date_to', row.giorno).in('tipo', ASSENZA_INTERA).limit(1);
  if (aErr) return sendDbError(res, aErr);
  if (abs?.length) return res.status(409).json({ error: 'Quel giorno è segnato come assenza: prima cancella l\'assenza' });

  const { data, error } = await supabase.from('ore_aggiunte')
    .insert({ ...row, company_id: req.companyId, created_by: req.user?.id || null })
    .select('id, worker_id, site_id, giorno, minuti, note, created_at').single();
  if (error) return sendDbError(res, error);
  return res.status(201).json(data);
});

// DELETE /api/v1/ore/aggiunte/:id
router.delete('/ore/aggiunte/:id', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await supabase.from('ore_aggiunte').delete()
    .eq('id', req.params.id).eq('company_id', req.companyId).select('id');
  if (error) return sendDbError(res, error);
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json({ ok: true });
});

module.exports = { router, validaOreAggiunte };
