'use strict';
// ── Correzioni dell'orario dalla tabella delle ore (F-435, AUDIT.md del frontend) ──
// L'ufficio clicca un giorno e scrive l'orario giusto (timbrato in ritardo,
// uscita mancante, badge dimenticato). Una riga per lavoratore e giorno in
// ore_correzioni (migr. 273); lib/oreMese.js conta quel giorno da qui con le
// stesse regole delle timbrature. Niente qui scrive o cambia presence_logs.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendDbError } = require('../../lib/httpErrors');
const { contaCorrezione } = require('../../lib/oreMese');
const { festivita, risolviOrario } = require('../../lib/oreContrattuali');

const ASSENZA_INTERA = ['ferie', 'malattia', 'infortunio', 'ingiustificata', 'sospensione', 'altro'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isOra = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const uuid = (x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x);
const oggiRoma = () => new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });

/** Valida il corpo; ritorna { row } oppure { error }. */
function validaCorrezione(b, oggi = oggiRoma()) {
  if (!uuid(b?.worker_id)) return { error: 'worker_id obbligatorio' };
  if (!uuid(b.site_id)) return { error: 'Scegli il cantiere' };
  if (!isDate(b.giorno)) return { error: 'giorno obbligatorio (YYYY-MM-DD)' };
  if (b.giorno > oggi) return { error: 'Si possono correggere solo oggi o i giorni passati' };
  if (!isOra(b.entrata)) return { error: 'Entrata non valida (HH:MM)' };
  if (!isOra(b.uscita)) return { error: 'Uscita non valida (HH:MM)' };
  if (b.entrata === b.uscita) return { error: 'Entrata e uscita non possono essere uguali' };
  const nota = typeof b.nota === 'string' && b.nota.trim() ? b.nota.trim().slice(0, 200) : null;
  const ora = (x) => (isOra(x) ? x : null);
  return { row: { worker_id: b.worker_id, site_id: b.site_id, giorno: b.giorno, entrata: b.entrata, uscita: b.uscita, nota, orig_entrata: ora(b.orig_entrata), orig_uscita: ora(b.orig_uscita) } };
}

function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}

async function proprietari(req, res, row) {
  const [w, s] = await Promise.all([
    supabase.from('workers').select(`id, orario_inizio, orario_fine, pausa_inizio, pausa_fine`).eq('id', row.worker_id).eq('company_id', req.companyId).maybeSingle(),
    supabase.from('sites').select('id, orario_inizio, orario_fine, pausa_inizio, pausa_fine, lunch_break_minutes').eq('id', row.site_id).eq('company_id', req.companyId).maybeSingle(),
  ]);
  if (w.error) { sendDbError(res, w.error); return null; }
  if (s.error) { sendDbError(res, s.error); return null; }
  if (!w.data) { res.status(404).json({ error: 'WORKER_NOT_FOUND' }); return null; }
  if (!s.data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return null; }
  return { worker: w.data, site: s.data };
}

function lavorativoIl(giorno) {
  const dow = new Date(`${giorno}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !festivita(Number(giorno.slice(0, 4)))[giorno];
}

// POST /api/v1/ore/correzioni/anteprima — quante ore conterebbe, senza salvare
router.post('/ore/correzioni/anteprima', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaCorrezione(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const own = await proprietari(req, res, v.row);
  if (!own) return;
  const { data: company, error } = await supabase.from('companies')
    .select('orario_inizio, orario_fine, pausa_inizio, pausa_fine, lunch_break_minutes, orario_tolleranza_min, straord_soglia_min, straord_blocco_min')
    .eq('id', req.companyId).maybeSingle();
  if (error) return sendDbError(res, error);
  const orario = risolviOrario({ company: company || {}, site: own.site, worker: own.worker });
  const lavorativo = lavorativoIl(v.row.giorno);
  // F-478: il pannello manda anche i segni del giorno, così l'anteprima dice le ore vere
  const c = contaCorrezione({ entrata: v.row.entrata, uscita: v.row.uscita, orario, lavorativo, pausaSaltata: req.body.pausa_saltata === true, daEntrata: req.body.da_entrata === true });
  return res.json({ ordinarie: c.ordinarie, straordinario: c.straordinario, ritardo: c.ritardo, uscitoPrima: c.uscitoPrima, festivo: !lavorativo, inizioAnticipato: c.inizioAnticipato || 0 });
});

// POST /api/v1/ore/correzioni { worker_id, site_id, giorno, entrata, uscita, nota?, orig_entrata?, orig_uscita? }
// Una correzione per giorno: se c'è già, la sostituisce (l'orario di prima resta quello delle timbrature).
router.post('/ore/correzioni', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaCorrezione(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { row } = v;
  if (!(await proprietari(req, res, row))) return;
  const { data: abs, error: aErr } = await supabase.from('worker_absences').select('tipo')
    .eq('company_id', req.companyId).eq('worker_id', row.worker_id).eq('stato', 'approvata')
    .lte('date_from', row.giorno).gte('date_to', row.giorno).in('tipo', ASSENZA_INTERA).limit(1);
  if (aErr) return sendDbError(res, aErr);
  if (abs?.length) return res.status(409).json({ error: 'Quel giorno è segnato come assenza: prima togli l\'assenza' });

  const { data: prima, error: pErr } = await supabase.from('ore_correzioni').select('id, orig_entrata, orig_uscita')
    .eq('company_id', req.companyId).eq('worker_id', row.worker_id).eq('giorno', row.giorno).maybeSingle();
  if (pErr) return sendDbError(res, pErr);
  const rec = {
    ...row,
    // Correggere due volte non perde com'era davvero: resta la timbratura vera
    orig_entrata: prima ? prima.orig_entrata : row.orig_entrata,
    orig_uscita: prima ? prima.orig_uscita : row.orig_uscita,
    company_id: req.companyId, created_by: req.user?.id || null, created_by_email: req.user?.email || null,
    updated_at: new Date().toISOString(),
  };
  const q = prima
    ? supabase.from('ore_correzioni').update(rec).eq('id', prima.id).eq('company_id', req.companyId)
    : supabase.from('ore_correzioni').insert(rec);
  const { data, error } = await q.select('id, worker_id, site_id, giorno, entrata, uscita, nota, orig_entrata, orig_uscita, created_at, updated_at').single();
  if (error) return sendDbError(res, error);
  return res.status(prima ? 200 : 201).json(data);
});

// DELETE /api/v1/ore/correzioni/:id — torna alle timbrature
router.delete('/ore/correzioni/:id', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!uuid(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await supabase.from('ore_correzioni').delete()
    .eq('id', req.params.id).eq('company_id', req.companyId).select('id');
  if (error) return sendDbError(res, error);
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json({ ok: true });
});

// ── F-478: «partito prima su richiesta» (ore_inizio_anticipato, migr. 274) ──
// Quel giorno si conta dall'entrata vera. Anche per i giorni passati.
function validaInizioAnticipato(b, oggi = oggiRoma()) {
  if (!uuid(b?.worker_id)) return { error: 'worker_id obbligatorio' };
  if (!isDate(b.giorno)) return { error: 'giorno obbligatorio (YYYY-MM-DD)' };
  if (b.giorno > oggi) return { error: 'Si può segnare solo oggi o un giorno passato' };
  const nota = typeof b.nota === 'string' && b.nota.trim() ? b.nota.trim().slice(0, 200) : null;
  return { row: { worker_id: b.worker_id, giorno: b.giorno, nota } };
}

// POST /api/v1/ore/inizio-anticipato { worker_id, giorno, nota? }
router.post('/ore/inizio-anticipato', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaInizioAnticipato(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { data: w, error: wErr } = await supabase.from('workers').select('id').eq('id', v.row.worker_id).eq('company_id', req.companyId).maybeSingle();
  if (wErr) return sendDbError(res, wErr);
  if (!w) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  const { data, error } = await supabase.from('ore_inizio_anticipato')
    .upsert({ ...v.row, company_id: req.companyId, created_by: req.user?.id || null, created_by_email: req.user?.email || null }, { onConflict: 'company_id,worker_id,giorno' })
    .select('id, worker_id, giorno, nota').single();
  if (error) return sendDbError(res, error);
  return res.json(data);
});

// DELETE /api/v1/ore/inizio-anticipato { worker_id, giorno } — torna a contare dall'inizio dell'orario
router.delete('/ore/inizio-anticipato', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  const v = validaInizioAnticipato(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { error } = await supabase.from('ore_inizio_anticipato').delete()
    .eq('company_id', req.companyId).eq('worker_id', v.row.worker_id).eq('giorno', v.row.giorno);
  if (error) return sendDbError(res, error);
  return res.json({ ok: true });
});

module.exports = { router, validaCorrezione, validaInizioAnticipato };
