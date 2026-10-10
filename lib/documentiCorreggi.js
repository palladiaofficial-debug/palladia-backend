'use strict';
// ── Correggere la scadenza di un documento (F-329, AUDIT.md del frontend) ─────
// Nella pagina Documenti senza cartelle (F-316) un documento in regola non si
// poteva più correggere: una data letta male restava lì per sempre. Qui la
// correzione, per ogni tabella d'origine dell'archivio unificato (`documents`):
//   - cambia la scadenza nella riga d'origine (il trigger di sync aggiorna
//     `documents`);
//   - se il documento è quello di un requisito (visita medica, corso, DURC,
//     assicurazione, revisione) e il campo del proprietario aveva proprio la
//     vecchia data, corregge anche quello — ANCHE all'indietro: è una
//     correzione, non un rinnovo (il rinnovo, in documentiCarica, va solo avanti).
// L'eliminazione usa le rotte che esistono già: la scheda dà il percorso
// (`elimina`) di ogni documento (lib/documentiStato.js).
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { recheckCompliance } = require('./complianceRecheck');
const { REQUIREMENTS } = require('./documentiStato');

class CorreggiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dateOnly = v => (v ? String(v).slice(0, 10) : null);

// Dove sta la scadenza in ogni tabella d'origine
const SOURCES = {
  worker_documents:        { col: 'expiry_date' },
  worker_certificates:     { col: 'expiry_date' },
  company_documents:       { col: 'ai_expiry_date' },
  site_documents:          { col: 'ai_expiry_date' },
  subcontractor_documents: { col: 'valid_until' },
  // equipment_documents: la data vive in ai_extracted (migrazione 173), chiave per tipo
  equipment_documents:     { json: { assicurazione: 'data_scadenza_assicurazione', revisione: 'data_prossima_revisione' } },
};
const OWNER_TABLE = { lavoratori: 'workers', subappaltatori: 'subcontractors', mezzi: 'equipment', cantieri: 'sites', impresa: 'companies' };

function ownerOf(d) {
  if (d.source_table === 'company_documents') return { kind: 'impresa', id: d.company_id };
  if (d.worker_id) return { kind: 'lavoratori', id: d.worker_id };
  if (d.subcontractor_id) return { kind: 'subappaltatori', id: d.subcontractor_id };
  if (d.equipment_id) return { kind: 'mezzi', id: d.equipment_id };
  if (d.site_id) return { kind: 'cantieri', id: d.site_id };
  return null;
}

async function isFormazioneCert(courseTypeId) {
  if (!courseTypeId) return false;
  const { data } = await supabase.from('course_types').select('name').eq('id', courseTypeId).maybeSingle();
  return /^Formazione lavoratori/i.test(data?.name || '');
}

/**
 * @param {{ companyId: string, docId: string, scadenza: string|null, userId?: string, userRole?: string, req?: object }} p
 * @returns {{ docId, previous, scadenza, ownerSync }}
 */
async function correggi(p) {
  const { companyId, docId } = p;
  const scadenza = p.scadenza || null;
  if (scadenza && !validDate(scadenza)) throw new CorreggiError('INVALID_DATE', 'Data non valida');

  const { data: d, error } = await supabase.from('documents')
    .select('id, company_id, source_table, legacy_id, worker_id, subcontractor_id, equipment_id, site_id, category, course_type_id, expiry_date, ai_expiry_date')
    .eq('id', docId).eq('company_id', companyId).is('deleted_at', null).maybeSingle();
  if (error && error.code !== '22P02') throw new CorreggiError('DB_ERROR', error.message, 500);
  if (!d) throw new CorreggiError('NOT_FOUND', 'Documento non trovato', 404);
  const src = SOURCES[d.source_table];
  if (!src) throw new CorreggiError('NOT_EDITABLE', 'Questo documento non si corregge da qui');
  const previous = dateOnly(d.expiry_date || d.ai_expiry_date);

  // Il documento è quello di un requisito del proprietario?
  const owner = ownerOf(d);
  const cat = String(d.category || '');
  let req = null;
  for (const r of (owner && REQUIREMENTS[owner.kind]) || []) {
    if (r.cats(cat) || (r.certificati && d.source_table === 'worker_certificates' && await isFormazioneCert(d.course_type_id))) { req = r; break; }
  }
  if (req && !scadenza) throw new CorreggiError('SCADENZA_RICHIESTA', `${req.label}: serve una data di scadenza`);

  // 1. La riga d'origine
  if (src.col) {
    const { error: uErr } = await supabase.from(d.source_table).update({ [src.col]: scadenza })
      .eq('id', d.legacy_id).eq('company_id', companyId);
    if (uErr) throw new CorreggiError('DB_ERROR', uErr.message, 500);
  } else {
    const { data: row, error: rErr } = await supabase.from('equipment_documents').select('doc_type, ai_extracted')
      .eq('id', d.legacy_id).eq('company_id', companyId).maybeSingle();
    if (rErr || !row) throw new CorreggiError('NOT_FOUND', 'Documento non trovato', 404);
    const key = src.json[row.doc_type];
    if (!key) throw new CorreggiError('NOT_EDITABLE', 'Questo documento non ha una scadenza da correggere');
    const ai = { ...(row.ai_extracted || {}), [key]: scadenza };
    const { error: uErr } = await supabase.from('equipment_documents').update({ ai_extracted: ai })
      .eq('id', d.legacy_id).eq('company_id', companyId);
    if (uErr) throw new CorreggiError('DB_ERROR', uErr.message, 500);
  }

  // 2. Il campo del proprietario, solo se veniva da questo documento
  let ownerSync = null;
  if (req?.field && owner) {
    const table = OWNER_TABLE[owner.kind];
    const q = supabase.from(table).select(`id, ${req.field}`).eq('id', owner.id);
    const { data: o } = await (table === 'companies' ? q : q.eq('company_id', companyId)).maybeSingle();
    const field = dateOnly(o?.[req.field]);
    if (o && field && field === previous && field !== scadenza) {
      const upd = supabase.from(table).update({ [req.field]: scadenza }).eq('id', owner.id);
      const { error: oErr } = await (table === 'companies' ? upd : upd.eq('company_id', companyId));
      if (oErr) throw new CorreggiError('DB_ERROR', oErr.message, 500);
      ownerSync = { table, col: req.field, previous: field, changed: true };
      if (owner.kind !== 'impresa') await recheckCompliance(table, companyId, owner.id, { field: req.field }).catch(() => null);
    } else {
      ownerSync = { table, col: req.field, previous: field, changed: false };
    }
  }

  await auditLog({
    companyId, userId: p.userId || null, userRole: p.userRole || null, action: 'documenti.correggi',
    targetType: d.source_table, targetId: String(d.legacy_id),
    payload: { docId, previous, scadenza, ownerSync },
    req: p.req || null,
  });
  return { docId, previous, scadenza, ownerSync };
}

module.exports = { correggi, CorreggiError, SOURCES };
