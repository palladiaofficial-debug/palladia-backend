'use strict';
/**
 * routes/v1/badgeDdt.js
 *
 * F-213 (AUDIT.md, 2026-09-18): caricamento DDT per i trasportatori interni
 * — richiesto dal titolare per avere "sotto controllo tutti i DDT" da
 * confrontare poi con le fatture. Stessa identità badge già usata per la
 * timbratura (routes/v1/badgePunch.js) — nessuna nuova autenticazione da
 * far funzionare. Stessa lettura AI già in uso per fatture/ricevute cantiere
 * (lib/siteCostOcr.js, condivisa con routes/v1/siteCosts.js) — nessuna nuova
 * logica di estrazione. I record finiscono nella stessa tabella site_costs
 * già usata per i costi cantiere, `tipo='ddt'`, `created_by='badge:<id>'`
 * per distinguerli da un inserimento manuale via app.
 *
 * A differenza di una fattura, un DDT tipicamente non riporta un importo
 * (le merci arrivano prima del prezzo) — `importo` resta NULL qui, mai un
 * valore inventato per soddisfare un vincolo pensato per le fatture.
 *
 * POST /api/v1/badge/:code/ddt/scan     — carica la foto, la fa leggere dall'AI, ritorna i campi (non salva)
 * POST /api/v1/badge/:code/ddt/confirm  — salva il DDT con i campi (eventualmente corretti dal trasportatore)
 */

const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { resolveWorkerByBadge } = require('../../lib/workerByBadge');
const { badgePunchLimiter, aiLimiter } = require('../../middleware/rateLimit');
const { extractSiteCostFromDocument, TIPI } = require('../../lib/siteCostOcr');

const BUCKET   = 'site-media';
const MAX_SIZE = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Usa una foto o un PDF.'));
  },
});

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function resolveActiveWorker(code, res) {
  const worker = await resolveWorkerByBadge(code);
  if (!worker) { res.status(401).json({ error: 'BADGE_NOT_FOUND' }); return null; }
  if (!worker.is_active) { res.status(403).json({ error: 'BADGE_REVOKED' }); return null; }
  return worker;
}

// Prefisso storage per un DDT il cui cantiere non esiste ancora in Palladia —
// il trasportatore scrive il nome a mano (`cantiere_libero`), il titolare lo
// riassegna al cantiere vero dalla scheda Spese (bottone matita, già esistente
// per qualunque spesa senza site_id) appena lo crea.
const UNASSIGNED_PREFIX_SEGMENT = 'ddt-non-assegnati';

// Stesso confine di sicurezza di requireSiteOwnership (siteCosts.js), qui
// contro company_id del lavoratore invece che req.companyId da JWT — il
// badge non porta una sessione, solo l'identità del lavoratore.
async function requireSiteInCompany(siteId, companyId, res) {
  if (!isUuid(siteId)) { res.status(400).json({ error: 'INVALID_SITE_ID' }); return null; }
  const { data } = await supabase.from('sites').select('id, name')
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return null; }
  return data;
}

// ── POST /api/v1/badge/:code/ddt/scan ─────────────────────────────────────────
router.post('/badge/:code/ddt/scan', badgePunchLimiter, aiLimiter,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const worker = await resolveActiveWorker(req.params.code, res);
    if (!worker) return;

    // Cantiere non ancora censito in Palladia: nessun site_id, il trasportatore
    // scrive il nome a mano (`cantiere_libero`) — il DDT finisce comunque
    // caricato, solo su un percorso storage diverso (nessun site.id da usare).
    let site = null;
    if (req.body.site_id) {
      site = await requireSiteInCompany(req.body.site_id, worker.company_id, res);
      if (!site) return;
    } else if (!req.body.cantiere_libero || !String(req.body.cantiere_libero).trim()) {
      return res.status(400).json({ error: 'SITE_OR_CANTIERE_LIBERO_REQUIRED' });
    }
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const ext = path.extname(req.file.originalname || '') || '.jpg';
    const pathSegment = site ? site.id : UNASSIGNED_PREFIX_SEGMENT;
    const file_url = `${worker.company_id}/${pathSegment}/ddt/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET).upload(file_url, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) return res.status(500).json({ error: 'UPLOAD_FAILED', message: uploadErr.message });

    // Mai bloccante: se l'AI fallisce (rete, formato illeggibile) il
    // trasportatore conferma comunque a mano — la foto è già salvata, non
    // deve restare bloccato sul posto per un errore di lettura.
    let fields = {};
    try {
      fields = await extractSiteCostFromDocument(req.file.buffer, req.file.mimetype, {
        companyId: worker.company_id, userId: null, callSite: 'badge_ddt_scan',
      });
    } catch (err) {
      console.error('[badge-ddt/scan] AI error (non bloccante):', err.message);
    }

    res.json({ file_url, fields: { ...fields, tipo: TIPI.includes(fields.tipo) ? fields.tipo : 'ddt' } });
  }
);

// ── POST /api/v1/badge/:code/ddt/confirm ──────────────────────────────────────
router.post('/badge/:code/ddt/confirm', badgePunchLimiter, async (req, res) => {
  const worker = await resolveActiveWorker(req.params.code, res);
  if (!worker) return;

  const { site_id, cantiere_libero, file_url, descrizione, fornitore, numero_documento, data_documento, tipo } = req.body || {};

  const FILENAME_RE = /^\d+-[0-9a-f]{8}\.[a-zA-Z0-9]{1,10}$/;

  if (site_id) {
    const site = await requireSiteInCompany(site_id, worker.company_id, res);
    if (!site) return;

    // Il file deve essere ESATTAMENTE quello caricato da /scan per QUESTO
    // lavoratore/cantiere — non solo un percorso che INIZIA col prefisso
    // giusto. F-213 (AUDIT.md): un test di regressione ha trovato che
    // startsWith() da solo passava un payload con "../../../" dopo il
    // prefisso (stessa stringa iniziale, path diverso) — corretto validando
    // ANCHE che il resto del percorso, dopo il prefisso, abbia esattamente la
    // forma generata da /scan (regex fissa, nessuna interpolazione — evita
    // anche il problema di costruire una RegExp da valori non letterali).
    // Verifica in più che il file esista DAVVERO nello storage, non solo che
    // il nome abbia la forma giusta.
    const expectedPrefix = `${worker.company_id}/${site.id}/ddt/`;
    const remainder = typeof file_url === 'string' && file_url.startsWith(expectedPrefix)
      ? file_url.slice(expectedPrefix.length) : null;
    if (!remainder || !FILENAME_RE.test(remainder)) {
      return res.status(400).json({ error: 'INVALID_FILE_URL' });
    }
    const { data: existsCheck, error: existsErr } = await supabase.storage
      .from(BUCKET).list(`${worker.company_id}/${site.id}/ddt`, { search: remainder });
    if (existsErr || !existsCheck?.some(f => f.name === remainder)) {
      return res.status(400).json({ error: 'INVALID_FILE_URL', message: 'Il file indicato non esiste.' });
    }

    const { data, error } = await supabase.from('site_costs').insert({
      company_id:       worker.company_id,
      site_id:          site.id,
      descrizione:      (descrizione || '').trim() || 'DDT',
      fornitore:        fornitore?.trim() || null,
      numero_documento: numero_documento?.trim() || null,
      data_documento:   data_documento || null,
      tipo:             TIPI.includes(tipo) ? tipo : 'ddt',
      importo:          null, // F-213: un DDT non ha quasi mai un importo — mai un valore inventato qui
      file_url,
      created_by:       `badge:${worker.id}`,
    }).select().single();

    if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { count } = await supabase.from('site_costs').select('id', { count: 'exact', head: true })
      .eq('created_by', `badge:${worker.id}`).eq('tipo', 'ddt').gte('created_at', todayStart.toISOString());

    return res.status(201).json({ ...data, today_count: count ?? 1 });
  }

  // Cantiere non ancora censito in Palladia (F-214, AUDIT.md): niente site_id
  // da validare — il DDT finisce in company_expenses (spesa generale, come
  // qualunque altra spesa "da assegnare"), con il nome scritto a mano dal
  // trasportatore in `notes`. Il titolare la riassegna al cantiere vero dalla
  // scheda Spese (bottone matita, già esistente per qualunque spesa senza
  // site_id) appena lo crea in piattaforma — nessun dato perso.
  if (!cantiere_libero || !String(cantiere_libero).trim()) {
    return res.status(400).json({ error: 'SITE_OR_CANTIERE_LIBERO_REQUIRED' });
  }
  const expectedPrefix = `${worker.company_id}/${UNASSIGNED_PREFIX_SEGMENT}/ddt/`;
  const remainder = typeof file_url === 'string' && file_url.startsWith(expectedPrefix)
    ? file_url.slice(expectedPrefix.length) : null;
  if (!remainder || !FILENAME_RE.test(remainder)) {
    return res.status(400).json({ error: 'INVALID_FILE_URL' });
  }
  const { data: existsCheck, error: existsErr } = await supabase.storage
    .from(BUCKET).list(`${worker.company_id}/${UNASSIGNED_PREFIX_SEGMENT}/ddt`, { search: remainder });
  if (existsErr || !existsCheck?.some(f => f.name === remainder)) {
    return res.status(400).json({ error: 'INVALID_FILE_URL', message: 'Il file indicato non esiste.' });
  }

  const cantiereName = String(cantiere_libero).trim().slice(0, 200);
  const { data, error } = await supabase.from('company_expenses').insert({
    company_id:    worker.company_id,
    site_id:       null,
    amount:        null, // stesso motivo di site_costs.importo (F-213): un DDT quasi mai ha un prezzo
    description:   (descrizione || '').trim() || 'DDT',
    category:      'materiali',
    payment_method: 'altro',
    supplier:      fornitore?.trim() || null,
    invoice_number: numero_documento?.trim() || null,
    // expense_date è NOT NULL su company_expenses (a differenza di
    // site_costs.data_documento) — un null esplicito violerebbe il vincolo
    // anche se la colonna ha un DEFAULT, perché il default si applica solo
    // quando la chiave è assente dall'INSERT, non quando vale null.
    expense_date:  data_documento || new Date().toISOString().slice(0, 10),
    receipt_url:   file_url,
    source:        'badge_ddt',
    notes:         `DDT caricato da trasportatore (badge worker:${worker.id}) — cantiere non ancora censito: "${cantiereName}". Riassegna il cantiere reale dalla scheda Spese (matita) appena lo crei.`,
  }).select().single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { count } = await supabase.from('company_expenses').select('id', { count: 'exact', head: true })
    .eq('source', 'badge_ddt').eq('company_id', worker.company_id).gte('created_at', todayStart.toISOString());

  res.status(201).json({ ...data, today_count: count ?? 1 });
});

module.exports = router;
