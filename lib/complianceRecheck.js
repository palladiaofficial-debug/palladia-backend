'use strict';
const supabase = require('./supabase');
const { complianceStatus, overallStatus } = require('./compliance');
const { computeRiskScore } = require('../services/safetyCopilot');

// ── RIVERIFICA generalizzata — Fase 0 "Ciclo del Risultato" ──────────────────
// Prima di questo file, l'unica riverifica reale era recheckWorkerCompliance()
// dentro lib/ladiaGenericTools.js, hardcoded su resourceName==='workers'. Ogni
// altro tool di scrittura (documenti azienda, subappaltatori, attrezzature,
// certificati formazione, non conformità) non aveva alcun "Fatto" verificato
// dal motore — solo la parola di Ladia. Questo modulo estende lo stesso
// principio (rileggere la riga FRESCA dal DB, mai fidarsi del payload appena
// scritto) a ogni tipo di entità toccata da una scrittura.
//
// Ogni handler ritorna una union discriminata da `kind`, cosi' ResultCard puo'
// renderizzare qualunque verdetto senza sapere quale risorsa l'ha generato.

async function recheckWorker(companyId, recordId) {
  const { data: w } = await supabase
    .from('workers')
    .select('id, full_name, is_active, safety_training_expiry, health_fitness_expiry')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!w) return null;
  return {
    kind: 'worker_overall',
    worker_id: w.id,
    worker_name: w.full_name,
    stato_complessivo: overallStatus(w),
    formazione_sicurezza: { scadenza: w.safety_training_expiry, stato: complianceStatus(w.safety_training_expiry) },
    idoneita_medica:      { scadenza: w.health_fitness_expiry,  stato: complianceStatus(w.health_fitness_expiry) },
  };
}

async function recheckCompanyDocument(companyId, recordId) {
  const { data: d } = await supabase
    .from('company_documents')
    .select('id, name, category, ai_expiry_date')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!d) return null;
  return {
    kind: 'expiry',
    entity_label: d.name || d.category,
    scadenza: d.ai_expiry_date,
    stato: complianceStatus(d.ai_expiry_date),
  };
}

async function recheckWorkerDocument(companyId, recordId) {
  const { data: d } = await supabase
    .from('worker_documents')
    .select('id, name, expiry_date, worker_id, workers(full_name)')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!d) return null;
  return {
    kind: 'expiry',
    entity_label: `${d.name} — ${d.workers?.full_name || 'lavoratore'}`,
    scadenza: d.expiry_date,
    stato: complianceStatus(d.expiry_date),
  };
}

async function recheckWorkerCertificate(companyId, recordId) {
  const { data: c } = await supabase
    .from('worker_certificates')
    .select('id, expiry_date, worker_id, workers(full_name), course_types(name, violation_code)')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!c) return null;
  return {
    kind: 'expiry',
    entity_label: `${c.course_types?.name || 'Formazione'} — ${c.workers?.full_name || 'lavoratore'}`,
    scadenza: c.expiry_date,
    stato: complianceStatus(c.expiry_date),
    violation_code: c.course_types?.violation_code || null,
  };
}

// Un subappaltatore ha 3 scadenze indipendenti (DURC/assicurazione/SOA) — la
// riverifica riguarda solo il campo effettivamente toccato dalla scrittura,
// non tutte e 3, altrimenti un update sull'assicurazione mostrerebbe anche lo
// stato (invariato) del DURC come se fosse parte del "Fatto" di quell'azione.
async function recheckSubcontractor(companyId, recordId, field) {
  const col = field || 'durc_expiry';
  const { data: s } = await supabase
    .from('subcontractors')
    .select(`id, company_name, ${col}`)
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!s) return null;
  const FIELD_LABEL = { durc_expiry: 'DURC', insurance_expiry: 'Assicurazione', soa_expiry: 'SOA' };
  return {
    kind: 'expiry',
    entity_label: `${FIELD_LABEL[col] || col} — ${s.company_name}`,
    scadenza: s[col],
    stato: complianceStatus(s[col]),
  };
}

async function recheckEquipment(companyId, recordId) {
  const { data: e } = await supabase
    .from('equipment')
    .select('id, type, model, insurance_expiry')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!e) return null;
  return {
    kind: 'expiry',
    entity_label: `${e.type}${e.model ? ' ' + e.model : ''}`,
    scadenza: e.insurance_expiry,
    stato: complianceStatus(e.insurance_expiry),
  };
}

// Rischio cantiere dopo una scrittura su site_notes (risoluzione non
// conformità) — stesso "compilatore" usato da get_risk_score, spostato qui da
// resolve_nonconformity (routes/v1/chat.js) perché'e' l'unica riverifica reale
// non basata su una scadenza, e va riusata anche da altri tool che toccano
// site_notes in futuro.
async function recheckSiteNotes(companyId, recordId) {
  const { data: note } = await supabase
    .from('site_notes')
    .select('id, site_id')
    .eq('company_id', companyId)
    .eq('id', recordId)
    .maybeSingle();
  if (!note?.site_id) return null;
  const risk = await computeRiskScore(note.site_id, companyId);
  if (!risk) return null;
  return {
    kind: 'risk_score',
    livello: risk.level,
    etichetta: risk.label,
    punteggio: risk.score,
    non_conformita_ancora_aperte: risk.dimensions.nonConformity.detail,
  };
}

const HANDLERS = {
  workers: recheckWorker,
  company_documents: recheckCompanyDocument,
  worker_documents: recheckWorkerDocument,
  worker_certificates: recheckWorkerCertificate,
  subcontractors: recheckSubcontractor,
  equipment: recheckEquipment,
  site_notes: recheckSiteNotes,
};

// resourceName: chiave HANDLERS sopra (non necessariamente una risorsa
// registrata in ladiaSchemaRegistry — company_documents ad es. e' scritta solo
// da archive_document, mai da create_record/update_record generici, ma va
// comunque riverificata dopo quella scrittura).
async function recheckCompliance(resourceName, companyId, recordId, extra) {
  if (!recordId) return null;
  const handler = HANDLERS[resourceName];
  if (!handler) return null;
  return handler(companyId, recordId, extra?.field);
}

module.exports = { recheckCompliance };
