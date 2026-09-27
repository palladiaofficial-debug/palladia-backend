'use strict';
/**
 * lib/daFareFatto.js — F-246 (AUDIT.md), "Fatto" su Da fare.
 *
 * "Prenotata" (F-243) mette da parte una scadenza ma per il resto del sistema
 * resta scaduta. "Fatto" invece dice al sistema che il rinnovo c'è: scrive la
 * nuova scadenza nel campo da cui tutto il resto la legge (stato del
 * lavoratore, conformità, campanella, card di Ladia, cron degli avvisi).
 *
 * Per le righe documento la scadenza va scritta nella tabella di ORIGINE:
 * `documents` è una copia tenuta allineata dai trigger (migrazioni 151-173),
 * scriverci direttamente verrebbe sovrascritto al primo aggiornamento.
 */
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { recheckCompliance } = require('./complianceRecheck');
const { romeDate, addDays } = require('./daFare');

// Campi diretti: tipo della riga → colonna
const WORKER_FIELDS = { idoneita: 'health_fitness_expiry', formazione: 'safety_training_expiry' };
const EQUIPMENT_FIELDS = { assicurazione: 'insurance_expiry', revisione: 'inspection_date', manutenzione: 'maintenance_date' };
const SUB_FIELDS = { durc: 'durc_expiry', assicurazione: 'insurance_expiry', soa: 'soa_expiry' };

// Tabelle di origine dei documenti: colonna della scadenza letta dal trigger
// di sincronizzazione verso `documents`.
const DOC_SOURCES = {
  worker_documents:        { col: 'expiry_date',    owner: 'worker_id' },
  worker_certificates:     { col: 'expiry_date',    owner: 'worker_id' },
  company_documents:       { col: 'ai_expiry_date', owner: null },
  site_documents:          { col: 'ai_expiry_date', owner: 'site_id' },
  subcontractor_documents: { col: 'valid_until',    owner: 'subcontractor_id' },
  // equipment_documents: la scadenza vive in ai_extracted (migrazione 173)
  equipment_documents:     { json: { assicurazione: 'data_scadenza_assicurazione', revisione: 'data_prossima_revisione' }, owner: 'equipment_id' },
};
const FATTO_DOC_SOURCES = new Set(Object.keys(DOC_SOURCES));

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ITEM_PATTERNS = [
  [new RegExp(`^worker:(${UUID}):(idoneita|formazione)$`, 'i'), 'worker'],
  [new RegExp(`^equipment:(${UUID}):(assicurazione|revisione|manutenzione)$`, 'i'), 'equipment'],
  [new RegExp(`^sub:(${UUID}):(durc|assicurazione|soa)$`, 'i'), 'sub'],
  [/^company:(durc)$/, 'company'],
  [new RegExp(`^site:(${UUID}):(suolo)$`, 'i'), 'site'],
  [new RegExp(`^doc:(${UUID})$`, 'i'), 'doc'],
];

class FattoError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function parseItem(itemId) {
  for (const [re, kind] of ITEM_PATTERNS) {
    const m = re.exec(String(itemId || ''));
    if (m) return { kind, id: m[1], type: m[2] };
  }
  return null;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Stessa classificazione di lib/daFare.js (categoryType)
function categoryType(cat) {
  if (!cat) return 'documento';
  if (cat.startsWith('idoneita')) return 'idoneita';
  if (cat.includes('formazione')) return 'formazione';
  if (cat === 'durc') return 'durc';
  if (cat === 'assicurazione' || cat === 'polizza' || cat === 'insurance') return 'assicurazione';
  if (cat === 'soa') return 'soa';
  if (cat === 'revisione') return 'revisione';
  return 'documento';
}

/** Aggiorna una colonna data solo se la riga è dell'azienda; ritorna il valore precedente. */
async function updateDateField(table, companyId, rowId, col, value, { onlyIfOlder = false } = {}) {
  const q = supabase.from(table).select(`id, ${col}`).eq('id', rowId);
  const { data: row, error } = await (table === 'companies' ? q : q.eq('company_id', companyId)).maybeSingle();
  if (error) throw new FattoError('DB_ERROR', error.message, 500);
  if (!row) return { found: false };
  const previous = row[col] ? String(row[col]).slice(0, 10) : null;
  if (onlyIfOlder && previous && previous >= value) return { found: true, previous, changed: false };
  const upd = supabase.from(table).update({ [col]: value }).eq('id', rowId);
  const { error: uErr } = await (table === 'companies' ? upd : upd.eq('company_id', companyId));
  if (uErr) throw new FattoError('DB_ERROR', uErr.message, 500);
  return { found: true, previous, changed: true };
}

/**
 * Segna "fatto" una riga scadenza di Da fare.
 * @returns {{ itemId, nuovaScadenza, previous, target, ownerSync, recheck }}
 */
async function segnaFatto({ companyId, itemId, nuovaScadenza, userId = null, userRole = null, req = null }) {
  const item = parseItem(itemId);
  if (!item) throw new FattoError('INVALID_ITEM', 'Questa riga non si può segnare come fatta');
  if (!validDate(nuovaScadenza)) throw new FattoError('INVALID_DATE', 'Data non valida');
  const today = romeDate();
  if (nuovaScadenza <= today) throw new FattoError('DATE_NOT_FUTURE', 'La nuova scadenza deve essere dopo oggi');
  if (nuovaScadenza > addDays(today, 3660)) throw new FattoError('DATE_TOO_FAR', 'La nuova scadenza è oltre 10 anni');

  let target, res, ownerSync = null, recheck = null;

  if (item.kind === 'worker') {
    const col = WORKER_FIELDS[item.type];
    target = { table: 'workers', id: item.id, col };
    res = await updateDateField('workers', companyId, item.id, col, nuovaScadenza);
    if (res.found) recheck = await recheckCompliance('workers', companyId, item.id);
  } else if (item.kind === 'equipment') {
    const col = EQUIPMENT_FIELDS[item.type];
    target = { table: 'equipment', id: item.id, col };
    res = await updateDateField('equipment', companyId, item.id, col, nuovaScadenza);
    if (res.found) recheck = await recheckCompliance('equipment', companyId, item.id);
  } else if (item.kind === 'sub') {
    const col = SUB_FIELDS[item.type];
    target = { table: 'subcontractors', id: item.id, col };
    res = await updateDateField('subcontractors', companyId, item.id, col, nuovaScadenza);
    if (res.found) recheck = await recheckCompliance('subcontractors', companyId, item.id, { field: col });
  } else if (item.kind === 'company') {
    target = { table: 'companies', id: companyId, col: 'durc_expiry' };
    res = await updateDateField('companies', companyId, companyId, 'durc_expiry', nuovaScadenza);
  } else if (item.kind === 'site') {
    target = { table: 'sites', id: item.id, col: 'suolo_occupazione_end' };
    res = await updateDateField('sites', companyId, item.id, 'suolo_occupazione_end', nuovaScadenza);
  } else {
    // Riga documento: risalire alla tabella di origine
    const { data: doc, error } = await supabase.from('documents')
      .select('id, source_table, legacy_id, category, worker_id, equipment_id, subcontractor_id, site_id, owner_type')
      .eq('company_id', companyId).eq('id', item.id).maybeSingle();
    if (error) throw new FattoError('DB_ERROR', error.message, 500);
    if (!doc) throw new FattoError('NOT_FOUND', 'Documento non trovato', 404);
    const src = DOC_SOURCES[doc.source_table];
    if (!src) throw new FattoError('UNSUPPORTED', 'Per questo documento carica il file nuovo', 422);
    const type = categoryType(doc.category);

    if (src.json) {
      const key = src.json[type];
      if (!key) throw new FattoError('UNSUPPORTED', 'Per questo documento carica il file nuovo', 422);
      const { data: row } = await supabase.from('equipment_documents').select('id, ai_extracted')
        .eq('company_id', companyId).eq('id', doc.legacy_id).maybeSingle();
      if (!row) throw new FattoError('NOT_FOUND', 'Documento non trovato', 404);
      const extracted = row.ai_extracted && typeof row.ai_extracted === 'object' ? row.ai_extracted : {};
      const { error: uErr } = await supabase.from('equipment_documents')
        .update({ ai_extracted: { ...extracted, [key]: nuovaScadenza } })
        .eq('company_id', companyId).eq('id', doc.legacy_id);
      if (uErr) throw new FattoError('DB_ERROR', uErr.message, 500);
      target = { table: 'equipment_documents', id: doc.legacy_id, col: `ai_extracted.${key}` };
      res = { found: true, previous: extracted[key] || null, changed: true };
    } else {
      target = { table: doc.source_table, id: doc.legacy_id, col: src.col };
      res = await updateDateField(doc.source_table, companyId, doc.legacy_id, src.col, nuovaScadenza);
    }

    // Il campo del titolare è quello che leggono stato del lavoratore e
    // conformità: se era più vecchio lo si porta alla nuova data.
    const ownerField =
      doc.worker_id && WORKER_FIELDS[type] ? ['workers', doc.worker_id, WORKER_FIELDS[type], 'workers'] :
      doc.equipment_id && EQUIPMENT_FIELDS[type] ? ['equipment', doc.equipment_id, EQUIPMENT_FIELDS[type], 'equipment'] :
      doc.subcontractor_id && SUB_FIELDS[type] ? ['subcontractors', doc.subcontractor_id, SUB_FIELDS[type], 'subcontractors'] :
      doc.owner_type === 'company' && type === 'durc' ? ['companies', companyId, 'durc_expiry', null] :
      null;
    if (ownerField) {
      const [table, rowId, col, recheckName] = ownerField;
      const r = await updateDateField(table, companyId, rowId, col, nuovaScadenza, { onlyIfOlder: true });
      ownerSync = { table, id: rowId, col, previous: r.previous ?? null, changed: !!r.changed };
      if (recheckName) recheck = await recheckCompliance(recheckName, companyId, rowId, { field: col });
    }
  }

  if (!res?.found) throw new FattoError('NOT_FOUND', 'Elemento non trovato', 404);

  // La prenotazione su questa riga non serve più
  await supabase.from('da_fare_prenotazioni').delete().eq('company_id', companyId).eq('item_id', itemId);

  await auditLog({
    companyId, userId, userRole, action: 'da_fare.fatto',
    targetType: target.table, targetId: String(target.id),
    payload: { itemId, campo: target.col, prima: res.previous, dopo: nuovaScadenza, ownerSync },
    req,
  });

  return { itemId, nuovaScadenza, previous: res.previous, target, ownerSync, recheck };
}

module.exports = { segnaFatto, parseItem, FattoError, FATTO_DOC_SOURCES };
