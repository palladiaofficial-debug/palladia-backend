'use strict';
const crypto  = require('crypto');
const router  = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }                    = require('../../middleware/verifyJwt');
const { validate }                             = require('../../middleware/validate');
const { createWorkerSchema, patchWorkerSchema } = require('../../lib/schemas/worker');
const { auditLog }          = require('../../lib/audit');
const { complianceStatus }  = require('../../lib/compliance');

// ── Helpers ───────────────────────────────────────────────────────────────────

// CF italiano: 16 char alfanumerici (uppercase)
function isValidFiscalCode(cf) {
  return typeof cf === 'string' && /^[A-Z0-9]{16}$/i.test(cf.trim());
}

function parseFullName(fullName) {
  const trimmed  = String(fullName).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const firstName = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
  const lastName  = spaceIdx > -1 ? trimmed.slice(spaceIdx + 1).trim() || null : null;
  return { first_name: firstName, last_name: lastName, full_name: trimmed };
}

// Genera codice badge univoco: 9 byte → 18 char hex uppercase
// Spazio 2^72 — praticamente non enumerabile
function generateBadgeCode() {
  return crypto.randomBytes(9).toString('hex').toUpperCase();
}

// Campi badge opzionali accettati in POST e PATCH
const BADGE_FIELDS = [
  'photo_url',
  'hire_date',
  'birth_date',
  'qualification',
  'role',
  'employer_name',
  'subcontracting_auth',
  'safety_training_expiry',
  'health_fitness_expiry',
  'birth_place',
];

// Validazione date YYYY-MM-DD (o null/undefined per cancellare)
function isValidDate(val) {
  if (val === null || val === undefined || val === '') return true; // accettato come "cancella"
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

// Colonne restituite nelle query GET
const WORKER_SELECT =
  'id, full_name, fiscal_code, is_active, created_at, badge_code, ' +
  'photo_url, hire_date, birth_date, qualification, role, employer_name, ' +
  'subcontracting_auth, safety_training_expiry, health_fitness_expiry, birth_place, ' +
  'tariffa_oraria';

// ── POST /api/v1/workers — crea lavoratore (PRIVATO) ─────────────────────────
router.post('/workers', verifySupabaseJwt, validate(createWorkerSchema), async (req, res) => {
  const {
    full_name, fiscal_code,
    photo_url, hire_date, birth_date, qualification, role,
    employer_name, subcontracting_auth,
    safety_training_expiry, health_fitness_expiry,
    tariffa_oraria,
  } = req.body;

  if (!full_name || String(full_name).trim().length < 2) {
    return res.status(400).json({ error: 'full_name obbligatorio (min 2 caratteri)' });
  }
  if (String(full_name).trim().length > 200) {
    return res.status(400).json({ error: 'full_name troppo lungo (max 200 caratteri)' });
  }
  if (!fiscal_code) {
    return res.status(400).json({ error: 'fiscal_code obbligatorio' });
  }
  if (!isValidFiscalCode(fiscal_code)) {
    return res.status(400).json({ error: 'INVALID_FISCAL_CODE' });
  }
  for (const f of ['hire_date', 'birth_date', 'safety_training_expiry', 'health_fitness_expiry']) {
    if (req.body[f] !== undefined && !isValidDate(req.body[f])) {
      return res.status(400).json({ error: `${f} deve essere YYYY-MM-DD` });
    }
  }

  const nameParts  = parseFullName(full_name);
  const badge_code = generateBadgeCode();

  const record = {
    company_id:  req.companyId,
    full_name:   nameParts.full_name,
    fiscal_code: fiscal_code.toUpperCase().trim(),
    badge_code,
  };

  // Aggiungi campi badge opzionali se presenti
  if (photo_url              !== undefined) record.photo_url              = photo_url              || null;
  if (hire_date              !== undefined) record.hire_date              = hire_date              || null;
  if (birth_date             !== undefined) record.birth_date             = birth_date             || null;
  if (qualification          !== undefined) record.qualification          = qualification          ? String(qualification).trim() : null;
  if (role                   !== undefined) record.role                   = role                   ? String(role).trim()          : null;
  if (employer_name          !== undefined) record.employer_name          = employer_name          ? String(employer_name).trim() : null;
  if (subcontracting_auth    !== undefined) record.subcontracting_auth    = Boolean(subcontracting_auth);
  if (safety_training_expiry !== undefined) record.safety_training_expiry = safety_training_expiry || null;
  if (health_fitness_expiry  !== undefined) record.health_fitness_expiry  = health_fitness_expiry  || null;
  if (tariffa_oraria         !== undefined) {
    const t = parseFloat(tariffa_oraria);
    if (!isNaN(t) && t >= 0) record.tariffa_oraria = t;
  }

  const { data, error } = await supabase
    .from('workers')
    .insert([record])
    .select(WORKER_SELECT)
    .single();

  // Duplicate fiscal_code nella stessa company
  if (error?.code === '23505' && error.message.includes('fiscal')) {
    return res.status(409).json({ error: 'WORKER_ALREADY_EXISTS' });
  }
  // Duplicate badge_code (collisione crittografica — probabilità trascurabile, ma gestiamo)
  if (error?.code === '23505' && error.message.includes('badge_code')) {
    // Retry automatico con un nuovo codice
    record.badge_code = generateBadgeCode();
    const retry = await supabase.from('workers').insert([record]).select(WORKER_SELECT).single();
    if (retry.error) return res.status(400).json({ error: retry.error.message });
    auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
      action: 'worker.create', targetType: 'worker', targetId: retry.data.id,
      payload: { full_name: retry.data.full_name, fiscal_code: retry.data.fiscal_code }, req });
    return res.status(201).json(retry.data);
  }
  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.create',
    targetType: 'worker',
    targetId:   data.id,
    payload:    { full_name: data.full_name, fiscal_code: data.fiscal_code, badge_code: data.badge_code },
    req,
  });

  res.status(201).json(data);
});

// ── GET /api/v1/workers?siteId= — lista lavoratori (PRIVATO) ─────────────────
// Con siteId: solo i lavoratori associati a quel cantiere (stessa company).
// Senza siteId: tutti i lavoratori attivi dell'azienda.
router.get('/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.query;

  if (siteId) {
    const { data, error } = await supabase
      .from('worksite_workers')
      .select(`
        id, status, start_date, end_date,
        worker:workers (${WORKER_SELECT})
      `)
      .eq('site_id', siteId)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase
    .from('workers')
    .select(WORKER_SELECT)
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/v1/workers/:workerId — dettaglio singolo lavoratore (PRIVATO) ────
router.get('/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  const { data, error } = await supabase
    .from('workers')
    .select(WORKER_SELECT)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  res.json(data);
});

// ── POST /api/v1/sites/:siteId/workers — autorizza lavoratore su cantiere ─────
router.post('/sites/:siteId/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { worker_id, start_date, end_date } = req.body;

  if (!worker_id) return res.status(400).json({ error: 'worker_id obbligatorio' });

  // Verifica che il worker appartenga alla company dell'utente autenticato
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id')
    .eq('id', worker_id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (wErr || !worker) {
    return res.status(403).json({ error: 'Worker non trovato o non appartiene alla tua azienda' });
  }

  // Verifica se l'assegnazione esiste già (upsert manuale — più robusto di onConflict)
  const { data: existing } = await supabase
    .from('worksite_workers')
    .select('id')
    .eq('site_id', siteId)
    .eq('worker_id', worker_id)
    .maybeSingle();

  if (existing) {
    // Riattiva se era stato rimosso
    const { error: updErr } = await supabase
      .from('worksite_workers')
      .update({ status: 'active', start_date: start_date || null, end_date: end_date || null })
      .eq('site_id', siteId)
      .eq('worker_id', worker_id)
      .eq('company_id', req.companyId);
    if (updErr) {
      console.error('[workers] update worksite_workers error:', updErr.message, updErr.code);
      return res.status(400).json({ error: updErr.message });
    }
  } else {
    const { error: insErr } = await supabase
      .from('worksite_workers')
      .insert([{
        company_id: req.companyId,
        site_id:    siteId,
        worker_id,
        status:     'active',
        start_date: start_date || null,
        end_date:   end_date   || null,
      }]);
    if (insErr) {
      console.error('[workers] insert worksite_workers error:', insErr.message, insErr.code);
      return res.status(400).json({ error: insErr.message });
    }
  }

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.assign_site',
    targetType: 'worker',
    targetId:   worker_id,
    payload:    { site_id: siteId, start_date, end_date },
    req,
  });

  res.status(201).json({ ok: true, worker_id, site_id: siteId });
});

// ── DELETE /api/v1/sites/:siteId/workers/:workerId — rimuovi lavoratore ───────
router.delete('/sites/:siteId/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { siteId, workerId } = req.params;

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr || !site) {
    return res.status(403).json({ error: 'Cantiere non trovato o non appartiene alla tua azienda' });
  }

  const { error } = await supabase
    .from('worksite_workers')
    .delete()
    .eq('site_id', siteId)
    .eq('worker_id', workerId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.remove_from_site',
    targetType: 'worker',
    targetId:   workerId,
    payload:    { site_id: siteId },
    req,
  });

  res.status(204).end();
});

// ── POST /api/v1/sites/:siteId/workers/bulk — assegnazione massiva ───────────
// body: { worker_ids: string[], action: 'add' | 'remove' }
router.post('/sites/:siteId/workers/bulk', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { worker_ids, action = 'add' } = req.body || {};

  if (!Array.isArray(worker_ids) || worker_ids.length === 0) {
    return res.status(400).json({ error: 'worker_ids deve essere un array non vuoto' });
  }
  if (worker_ids.length > 200) {
    return res.status(400).json({ error: 'Massimo 200 lavoratori per operazione' });
  }
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'action deve essere "add" o "remove"' });
  }

  // Verifica che il cantiere appartenga alla company
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(403).json({ error: 'Cantiere non trovato o non autorizzato' });

  // Verifica che tutti i worker_ids appartengano alla company
  const { data: validWorkers, error: wErr } = await supabase
    .from('workers')
    .select('id')
    .eq('company_id', req.companyId)
    .in('id', worker_ids);

  if (wErr) return res.status(500).json({ error: 'DB_ERROR' });

  const validIds = new Set((validWorkers || []).map(w => w.id));
  const invalidIds = worker_ids.filter(id => !validIds.has(id));
  if (invalidIds.length > 0) {
    return res.status(400).json({ error: 'INVALID_WORKER_IDS', invalid: invalidIds });
  }

  let added = 0, removed = 0, skipped = 0;

  if (action === 'add') {
    // Fetch assegnazioni esistenti per questo cantiere
    const { data: existing } = await supabase
      .from('worksite_workers')
      .select('worker_id, status')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId)
      .in('worker_id', worker_ids);

    const existingMap = new Map((existing || []).map(e => [e.worker_id, e]));

    const toInsert = [];
    const toReactivate = [];

    for (const wid of worker_ids) {
      const ex = existingMap.get(wid);
      if (!ex) {
        toInsert.push({ company_id: req.companyId, site_id: siteId, worker_id: wid, status: 'active' });
      } else if (ex.status !== 'active') {
        toReactivate.push(wid);
      } else {
        skipped++;
      }
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('worksite_workers').insert(toInsert);
      if (insErr) return res.status(500).json({ error: 'DB_ERROR', message: insErr.message });
      added += toInsert.length;
    }

    for (const wid of toReactivate) {
      const { error: updErr } = await supabase
        .from('worksite_workers')
        .update({ status: 'active' })
        .eq('site_id', siteId)
        .eq('worker_id', wid)
        .eq('company_id', req.companyId);
      if (!updErr) added++;
    }
  } else {
    const { error: delErr, count } = await supabase
      .from('worksite_workers')
      .delete({ count: 'exact' })
      .eq('site_id', siteId)
      .eq('company_id', req.companyId)
      .in('worker_id', worker_ids);

    if (delErr) return res.status(500).json({ error: 'DB_ERROR', message: delErr.message });
    removed = count ?? worker_ids.length;
  }

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     `worker.bulk_${action}`,
    targetType: 'site',
    targetId:   siteId,
    payload:    { worker_ids, added, removed, skipped },
    req,
  });

  res.json({ ok: true, action, added, removed, skipped });
});

// ── PATCH /api/v1/workers/:workerId — aggiorna lavoratore ────────────────────
router.patch('/workers/:workerId', verifySupabaseJwt, validate(patchWorkerSchema), async (req, res) => {
  const { workerId } = req.params;

  const ALLOWED = [
    'full_name', 'is_active', 'tariffa_oraria',
    ...BADGE_FIELDS,
  ];

  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS' });
  }

  // Validazione campi data
  for (const f of ['hire_date', 'birth_date', 'safety_training_expiry', 'health_fitness_expiry']) {
    if (updates[f] !== undefined && !isValidDate(updates[f])) {
      return res.status(400).json({ error: `${f} deve essere YYYY-MM-DD o null` });
    }
    // Converti stringa vuota in null
    if (updates[f] === '') updates[f] = null;
  }

  // Validazione tariffa oraria
  if (updates.tariffa_oraria !== undefined) {
    const t = parseFloat(updates.tariffa_oraria);
    if (isNaN(t) || t < 0) return res.status(400).json({ error: 'tariffa_oraria deve essere >= 0' });
    updates.tariffa_oraria = t;
  }

  // Normalizza stringhe testuali
  for (const f of ['qualification', 'role', 'employer_name', 'birth_place']) {
    if (updates[f] !== undefined) {
      updates[f] = updates[f] ? String(updates[f]).trim() : null;
    }
  }

  const { data, error } = await supabase
    .from('workers')
    .update(updates)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .select(WORKER_SELECT)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.update',
    targetType: 'worker',
    targetId:   workerId,
    payload:    updates,
    req,
  });

  res.json(data);
});

// ── GET /api/v1/workers/export — XLSX organico aziendale ─────────────────────
router.get('/workers/export', verifySupabaseJwt, async (req, res) => {
  const ExcelJS = require('exceljs');

  const includeInactive = req.query.all === 'true';
  let query = supabase
    .from('workers')
    .select(`${WORKER_SELECT}, subcontractor_id, subcontractors(company_name)`)
    .eq('company_id', req.companyId)
    .order('full_name', { ascending: true });

  if (!includeInactive) query = query.eq('is_active', true);

  const { data: workers, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  function overallCompliance(w) {
    const s = [complianceStatus(w.safety_training_expiry), complianceStatus(w.health_fitness_expiry)];
    if (s.includes('expired'))  return { label: 'Non conforme', bg: 'FFDC2626', fg: 'FFFFFFFF' };
    if (s.includes('expiring')) return { label: 'In scadenza',  bg: 'FFF59E0B', fg: 'FF000000' };
    if (s.every(x => x === 'ok')) return { label: 'Conforme',    bg: 'FF16A34A', fg: 'FFFFFFFF' };
    return { label: 'Incompleto', bg: 'FF6B7280', fg: 'FFFFFFFF' };
  }

  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = String(d).slice(0, 10).split('-');
    return `${day}/${m}/${y}`;
  }

  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();

  const sh = wb.addWorksheet('Organico');
  sh.columns = [
    { header: 'Nome',               key: 'name',       width: 28 },
    { header: 'Codice Fiscale',     key: 'cf',         width: 18 },
    { header: 'Data di Nascita',    key: 'birth',      width: 14 },
    { header: 'Luogo di Nascita',   key: 'birthplace', width: 20 },
    { header: 'Data Assunzione',    key: 'hire',       width: 14 },
    { header: 'Qualifica',          key: 'qual',       width: 22 },
    { header: 'Ruolo',              key: 'role',       width: 16 },
    { header: 'Datore di Lavoro',   key: 'employer',   width: 22 },
    { header: 'Subappaltatore',     key: 'sub',        width: 22 },
    { header: 'Form. scadenza',     key: 'form',       width: 14 },
    { header: 'Idoneità scadenza',  key: 'idon',       width: 14 },
    { header: 'Stato',              key: 'stato',      width: 16 },
  ];

  // Stile header
  const hRow = sh.getRow(1);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF334E7C' } } };
  });

  // Freeze header + filtro automatico
  sh.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  sh.autoFilter = { from: 'A1', to: 'L1' };

  for (const w of (workers || [])) {
    const compliance = overallCompliance(w);
    const row = sh.addRow({
      name:       w.full_name,
      cf:         w.fiscal_code,
      birth:      fmtDate(w.birth_date),
      birthplace: w.birth_place    || '',
      hire:       fmtDate(w.hire_date),
      qual:       w.qualification  || '',
      role:       w.role           || '',
      employer:   w.employer_name  || '',
      sub:        w.subcontractors?.company_name || '',
      form:       fmtDate(w.safety_training_expiry),
      idon:       fmtDate(w.health_fitness_expiry),
      stato:      compliance.label,
    });

    row.height = 20;
    row.getCell('stato').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: compliance.bg } };
    row.getCell('stato').font = { bold: true, color: { argb: compliance.fg }, name: 'Calibri', size: 10 };
    row.getCell('stato').alignment = { horizontal: 'center', vertical: 'middle' };

    // Colora in giallo/rosso le date di scadenza se problematiche
    const formSt = complianceStatus(w.safety_training_expiry);
    if (formSt === 'expired')  row.getCell('form').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } };
    if (formSt === 'expiring') row.getCell('form').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    const idonSt = complianceStatus(w.health_fitness_expiry);
    if (idonSt === 'expired')  row.getCell('idon').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } };
    if (idonSt === 'expiring') row.getCell('idon').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };

    // Zebra stripes sulle righe pari
    const rowIdx = row.number;
    if (rowIdx % 2 === 0) {
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum !== 12) { // skip stato (ha già colore)
          if (!cell.fill || cell.fill.type !== 'pattern' || cell.fill.fgColor?.argb === 'FFFFFFFF' || !cell.fill.fgColor) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }
        }
      });
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `organico-${date}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── POST /api/v1/workers/import — importa CSV lavoratori (PRIVATO) ───────────
router.post('/workers/import', verifySupabaseJwt, async (req, res) => {
  const { csv_text } = req.body || {};
  if (!csv_text || typeof csv_text !== 'string') {
    return res.status(400).json({ error: 'csv_text obbligatorio' });
  }

  const lines = csv_text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV deve contenere almeno una riga di dati' });
  }

  // Auto-detect separatore
  const sep = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const col = (v) => (v || '').trim().replace(/^"(.*)"$/, '$1').trim();

  // Converti date GG/MM/AAAA → YYYY-MM-DD
  const parseDate = (v) => {
    if (!v) return null;
    const s = col(v);
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  };

  const companyId = req.companyId;
  const errors = [];
  let created = 0, updated = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(sep);
    const full_name   = col(parts[0]);
    const fiscal_code = col(parts[1]);

    if (!full_name || !fiscal_code) {
      errors.push({ row: i + 1, error: 'Nome o CF mancante' });
      continue;
    }
    if (!isValidFiscalCode(fiscal_code)) {
      errors.push({ row: i + 1, error: `CF non valido: ${fiscal_code}` });
      continue;
    }

    const birth_date              = parseDate(parts[2]);
    const hire_date               = parseDate(parts[3]);
    const qualification           = col(parts[4]) || null;
    const role                    = col(parts[5]) || null;
    const safety_training_expiry  = parseDate(parts[6]);
    const health_fitness_expiry   = parseDate(parts[7]);

    // Cerca worker esistente per questa company
    const { data: existing } = await supabase
      .from('workers')
      .select('id')
      .eq('company_id', companyId)
      .eq('fiscal_code', fiscal_code.toUpperCase())
      .maybeSingle();

    if (existing) {
      // Aggiorna
      const { error: updErr } = await supabase.from('workers').update({
        full_name,
        ...(birth_date             !== null && { birth_date }),
        ...(hire_date              !== null && { hire_date }),
        ...(qualification          !== null && { qualification }),
        ...(role                   !== null && { role }),
        ...(safety_training_expiry !== null && { safety_training_expiry }),
        ...(health_fitness_expiry  !== null && { health_fitness_expiry }),
      }).eq('id', existing.id);
      if (updErr) { errors.push({ row: i + 2, error: updErr.message }); continue; }
      updated++;
    } else {
      // Crea
      const { first_name, last_name } = parseFullName(full_name);
      const { error: insErr } = await supabase.from('workers').insert({
        company_id: companyId,
        full_name,
        first_name,
        last_name,
        fiscal_code: fiscal_code.toUpperCase(),
        is_active: true,
        badge_code: generateBadgeCode(),
        ...(birth_date             && { birth_date }),
        ...(hire_date              && { hire_date }),
        ...(qualification          && { qualification }),
        ...(role                   && { role }),
        ...(safety_training_expiry && { safety_training_expiry }),
        ...(health_fitness_expiry  && { health_fitness_expiry }),
      });
      if (insErr) { errors.push({ row: i + 2, error: insErr.message }); continue; }
      created++;
    }
  }

  const imported = created + updated;
  return res.json({ ok: true, imported, created, updated, errors, total_rows: lines.length - 1 });
});

module.exports = router;
