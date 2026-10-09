'use strict';
/**
 * lib/documentiCarica.js — F-316 (AUDIT.md), "Fai una foto al foglio".
 *
 * Un solo caricamento per i cinque proprietari. Il file va nella stessa
 * tabella e nello stesso bucket dei caricamenti che esistono già (così
 * archivio, Ladia, trigger verso `documents` e download continuano a vederlo
 * uguale), con la scadenza confermata dal titolare. Se il documento è il
 * rinnovo di un requisito (visita medica, corso sicurezza, DURC,
 * assicurazione, revisione) la scadenza viene portata anche nel campo del
 * proprietario, ma solo se più lontana di quella che c'era: mai indietro.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { recheckCompliance } = require('./complianceRecheck');
const { updateDateField } = require('./daFareFatto');
const { romeDate } = require('./daFare');
const { REQUIREMENTS, requirementsFor } = require('./documentiStato');

const BUCKET = 'site-documents';
const EQUIP_BUCKET = 'equipment-docs';
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

class CaricaError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function safeName(original) {
  const base = String(original || 'documento').normalize('NFKD').replace(/[^\w.-]/g, '_').slice(-80);
  return base || 'documento';
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Per tipo: tabella del proprietario, colonna del campo, tabella documenti
const OWNER = {
  lavoratori:     { table: 'workers',        active: true },
  mezzi:          { table: 'equipment',      active: true },
  subappaltatori: { table: 'subcontractors', active: true },
  cantieri:       { table: 'sites' },
  impresa:        { table: 'companies' },
};

async function loadOwner(companyId, kind, id) {
  const spec = OWNER[kind];
  if (!spec) throw new CaricaError('INVALID_KIND', 'Tipo di proprietario non valido');
  if (kind === 'impresa') {
    const { data } = await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle();
    if (!data) throw new CaricaError('NOT_FOUND', 'Azienda non trovata', 404);
    return { ...data, id: 'impresa' };
  }
  const cols = kind === 'mezzi' ? 'id, type, model' : 'id';
  let q = supabase.from(spec.table).select(cols).eq('id', id).eq('company_id', companyId);
  if (spec.active) q = q.eq('is_active', true);
  const { data, error } = await q.maybeSingle();
  if (error && error.code !== '22P02') throw new CaricaError('DB_ERROR', error.message, 500);
  if (!data) throw new CaricaError('NOT_FOUND', 'Non trovato', 404);
  return data;
}

/**
 * @param {object} p { companyId, userId, userRole, kind, id, reqKey, expiry, label, file:{buffer,mimetype,originalname,size}, req }
 */
async function carica(p) {
  const { companyId, kind, file } = p;
  const id = kind === 'impresa' ? 'impresa' : p.id;
  if (!file || !file.buffer) throw new CaricaError('FILE_REQUIRED', 'Manca il file');
  if (!ALLOWED_MIME.includes(file.mimetype)) throw new CaricaError('INVALID_FILE_TYPE', 'Serve un PDF o una foto (JPG, PNG)');
  const expiry = p.expiry || null;
  if (expiry && !validDate(expiry)) throw new CaricaError('INVALID_DATE', 'Data non valida');

  const owner = await loadOwner(companyId, kind, id);
  const req = p.reqKey ? requirementsFor(kind, owner).find(r => r.key === p.reqKey)
    || (REQUIREMENTS[kind] || []).find(r => r.key === p.reqKey) : null;
  if (p.reqKey && !req) throw new CaricaError('INVALID_REQUIREMENT', 'Documento richiesto non valido');
  const label = String(p.label || req?.label || file.originalname || 'Documento').trim().slice(0, 200);

  const fileId = crypto.randomUUID();
  const name = safeName(file.originalname);
  let table, row, bucket = BUCKET, path;

  if (kind === 'lavoratori') {
    table = 'worker_documents';
    path = `${companyId}/workers/${id}/${fileId}-${name}`;
    row = {
      company_id: companyId, worker_id: id, name: label,
      doc_type: req?.key === 'idoneita' ? 'idoneita_medica' : req?.key === 'formazione' ? 'formazione_sicurezza' : 'altro',
      expiry_date: expiry, file_path: path, mime_type: file.mimetype,
    };
  } else if (kind === 'mezzi') {
    table = 'equipment_documents'; bucket = EQUIP_BUCKET;
    path = `${companyId}/${id}/${Date.now()}_${name}`;
    // La scadenza degli equipment_documents vive in ai_extracted (migrazione 173)
    const key = req?.key === 'assicurazione' ? 'data_scadenza_assicurazione' : req?.key === 'revisione' ? 'data_prossima_revisione' : null;
    row = {
      company_id: companyId, equipment_id: id, doc_type: req?.key || 'altro',
      file_name: file.originalname || label, file_url: path, file_size: file.size || file.buffer.length, mime_type: file.mimetype,
      ai_extracted: key && expiry ? { [key]: expiry } : null, uploaded_by: p.userId || null,
    };
  } else if (kind === 'subappaltatori') {
    table = 'subcontractor_documents';
    path = `${companyId}/subcontractors/${id}/${fileId}-${name}`;
    row = {
      company_id: companyId, subcontractor_id: id, name: label, category: req?.key === 'durc' ? 'durc' : 'altro',
      file_path: path, file_size: file.size || file.buffer.length, mime_type: file.mimetype, valid_until: expiry, uploaded_by: p.userId || null,
    };
  } else if (kind === 'impresa') {
    table = 'company_documents';
    path = `${companyId}/_company/${fileId}-${name}`;
    row = {
      company_id: companyId, name: label, category: req?.key === 'durc' ? 'durc' : 'altro',
      file_path: path, file_size: file.size || file.buffer.length, mime_type: file.mimetype, ai_expiry_date: expiry, uploaded_by: p.userId || null,
    };
  } else {
    table = 'site_documents';
    path = `${companyId}/${id}/${fileId}-${name}`;
    row = {
      company_id: companyId, site_id: id, name: label, category: 'altro',
      file_path: path, file_size: file.size || file.buffer.length, mime_type: file.mimetype, ai_expiry_date: expiry, uploaded_by: p.userId || null,
    };
  }

  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (upErr) throw new CaricaError('UPLOAD_ERROR', upErr.message, 500);

  const { data: inserted, error: insErr } = await supabase.from(table).insert(row).select('id').single();
  if (insErr) {
    await supabase.storage.from(bucket).remove([path]).catch(() => {});
    throw new CaricaError('DB_ERROR', insErr.message, 500);
  }

  // Rinnovo di un requisito: porta avanti il campo del proprietario (mai indietro)
  let ownerSync = null;
  if (req?.field && expiry && expiry > romeDate()) {
    const ownerTable = OWNER[kind].table;
    const rowId = kind === 'impresa' ? companyId : id;
    const r = await updateDateField(ownerTable, companyId, rowId, req.field, expiry, { onlyIfOlder: true });
    ownerSync = { table: ownerTable, col: req.field, previous: r.previous ?? null, changed: !!r.changed };
    if (r.changed && kind !== 'impresa') {
      await recheckCompliance(ownerTable, companyId, rowId, { field: req.field }).catch(() => null);
    }
  }

  await auditLog({
    companyId, userId: p.userId || null, userRole: p.userRole || null, action: 'documenti.carica',
    targetType: table, targetId: String(inserted.id),
    payload: { kind, ownerId: id, requisito: req?.key || null, scadenza: expiry, ownerSync },
    req: p.req || null,
  });

  return { table, id: inserted.id, label, expiry, ownerSync };
}

module.exports = { carica, CaricaError };
