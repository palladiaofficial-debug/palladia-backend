'use strict';
/**
 * routes/v1/economiaControllo.js
 * Modulo Controllo Economico (AUDIT.md F-119) — BLOCCO 2.
 *
 * Espone il registro unico site_economia_movimenti (migrazioni 185-190) e le
 * due leve nuove del blocco: il moltiplicatore costo-azienda della
 * manodopera e i contratti di subappalto (impegnato/consuntivo). Nuovo file
 * — non tocca routes/v1/chat.js (congelato) né routes/v1/economia.js
 * (il P&L "v1" esistente resta invariato finché il Blocco 3 non lo sostituisce).
 *
 * Tutto dietro il feature flag `economia_controllo_v1` — 404 per chi non
 * ce l'ha attivo, stesso pattern di archive.js per gli scaglioni documentali.
 *
 * GET   /api/v1/economia-controllo/moltiplicatore              — moltiplicatore costo-azienda dell'azienda
 * PATCH /api/v1/economia-controllo/moltiplicatore              — aggiorna il moltiplicatore
 * GET   /api/v1/sites/:siteId/subcontracts                     — elenco contratti subappalto del cantiere
 * POST  /api/v1/sites/:siteId/subcontracts                     — crea contratto (stato default 'emesso' → riga impegnato automatica)
 * PATCH /api/v1/sites/:siteId/subcontracts/:id                 — modifica contratto
 * DELETE /api/v1/sites/:siteId/subcontracts/:id                — elimina contratto
 * POST  /api/v1/sites/:siteId/subcontracts/:id/sal              — registra un SAL del subappaltatore (→ consuntivo)
 * DELETE /api/v1/sites/:siteId/subcontracts/:id/sal/:salId      — elimina un SAL
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { sendDbError } = require('../../lib/httpErrors');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const {
  patchMoltiplicatoreSchema,
  createSubcontractSchema,
  patchSubcontractSchema,
  createSubcontractSalSchema,
} = require('../../lib/schemas/economiaControllo');

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

router.use(['/sites/:siteId/subcontracts', '/economia-controllo'], verifySupabaseJwt);

// Guardia flag: 404 come TIPO_NON_VALIDO in archive.js — il modulo non deve
// essere scopribile da chi non ce l'ha attivo, non solo nascosto in UI.
router.use(['/sites/:siteId/subcontracts', '/economia-controllo'], async (req, res, next) => {
  const enabled = await isFeatureEnabled(req.companyId, 'economia_controllo_v1');
  if (!enabled) return res.status(404).json({ error: 'NOT_FOUND' });
  next();
});

async function resolveSite(siteId, companyId) {
  if (!isUuid(siteId)) return null;
  const { data } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
  return data;
}

// ── Moltiplicatore costo-azienda ─────────────────────────────────────────────

router.get('/economia-controllo/moltiplicatore', async (req, res) => {
  const { data, error } = await supabase
    .from('companies').select('moltiplicatore_costo_manodopera').eq('id', req.companyId).maybeSingle();
  if (error) return sendDbError(res, error);
  res.json({
    moltiplicatore_costo_manodopera: Number(data?.moltiplicatore_costo_manodopera ?? 1.45),
    spiegazione: 'Applicato alla tariffa oraria nuda per stimare il costo aziendale reale della manodopera: contributi INPS/INAIL a carico datore, TFR, ferie e permessi maturati, malattia, tredicesima. Default 1,45 — tipico per il CCNL edile.',
  });
});

router.patch('/economia-controllo/moltiplicatore', validate(patchMoltiplicatoreSchema), async (req, res) => {
  const { moltiplicatore_costo_manodopera } = req.body;
  const { error } = await supabase.from('companies')
    .update({ moltiplicatore_costo_manodopera }).eq('id', req.companyId);
  if (error) return sendDbError(res, error);

  // Riallinea subito le righe manodopera già in registro con il nuovo
  // moltiplicatore, per tutti i cantieri della company — altrimenti il
  // numero mostrato resterebbe stantio fino alla prossima sync casuale.
  const { data: sites } = await supabase.from('sites').select('id').eq('company_id', req.companyId).neq('status', 'eliminato');
  for (const s of (sites || [])) {
    await supabase.rpc('sync_site_mo_consuntivo', { p_site_id: s.id }).then(null, () => {});
  }

  res.json({ ok: true, moltiplicatore_costo_manodopera });
});

// ── Contratti di subappalto ──────────────────────────────────────────────────

router.get('/sites/:siteId/subcontracts', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: contracts, error } = await supabase
    .from('site_subcontracts')
    .select('*, subcontractor:subcontractors(id, company_name)')
    .eq('site_id', siteId).eq('company_id', companyId)
    .order('data_emissione', { ascending: false });
  if (error) return sendDbError(res, error);

  const ids = (contracts || []).map(c => c.id);
  const { data: sal } = ids.length
    ? await supabase.from('site_subcontract_sal').select('*').in('subcontract_id', ids).order('data', { ascending: false })
    : { data: [] };

  const result = (contracts || []).map(c => {
    const salRows      = (sal || []).filter(s => s.subcontract_id === c.id);
    const consuntivato  = salRows.reduce((s, x) => s + Number(x.importo), 0);
    return {
      ...c,
      sal: salRows,
      residuo_impegnato: c.stato === 'annullato' ? 0 : Math.round((Number(c.importo_pattuito) - consuntivato) * 100) / 100,
      consuntivato,
    };
  });

  res.json({ subcontracts: result });
});

router.post('/sites/:siteId/subcontracts', validate(createSubcontractSchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { subcontractor_id, descrizione, importo_pattuito, data_emissione, stato, note } = req.body;

  if (subcontractor_id) {
    const { data: sub } = await supabase.from('subcontractors').select('id').eq('id', subcontractor_id).eq('company_id', companyId).maybeSingle();
    if (!sub) return res.status(400).json({ error: 'subcontractor_id non valido per questa azienda' });
  }

  const { data: row, error } = await supabase.from('site_subcontracts').insert({
    company_id: companyId, site_id: siteId, subcontractor_id: subcontractor_id || null,
    descrizione, importo_pattuito, data_emissione: data_emissione || new Date().toISOString().slice(0, 10),
    stato: stato || 'emesso', note: note || null, created_by: user.id,
  }).select().single();
  if (error) return sendDbError(res, error);

  res.status(201).json(row);
});

router.patch('/sites/:siteId/subcontracts/:id', validate(patchSubcontractSchema), async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const patch = {};
  const { subcontractor_id, descrizione, importo_pattuito, data_emissione, stato, note } = req.body;
  if (subcontractor_id !== undefined) patch.subcontractor_id = subcontractor_id;
  if (descrizione      !== undefined) patch.descrizione      = descrizione;
  if (importo_pattuito !== undefined) patch.importo_pattuito = importo_pattuito;
  if (data_emissione   !== undefined) patch.data_emissione   = data_emissione;
  if (stato             !== undefined) patch.stato             = stato;
  if (note              !== undefined) patch.note              = note;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  const { error } = await supabase.from('site_subcontracts').update(patch)
    .eq('id', id).eq('site_id', siteId).eq('company_id', companyId);
  if (error) return sendDbError(res, error);
  res.json({ ok: true });
});

router.delete('/sites/:siteId/subcontracts/:id', async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase.from('site_subcontracts').delete()
    .eq('id', id).eq('site_id', siteId).eq('company_id', companyId);
  if (error) return sendDbError(res, error);
  res.json({ ok: true });
});

// ── SAL del subappaltatore (converte impegnato in consuntivo) ───────────────

router.post('/sites/:siteId/subcontracts/:id/sal', validate(createSubcontractSalSchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId, id }      = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: contract } = await supabase.from('site_subcontracts').select('id').eq('id', id).eq('site_id', siteId).eq('company_id', companyId).maybeSingle();
  if (!contract) return res.status(404).json({ error: 'SUBCONTRACT_NOT_FOUND' });

  const { importo, data, note } = req.body;
  const { data: row, error } = await supabase.from('site_subcontract_sal').insert({
    subcontract_id: id, company_id: companyId, site_id: siteId,
    importo, data: data || new Date().toISOString().slice(0, 10), note: note || null, created_by: user.id,
  }).select().single();
  if (error) return sendDbError(res, error);
  res.status(201).json(row);
});

router.delete('/sites/:siteId/subcontracts/:id/sal/:salId', async (req, res) => {
  const { companyId } = req;
  const { siteId, id, salId } = req.params;
  if (!isUuid(id) || !isUuid(salId)) return res.status(400).json({ error: 'id non valido' });
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase.from('site_subcontract_sal').delete()
    .eq('id', salId).eq('subcontract_id', id).eq('site_id', siteId).eq('company_id', companyId);
  if (error) return sendDbError(res, error);
  res.json({ ok: true });
});

module.exports = router;
