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
 * GET   /api/v1/economia-controllo/spese-generali              — percentuale spese generali (Blocco 5)
 * PATCH /api/v1/economia-controllo/spese-generali              — aggiorna la percentuale
 * GET   /api/v1/economia-controllo/confronto-cantieri           — margine diretto/netto per ogni cantiere attivo (Blocco 5)
 * GET   /api/v1/sites/:siteId/economia-controllo/overview       — schermata Economia aggregata (Blocco 3)
 * PATCH /api/v1/sites/:siteId/economia-controllo/budget-manuale — budget manuale per cantieri senza CME (Blocco 3)
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
  budgetManualeSchema,
  CATEGORIE_BUDGET,
  patchSpeseGeneraliSchema,
} = require('../../lib/schemas/economiaControllo');

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

router.use(['/sites/:siteId/subcontracts', '/sites/:siteId/economia-controllo', '/economia-controllo'], verifySupabaseJwt);

// Guardia flag: 404 come TIPO_NON_VALIDO in archive.js — il modulo non deve
// essere scopribile da chi non ce l'ha attivo, non solo nascosto in UI.
router.use(['/sites/:siteId/subcontracts', '/sites/:siteId/economia-controllo', '/economia-controllo'], async (req, res, next) => {
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

// ── Spese generali (BLOCCO 5) — percentuale unica, non un riparto algoritmico ──

router.get('/economia-controllo/spese-generali', async (req, res) => {
  const { data, error } = await supabase
    .from('companies').select('percentuale_spese_generali').eq('id', req.companyId).maybeSingle();
  if (error) return sendDbError(res, error);
  res.json({
    percentuale_spese_generali: Number(data?.percentuale_spese_generali ?? 0),
    spiegazione: 'Percentuale del budget di ogni cantiere allocata a copertura delle spese generali aziendali (ufficio, assicurazioni, mezzi, amministrazione) — non calcolata automaticamente, la imposti tu in base a quanto pesano davvero sul fatturato. 0% = nessuna allocazione, il margine netto coincide col margine diretto.',
  });
});

router.patch('/economia-controllo/spese-generali', validate(patchSpeseGeneraliSchema), async (req, res) => {
  const { percentuale_spese_generali } = req.body;
  const { error } = await supabase.from('companies')
    .update({ percentuale_spese_generali }).eq('id', req.companyId);
  if (error) return sendDbError(res, error);
  res.json({ ok: true, percentuale_spese_generali });
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

// ── BLOCCO 3 — Schermata Economia: overview aggregata dal registro unico ────
// Un solo endpoint che legge site_economia_movimenti e restituisce già tutto
// ciò che serve alla gerarchia visiva richiesta (numero grande, barra doppia,
// 4 righe categoria, riga di affidabilità) — nessun calcolo di margine nel
// frontend, stesso principio di calcPnl() in economia.js (v1): un'unica fonte
// di verità lato server.

const CATEGORIE_REGISTRO = ['manodopera', 'materiali', 'subappalti', 'noleggi', 'altro'];

function sommaPerCategoria(righe, tipo) {
  const out = Object.fromEntries(CATEGORIE_REGISTRO.map(c => [c, 0]));
  let totale = 0;
  for (const r of righe) {
    if (r.tipo !== tipo) continue;
    const imp = Number(r.importo) || 0;
    out[r.categoria] = (out[r.categoria] || 0) + imp;
    totale += imp;
  }
  for (const c of CATEGORIE_REGISTRO) out[c] = Math.round(out[c] * 100) / 100;
  return { per_categoria: out, totale: Math.round(totale * 100) / 100 };
}

// Ricalcola il margine "a budget" da un sottoinsieme di righe già filtrato —
// usata sia per il valore attuale sia per il confronto a 30gg (stessa
// funzione, input diverso, mai due formule che possono disallinearsi).
function calcolaMargine(righe, budgetTotale) {
  const budget     = sommaPerCategoria(righe, 'budget');
  const impegnato   = sommaPerCategoria(righe, 'impegnato');
  const consuntivo  = sommaPerCategoria(righe, 'consuntivo');
  const bTot = budgetTotale != null ? budgetTotale : budget.totale;

  // Costo a finire stimato: per i subappalti l'impegnato è il valore
  // contrattuale pieno (mai decrementato dai SAL, vedi migrazione 185) — usare
  // consuntivo+impegnato sommerebbe due volte la stessa spesa. Per le altre
  // categorie non esiste ancora un concetto di "impegnato" (Blocco 1/2):
  // il costo a finire stimato è quanto già consuntivato, cioè un floor
  // conservativo "se nient'altro cresce da qui a fine lavori" — non una
  // proiezione sul ritmo di spesa (quella è il Blocco 6, deliberatamente
  // rimandato). Etichettato come "a budget", mai spacciato per predittivo.
  const costoAFinire =
    consuntivo.per_categoria.manodopera +
    consuntivo.per_categoria.materiali +
    consuntivo.per_categoria.noleggi +
    consuntivo.per_categoria.altro +
    Math.max(impegnato.per_categoria.subappalti, consuntivo.per_categoria.subappalti);

  const margine = bTot > 0 ? Math.round((bTot - costoAFinire) * 100) / 100 : null;
  const margine_percentuale = margine !== null && bTot > 0 ? Math.round((margine / bTot) * 1000) / 10 : null;
  return { margine, margine_percentuale, costo_a_finire: Math.round(costoAFinire * 100) / 100 };
}

router.get('/sites/:siteId/economia-controllo/overview', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // sync_site_mo_consuntivo() è on-demand (migrazione 187), non un trigger —
  // finora veniva richiamata solo dal backfill una tantum o dal PATCH
  // moltiplicatore (che risincronizza tutti i cantieri). Senza questa
  // chiamata, nuove timbrature dopo l'ultimo di quei due eventi non
  // sarebbero mai riflesse nel registro: bug di staleness silenzioso, non
  // dichiarato altrove. Qui, esattamente come previsto dal commento della
  // migrazione 187 ("in futuro dal caricamento della schermata Economia").
  await supabase.rpc('sync_site_mo_consuntivo', { p_site_id: siteId }).then(null, () => {});

  const [siteFullRes, cmeRes, movRes, workersRes, presenceRes, nonAttribuiteRes, companyRes] = await Promise.all([
    supabase.from('sites').select('name, sal_percentuale, status').eq('id', siteId).maybeSingle(),
    supabase.from('site_computo').select('id').eq('site_id', siteId).eq('company_id', companyId).eq('tipo', 'base').limit(1),
    supabase.from('site_economia_movimenti')
      .select('id, tipo, categoria, importo, data_competenza, sorgente, source_table, note, created_at')
      .eq('site_id', siteId).eq('company_id', companyId)
      .order('data_competenza', { ascending: false }),
    supabase.from('workers').select('id, full_name, tariffa_oraria').eq('company_id', companyId),
    supabase.from('presence_logs').select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId).eq('company_id', companyId).order('worker_id').order('timestamp_server'),
    supabase.from('company_expenses').select('id, amount').eq('company_id', companyId).is('site_id', null),
    supabase.from('companies').select('moltiplicatore_costo_manodopera, percentuale_spese_generali').eq('id', companyId).maybeSingle(),
  ]);

  if (movRes.error) return sendDbError(res, movRes.error);

  const righe    = movRes.data || [];
  const hasCme   = (cmeRes.data || []).length > 0;
  const avanzamento_pct = Number(siteFullRes.data?.sal_percentuale) || 0;

  const budget     = sommaPerCategoria(righe, 'budget');
  const impegnato  = sommaPerCategoria(righe, 'impegnato');
  const consuntivo = sommaPerCategoria(righe, 'consuntivo');
  const ricavo     = sommaPerCategoria(righe, 'ricavo');

  // Ripartizione budget: la CME scrive un'unica riga aggregata in 'altro'
  // (nessuno spacchettamento per categoria nel computo metrico) — dichiarato
  // esplicitamente, non nascosto: il previsto per-categoria è "non ripartito"
  // in quel caso, mai un numero indovinato.
  const budgetRipartito = !hasCme && CATEGORIE_BUDGET.some(c => budget.per_categoria[c] > 0);

  const { margine, margine_percentuale, costo_a_finire } = calcolaMargine(righe, budget.totale || null);

  // ── BLOCCO 5 — margine netto dopo spese generali ────────────────────────────
  // Quota = percentuale unica × budget del cantiere (non un riparto di
  // company_recurring_expenses: vedi migrazione 191). Sempre calcolato e
  // mostrato accanto al margine diretto, mai al posto suo — due numeri
  // distinti, mai confusi (vincolo esplicito dell'utente).
  const percentualeSpeseGenerali = Number(companyRes.data?.percentuale_spese_generali ?? 0);
  const quotaSpeseGenerali = budget.totale > 0 ? Math.round(budget.totale * percentualeSpeseGenerali / 100 * 100) / 100 : 0;
  const margineNetto = margine !== null ? Math.round((margine - quotaSpeseGenerali) * 100) / 100 : null;
  const margineNettoPct = margineNetto !== null && budget.totale > 0
    ? Math.round((margineNetto / budget.totale) * 1000) / 10 : null;

  const costo_consumato_pct = budget.totale > 0 ? Math.round((consuntivo.totale / budget.totale) * 1000) / 10 : null;

  // Allarme "stai spendendo più veloce di quanto avanzi" — unica proiezione a
  // ritmo ammessa nel Blocco 3 (vincolata a questa riga d'allarme, per
  // esplicita richiesta utente), stessa formula già in uso in
  // EconomiaTab.tsx (proiezione fine lavori) per coerenza col resto dell'app.
  let allarme_ritmo = null;
  if (budget.totale > 0 && avanzamento_pct > 1 && costo_consumato_pct !== null && costo_consumato_pct > avanzamento_pct) {
    const costoProiettato = consuntivo.totale / (avanzamento_pct / 100);
    const margineARitmo   = Math.round((budget.totale - costoProiettato) * 100) / 100;
    allarme_ritmo = {
      margine_a_ritmo_attuale: margineARitmo,
      messaggio: `Stai spendendo più velocemente di quanto avanzi — al ritmo attuale il margine scende a ${margineARitmo.toLocaleString('it-IT', { maximumFractionDigits: 0 })} €`,
    };
  }

  // Trend 30gg: stesso calcolo del margine, ma solo sulle righe già esistenti
  // 30 giorni fa — un confronto reale su dati storici del registro, non una
  // proiezione. "dati_insufficienti" se il cantiere/registro è più giovane.
  const soglia30gg = new Date(Date.now() - 30 * 86400000).toISOString();
  const righePassate = righe.filter(r => r.created_at < soglia30gg);
  let trend = 'dati_insufficienti';
  if (righePassate.length > 0) {
    const bPassato = sommaPerCategoria(righePassate, 'budget').totale || budget.totale;
    const mPassato = calcolaMargine(righePassate, bPassato || null).margine_percentuale;
    if (mPassato !== null && margine_percentuale !== null) {
      const delta = margine_percentuale - mPassato;
      trend = delta > 1 ? 'migliora' : delta < -1 ? 'peggiora' : 'stabile';
    }
  }

  // Manodopera: ore appaiate ENTRY/EXIT (stessa logica di calcPnl in
  // economia.js) — serve qui solo per la riga di affidabilità (ore totali,
  // lavoratori senza tariffa), il costo vero è già nel registro via
  // sync_site_mo_consuntivo().
  const workerMap = Object.fromEntries((workersRes.data || []).map(w => [w.id, w]));
  const sessions = {};
  for (const log of (presenceRes.data || [])) {
    const s = sessions[log.worker_id] || (sessions[log.worker_id] = { pending: null, hours: 0 });
    if (log.event_type === 'ENTRY') s.pending = new Date(log.timestamp_server).getTime();
    else if (log.event_type === 'EXIT' && s.pending) {
      s.hours += Math.max(0, Math.min((new Date(log.timestamp_server).getTime() - s.pending) / 3600000, 24));
      s.pending = null;
    }
  }
  const moltiplicatore = Number(companyRes.data?.moltiplicatore_costo_manodopera ?? 1.45);
  let oreTotali = 0;
  const lavoratoriSenzaTariffa = [];
  const manodoperaBreakdown = [];
  for (const [wid, s] of Object.entries(sessions)) {
    if (s.hours < 0.01) continue;
    oreTotali += s.hours;
    const w = workerMap[wid];
    if (!w) continue;
    const tariffa = Number(w.tariffa_oraria) || 0;
    if (!tariffa) { lavoratoriSenzaTariffa.push(w.full_name); continue; }
    manodoperaBreakdown.push({
      worker_id: wid, full_name: w.full_name,
      ore: Math.round(s.hours * 100) / 100, tariffa_oraria: tariffa,
      costo: Math.round(s.hours * tariffa * moltiplicatore * 100) / 100,
    });
  }
  manodoperaBreakdown.sort((a, b) => b.ore - a.ore);

  const fattureRighe = righe.filter(r => r.sorgente === 'fattura');
  const ultimaRegistrazione = righe.length
    ? righe.reduce((max, r) => (r.created_at > max ? r.created_at : max), righe[0].created_at)
    : null;
  const nonAttribuite = nonAttribuiteRes.data || [];

  // ── BLOCCO 4 — promemoria "buco di alimentazione" ──────────────────────────
  // Cantiere attivo + timbrature recenti ma nessun costo materiali/noleggi/
  // subappalti/altro registrato da GIORNI_SOGLIA giorni: quasi certamente un
  // buco di alimentazione (nessuno carica le fatture), non un cantiere senza
  // spese davvero. La manodopera è esclusa apposta — si autoalimenta dalle
  // timbrature e non è un segnale di "nessuno sta caricando i costi".
  const GIORNI_SOGLIA = 14;
  const sogliaAlimentazione = new Date(Date.now() - GIORNI_SOGLIA * 86400000);
  const hasTimbratureRecenti = (presenceRes.data || []).some(p => new Date(p.timestamp_server) >= sogliaAlimentazione);
  const ultimoCostoNonMo = righe
    .filter(r => r.tipo === 'consuntivo' && r.categoria !== 'manodopera')
    .reduce((max, r) => (!max || r.data_competenza > max ? r.data_competenza : max), null);
  const giorniSenzaCosti = ultimoCostoNonMo
    ? Math.floor((Date.now() - new Date(ultimoCostoNonMo + 'T00:00:00').getTime()) / 86400000)
    : null;
  const alimentazioneGap = (
    siteFullRes.data?.status === 'attivo' &&
    hasTimbratureRecenti &&
    (giorniSenzaCosti === null || giorniSenzaCosti >= GIORNI_SOGLIA)
  ) ? { giorni_senza_costi: giorniSenzaCosti, soglia_giorni: GIORNI_SOGLIA } : null;

  res.json({
    site: { name: siteFullRes.data?.name || null, avanzamento_pct },
    has_cme: hasCme,
    budget: { ...budget, ripartito: budgetRipartito },
    impegnato,
    consuntivo,
    ricavo,
    righe,
    manodopera_breakdown: manodoperaBreakdown,
    moltiplicatore_costo_manodopera: moltiplicatore,
    margine: { valore: margine, percentuale: margine_percentuale, costo_a_finire, trend },
    spese_generali: {
      percentuale: percentualeSpeseGenerali,
      quota: quotaSpeseGenerali,
      spiegazione: 'Percentuale del budget allocata a copertura di ufficio, assicurazioni, mezzi, amministrazione — impostata una volta dal titolare, non calcolata automaticamente.',
    },
    margine_netto: { valore: margineNetto, percentuale: margineNettoPct },
    costo_consumato_pct,
    allarme_ritmo,
    affidabilita: {
      alimentazione_gap: alimentazioneGap,
      fatture_count: fattureRighe.length,
      ultima_registrazione: ultimaRegistrazione,
      ore_totali: Math.round(oreTotali * 100) / 100,
      lavoratori_senza_tariffa: lavoratoriSenzaTariffa,
      fatture_non_attribuite_company: {
        count: nonAttribuite.length,
        importo: Math.round(nonAttribuite.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100,
      },
    },
  });
});

// ── Budget manuale per cantiere senza computo metrico (Blocco 3) ────────────
// Sola alternativa quando il cantiere non ha un CME: totale + le 4 categorie
// (vincolo esplicito dell'utente — "deve funzionare anche senza computo
// metrico"). Ogni categoria genera/aggiorna una riga 'budget' sorgente
// 'manuale' — stesso registro, nessuna tabella parallela. DELETE+INSERT per
// categoria (stesso pattern dei trigger di sync) per restare idempotente
// senza dipendere dal vincolo UNIQUE (che non si applica alle righe manuali,
// source_table/source_id sono NULL — vedi migrazione 185).
router.patch('/sites/:siteId/economia-controllo/budget-manuale', validate(budgetManualeSchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: cme } = await supabase.from('site_computo').select('id').eq('site_id', siteId).eq('company_id', companyId).eq('tipo', 'base').limit(1);
  if ((cme || []).length > 0) {
    return res.status(409).json({ error: 'CME_PRESENTE', message: 'Questo cantiere ha già un computo metrico — il budget si imposta lì, non manualmente.' });
  }

  for (const categoria of CATEGORIE_BUDGET) {
    if (!(categoria in req.body)) continue;
    const valore = req.body[categoria];
    const { error: delErr } = await supabase.from('site_economia_movimenti')
      .delete().eq('site_id', siteId).eq('company_id', companyId)
      .eq('tipo', 'budget').eq('categoria', categoria).eq('sorgente', 'manuale');
    if (delErr) return sendDbError(res, delErr);
    if (valore != null && valore > 0) {
      const { error: insErr } = await supabase.from('site_economia_movimenti').insert({
        company_id: companyId, site_id: siteId, tipo: 'budget', categoria, importo: valore,
        sorgente: 'manuale', note: 'Budget impostato manualmente', created_by: user.id,
      });
      if (insErr) return sendDbError(res, insErr);
    }
  }

  res.json({ ok: true });
});

// ── Confronto tra cantieri (BLOCCO 5) ────────────────────────────────────────
// Margine diretto e netto per ogni cantiere — per capire quale tipo di lavoro
// rende davvero, non solo quale ha il margine più alto in valore assoluto.
// Include anche i cantieri chiusi (esclude solo 'eliminato'): un cantiere
// concluso ha il quadro costi più affidabile di uno ancora in corso, ed è
// spesso il confronto più utile — verificato dal vivo: filtrare solo
// 'attivo' nascondeva l'unico cantiere reale con un budget da confrontare.
// Una query sola sul registro (filtrata per company, non per cantiere)
// invece di N chiamate all'overview: qui non serve il dettaglio
// per-lavoratore/drill-down, solo i totali.
router.get('/economia-controllo/confronto-cantieri', async (req, res) => {
  const { companyId } = req;

  const [sitesRes, movRes, companyRes] = await Promise.all([
    supabase.from('sites').select('id, name, status').eq('company_id', companyId).neq('status', 'eliminato').order('name'),
    supabase.from('site_economia_movimenti').select('site_id, tipo, categoria, importo').eq('company_id', companyId),
    supabase.from('companies').select('percentuale_spese_generali').eq('id', companyId).maybeSingle(),
  ]);
  if (sitesRes.error) return sendDbError(res, sitesRes.error);
  if (movRes.error) return sendDbError(res, movRes.error);

  const percentualeSpeseGenerali = Number(companyRes.data?.percentuale_spese_generali ?? 0);
  const righePerSite = {};
  for (const r of (movRes.data || [])) {
    (righePerSite[r.site_id] || (righePerSite[r.site_id] = [])).push(r);
  }

  const risultati = (sitesRes.data || []).map(site => {
    const righe = righePerSite[site.id] || [];
    const budget = sommaPerCategoria(righe, 'budget');
    const { margine, margine_percentuale } = calcolaMargine(righe, budget.totale || null);
    const quota = budget.totale > 0 ? Math.round(budget.totale * percentualeSpeseGenerali / 100 * 100) / 100 : 0;
    const margineNetto = margine !== null ? Math.round((margine - quota) * 100) / 100 : null;
    const margineNettoPct = margineNetto !== null && budget.totale > 0
      ? Math.round((margineNetto / budget.totale) * 1000) / 10 : null;
    return {
      site_id: site.id, site_name: site.name, budget_totale: budget.totale,
      margine_diretto: { valore: margine, percentuale: margine_percentuale },
      margine_netto: { valore: margineNetto, percentuale: margineNettoPct },
    };
  }).filter(r => r.budget_totale > 0) // un cantiere senza budget non è confrontabile, non un margine 0% fuorviante
    .sort((a, b) => (b.margine_netto.percentuale ?? -Infinity) - (a.margine_netto.percentuale ?? -Infinity));

  res.json({
    percentuale_spese_generali: percentualeSpeseGenerali,
    cantieri: risultati,
    cantieri_esclusi_senza_budget: (sitesRes.data || []).length - risultati.length,
  });
});

module.exports = router;
