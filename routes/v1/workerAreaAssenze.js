'use strict';
// ── Richiesta ferie/permesso dall'Area lavoratore (F-265, AUDIT.md del frontend)
// L'operaio, entrato col PIN (stesso token WorkerArea delle buste paga), chiede
// ferie o un permesso: la richiesta va in worker_absences con stato
// 'richiesta' e da_lavoratore = true. Il titolare la approva o la rifiuta da
// Persone → Ore e assenze (routes/v1/oreAssenze.js). Nessuna rotta qui tocca
// presence_logs: le timbrature restano quelle che sono.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../../lib/supabase');
const { verifyWorkerArea } = require('../../lib/workerAuth');
const { validaAssenza } = require('./oreAssenze');

const areaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

const TIPI_LAVORATORE = ['ferie', 'permesso']; // la malattia ha la sua rotta: workerAreaMalattia.js (F-318)
const MAX_GIORNI = 60;
const MAX_IN_ATTESA = 10;
const COLS = 'id, tipo, date_from, date_to, ora_dalle, ora_alle, note, protocollo, stato, decided_at, created_at';
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

async function lavoratoreAttivo(wid, cid) {
  const { data } = await supabase.from('workers').select('id').eq('id', wid).eq('company_id', cid).eq('is_active', true).maybeSingle();
  return !!data;
}

// GET /api/v1/area/:code/assenze — le mie richieste (ultimi 90 giorni e future)
router.get('/area/:code/assenze', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;
  const da = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('worker_absences').select(COLS)
    .eq('company_id', cid).eq('worker_id', wid).gte('date_to', da)
    .order('date_from', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// POST /api/v1/area/:code/assenze { tipo: ferie|permesso, dal, al?, dalle?, alle?, note? }
router.post('/area/:code/assenze', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;
  if (!TIPI_LAVORATORE.includes(req.body?.tipo)) return res.status(400).json({ error: 'INVALID_TIPO', message: 'Puoi chiedere ferie o un permesso.' });
  const v = validaAssenza({ ...req.body, protocollo: null });
  if (v.error) return res.status(400).json({ error: 'INVALID_INPUT', message: v.error });
  if (v.row.date_from < oggiRoma()) return res.status(400).json({ error: 'PAST_DATE', message: 'Non puoi chiedere un giorno già passato.' });
  const giorni = (Date.parse(v.row.date_to) - Date.parse(v.row.date_from)) / 86400000 + 1;
  if (giorni > MAX_GIORNI) return res.status(400).json({ error: 'TOO_LONG', message: `Al massimo ${MAX_GIORNI} giorni per richiesta.` });
  if (!(await lavoratoreAttivo(wid, cid))) return res.status(403).json({ error: 'WORKER_INACTIVE' });

  const { count } = await supabase.from('worker_absences').select('id', { count: 'exact', head: true })
    .eq('company_id', cid).eq('worker_id', wid).eq('stato', 'richiesta');
  if ((count || 0) >= MAX_IN_ATTESA) return res.status(429).json({ error: 'TOO_MANY_PENDING', message: 'Hai già troppe richieste in attesa.' });

  const { data, error } = await supabase.from('worker_absences')
    .insert({ ...v.row, company_id: cid, worker_id: wid, stato: 'richiesta', da_lavoratore: true, created_by: null })
    .select(COLS).single();
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(201).json(data);
});

// DELETE /api/v1/area/:code/assenze/:id — ritiro una mia richiesta ancora in attesa
router.delete('/area/:code/assenze/:id', areaLimiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await supabase.from('worker_absences').delete()
    .eq('id', req.params.id).eq('company_id', cid).eq('worker_id', wid).eq('stato', 'richiesta')
    .select('id');
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'Richiesta non trovata o già decisa.' });
  res.json({ ok: true });
});

module.exports = router;
