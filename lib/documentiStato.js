'use strict';
/**
 * lib/documentiStato.js — F-316 (AUDIT.md), Documenti senza cartelle.
 *
 * Una sola risposta alla domanda del titolare: "chi è in regola, e cosa gli
 * manca?". Cinque proprietari sempre separati (lavoratori, subappaltatori,
 * mezzi, cantieri, la tua impresa); per ognuno:
 *   - i documenti RICHIESTI, con lo stato anche quando il documento non c'è
 *     ("manca"), letti dal campo da cui il resto del sistema legge lo stato
 *     (workers.health_fitness_expiry, equipment.insurance_expiry, …) e dai
 *     documenti caricati: vale la scadenza più lontana tra i due;
 *   - gli altri documenti, dalla tabella unificata `documents` (per tipo conta
 *     solo il più recente: un rinnovo sostituisce il vecchio).
 *
 * Le buste paga non sono qui: restano in Buste paga.
 * I requisiti sono volutamente pochi e certi (nessun "manca" su un obbligo che
 * dipende dalla mansione, come il corso imbracatura): un falso allarme
 * insegna al titolare a ignorare il rosso.
 */
const supabase = require('./supabase');
const { complianceStatus } = require('./compliance');
const { isFeatureEnabled } = require('./featureFlags');

const KINDS = ['lavoratori', 'subappaltatori', 'mezzi', 'cantieri', 'impresa'];

// Mezzi su strada: assicurazione e revisione sono obbligatorie. Per gru,
// betoniere e attrezzi no (lì vale la verifica periodica, che non tracciamo
// come campo), quindi niente "manca" fuori da questi tipi.
const VEHICLE_RE = /autocarro|furgone|auto|moto|scooter|camion|veicolo|rimorchio|pick.?up|minibus|trattore stradale/i;

// Requisiti per tipo di proprietario. `cats` = categorie di documento che
// valgono per quel requisito; `field` = colonna del proprietario.
const REQUIREMENTS = {
  lavoratori: [
    { key: 'idoneita',   label: 'Visita medica',     field: 'health_fitness_expiry',  cats: c => c.startsWith('idoneita'), ocr: 'idoneita' },
    { key: 'formazione', label: 'Corso sicurezza',   field: 'safety_training_expiry', cats: c => c === 'formazione_sicurezza', certificati: true, ocr: 'altro' },
  ],
  mezzi: [
    { key: 'assicurazione', label: 'Assicurazione', field: 'insurance_expiry', cats: c => ['assicurazione', 'polizza', 'insurance'].includes(c), ocr: 'assicurazione' },
    // La prima revisione arriva dopo 4 anni: senza una data nota non è "manca"
    { key: 'revisione',     label: 'Revisione',     field: 'inspection_date',  cats: c => c === 'revisione', ocr: 'altro', optional: true },
  ],
  subappaltatori: [
    { key: 'durc', label: 'DURC', field: 'durc_expiry', cats: c => c === 'durc', ocr: 'durc' },
  ],
  impresa: [
    { key: 'durc', label: 'DURC', field: 'durc_expiry', cats: c => c === 'durc', ocr: 'durc' },
  ],
  cantieri: [],
};

const CATEGORY_LABEL = {
  idoneita_medica: 'Visita medica', idoneita_sanitaria: 'Visita medica', idoneita: 'Visita medica',
  formazione_sicurezza: 'Corso sicurezza', certificato_formazione: 'Attestato di formazione', attestato_formazione: 'Attestato di formazione',
  primo_soccorso: 'Corso primo soccorso', antincendio: 'Corso antincendio', lavori_quota: 'Corso lavori in quota',
  ponteggi: 'Corso ponteggi', gruista: 'Patentino gru', pes_pav_pei: 'Corso PES/PAV/PEI', patente_guida: 'Patente',
  durc: 'DURC', visura: 'Visura camerale', dvr: 'DVR', duvri: 'DUVRI', rspp: 'Nomina RSPP', rls: 'Nomina RLS',
  medico_competente: 'Nomina medico competente', visite_mediche: 'Visite mediche', preposto: 'Nomina preposto',
  emergenze: 'Piano di emergenza', formazione: 'Formazione', iso: 'Certificazione ISO', soa: 'Attestazione SOA',
  assicurazione: 'Assicurazione', polizza: 'Assicurazione', insurance: 'Assicurazione', revisione: 'Revisione',
  libretto: 'Libretto', pos: 'POS', psc: 'PSC', notifica_asl: 'Notifica preliminare', f24: 'F24',
};

// Download: stessi endpoint già usati dall'archivio (path senza /api/v1)
const DOWNLOAD_PATH = {
  company_documents:       d => `/company-documents/${d.legacy_id}/download`,
  worker_documents:        d => `/workers/${d.worker_id}/documents/${d.legacy_id}/download`,
  site_documents:          d => `/documents/${d.legacy_id}/download`,
  worker_certificates:     d => `/certificates/${d.legacy_id}/download`,
  equipment_documents:     d => `/equipment/${d.equipment_id}/documents/${d.legacy_id}/download`,
  subcontractor_documents: d => `/subcontractors/${d.subcontractor_id}/documents/${d.legacy_id}/download`,
  studio_shared_documents: d => `/archive/studio-shared-documents/${d.legacy_id}/download`,
};
// Mai qui: buste paga (restano in Buste paga), richieste del CDL, modelli di Ladia
const EXCLUDED_SOURCES = ['payslips', 'studio_document_requests', 'ladia_document_templates'];

// not_set → manca, expired → scaduto, expiring → in scadenza (30 gg), ok
const STATE = { not_set: 'manca', expired: 'scaduto', expiring: 'in_scadenza', ok: 'in_regola' };
const RANK = { scaduto: 0, manca: 1, in_scadenza: 2, in_regola: 3, senza_scadenza: 4 };

const dateOnly = v => (v ? String(v).slice(0, 10) : null);
const docExpiry = d => dateOnly(d.expiry_date || d.ai_expiry_date);

// F-317: pagine ritagliate da un PDF importato, salvate col solo codice della
// categoria come nome ("altro", "busta_paga"): mai mostrare il codice tecnico.
const CODE_NAME_LABEL = { busta_paga: 'Busta paga senza lavoratore', altro: 'Documento senza nome' };

const UNNAMED = new Set(Object.values(CODE_NAME_LABEL));
const unnamed = d => (UNNAMED.has(d.label) ? 1 : 0);

function docLabel(d, courseNames) {
  if (d.course_type_id && courseNames.has(d.course_type_id)) return courseNames.get(d.course_type_id);
  if (d.category && CATEGORY_LABEL[d.category]) return CATEGORY_LABEL[d.category];
  const name = String(d.name || '').trim();
  if (CODE_NAME_LABEL[name]) return CODE_NAME_LABEL[name];
  if (/^[a-z_]+$/.test(name)) return 'Documento senza nome';
  return name.replace(/\.(pdf|jpe?g|png|webp)$/i, '') || 'Documento';
}

function ownerOfDoc(d) {
  if (d.worker_id) return `lavoratori:${d.worker_id}`;
  if (d.equipment_id) return `mezzi:${d.equipment_id}`;
  if (d.subcontractor_id) return `subappaltatori:${d.subcontractor_id}`;
  if (d.site_id) return `cantieri:${d.site_id}`;
  if (d.owner_type === 'company') return 'impresa:impresa';
  return null;
}

function isVehicle(e) { return VEHICLE_RE.test(`${e.type || ''} ${e.model || ''}`); }

function requirementsFor(kind, row) {
  const reqs = REQUIREMENTS[kind] || [];
  if (kind === 'mezzi' && !isVehicle(row)) return [];
  return reqs;
}

/** Carica tutto quello che serve per un'azienda in una passata. */
async function loadCompany(companyId) {
  const subsEnabled = await isFeatureEnabled(companyId, 'subappaltatori');
  const [workersRes, equipRes, subsRes, sitesRes, companyRes, docsRes, coursesRes] = await Promise.all([
    supabase.from('workers').select('id, full_name, role, qualification, safety_training_expiry, health_fitness_expiry')
      .eq('company_id', companyId).eq('is_active', true).order('full_name'),
    supabase.from('equipment').select('id, type, model, plate_or_serial, insurance_expiry, inspection_date')
      .eq('company_id', companyId).eq('is_active', true),
    subsEnabled
      ? supabase.from('subcontractors').select('id, company_name, durc_expiry').eq('company_id', companyId).eq('is_active', true).order('company_name')
      : Promise.resolve({ data: [], error: null }),
    supabase.from('sites').select('id, name, address, status').eq('company_id', companyId).in('status', ['attivo', 'sospeso']).order('name'),
    supabase.from('companies').select('id, name, durc_expiry').eq('id', companyId).maybeSingle(),
    supabase.from('documents')
      .select('id, source_table, legacy_id, owner_type, site_id, worker_id, subcontractor_id, equipment_id, category, name, expiry_date, ai_expiry_date, course_type_id, created_at')
      .eq('company_id', companyId).is('deleted_at', null).not('source_table', 'in', `(${EXCLUDED_SOURCES.join(',')})`)
      .limit(5000),
    supabase.from('course_types').select('id, name'),
  ]);
  for (const r of [workersRes, equipRes, subsRes, sitesRes, companyRes, docsRes, coursesRes]) {
    if (r.error) throw new Error(r.error.message);
  }
  const courseNames = new Map((coursesRes.data || []).map(c => [c.id, c.name]));

  const owners = [];
  for (const w of workersRes.data || []) owners.push({ kind: 'lavoratori', id: w.id, name: w.full_name, detail: w.role || w.qualification || null, row: w });
  for (const s of subsRes.data || []) owners.push({ kind: 'subappaltatori', id: s.id, name: s.company_name, detail: null, row: s });
  for (const e of equipRes.data || []) {
    owners.push({ kind: 'mezzi', id: e.id, name: [e.type, e.model].filter(Boolean).join(' '), detail: e.plate_or_serial || null, row: e });
  }
  for (const s of sitesRes.data || []) owners.push({ kind: 'cantieri', id: s.id, name: s.name, detail: s.address || null, row: s });
  if (companyRes.data) owners.push({ kind: 'impresa', id: 'impresa', name: companyRes.data.name, detail: null, row: companyRes.data });

  const docsByOwner = new Map();
  for (const d of docsRes.data || []) {
    const k = ownerOfDoc(d);
    if (!k) continue;
    if (!docsByOwner.has(k)) docsByOwner.set(k, []);
    docsByOwner.get(k).push(d);
  }
  const certCourseIsFormazione = id => /^formazione lavoratori/i.test(courseNames.get(id) || '');
  return { owners, docsByOwner, courseNames, certCourseIsFormazione, subsEnabled };
}

function publicDoc(d, label) {
  const exp = docExpiry(d);
  const dl = DOWNLOAD_PATH[d.source_table];
  return {
    id: d.id, label, name: d.name || null, expiry: exp,
    state: exp ? STATE[complianceStatus(exp)] : 'senza_scadenza',
    download: dl ? dl(d) : null,
  };
}

/** Stato completo di un proprietario: requisiti + altri documenti. */
function ownerStatus(o, ctx) {
  const docs = ctx.docsByOwner.get(`${o.kind}:${o.id}`) || [];
  const used = new Set();
  const requirements = requirementsFor(o.kind, o.row).map(r => {
    const matching = docs.filter(d => (d.category && r.cats(d.category)) ||
      (r.certificati && d.source_table === 'worker_certificates' && ctx.certCourseIsFormazione(d.course_type_id)));
    matching.forEach(d => used.add(d.id));
    const best = matching.filter(docExpiry).sort((a, b) => docExpiry(b).localeCompare(docExpiry(a)))[0]
      || matching.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    const fieldDate = dateOnly(o.row[r.field]);
    const docDate = best ? docExpiry(best) : null;
    const expiry = [fieldDate, docDate].filter(Boolean).sort().at(-1) || null;
    if (r.optional && !expiry && !best) return null;
    return {
      key: r.key, label: r.label, expiry,
      state: STATE[complianceStatus(expiry)],
      doc: best ? publicDoc(best, r.label) : null,
    };
  }).filter(Boolean);

  // Altri documenti: per tipo conta il più recente (un rinnovo sostituisce il vecchio)
  const latest = new Map();
  for (const d of docs) {
    if (used.has(d.id)) continue;
    const label = docLabel(d, ctx.courseNames);
    const key = d.category && d.category !== 'altro' ? `${d.category}|${d.course_type_id || ''}` : `doc:${d.id}`;
    const prev = latest.get(key);
    const newer = !prev || (docExpiry(d) || '') > (docExpiry(prev.d) || '') ||
      ((docExpiry(d) || '') === (docExpiry(prev.d) || '') && String(d.created_at) > String(prev.d.created_at));
    if (newer) latest.set(key, { d, label });
  }
  const documents = [...latest.values()].map(({ d, label }) => publicDoc(d, label))
    // F-317: le pagine senza nome vanno in fondo, dopo i documenti veri
    .sort((a, b) => RANK[a.state] - RANK[b.state] || unnamed(a) - unnamed(b) || a.label.localeCompare(b.label, 'it'));

  // Il problema più grave decide lo stato del proprietario (prima i requisiti)
  const issues = [...requirements, ...documents.filter(d => d.state === 'scaduto' || d.state === 'in_scadenza')]
    .filter(x => x.state !== 'in_regola')
    .sort((a, b) => RANK[a.state] - RANK[b.state] || String(a.expiry || '').localeCompare(String(b.expiry || '')));
  const worst = issues[0] || null;
  return {
    kind: o.kind, id: o.id, name: o.name, detail: o.detail,
    state: worst ? worst.state : 'in_regola',
    worst: worst ? { label: worst.label, state: worst.state, expiry: worst.expiry || null } : null,
    issues: issues.length,
    requirements, documents,
  };
}

/** Le cinque voci di Documenti, con una riga di stato ciascuna. */
async function riepilogo(companyId) {
  const ctx = await loadCompany(companyId);
  const all = ctx.owners.map(o => ownerStatus(o, ctx));
  return KINDS.filter(k => k !== 'subappaltatori' || ctx.subsEnabled).map(kind => {
    const list = all.filter(s => s.kind === kind);
    const problems = list.filter(s => s.state !== 'in_regola');
    const urgent = problems.filter(s => s.state === 'scaduto' || s.state === 'manca').length;
    return {
      kind, total: list.length, problems: problems.length, urgent,
      // Per l'impresa (un solo proprietario) basta il suo problema più grave
      worst: kind === 'impresa' ? (list[0]?.worst || null) : null,
    };
  });
}

/** Elenco di una voce: chi ha problemi prima, in ordine di gravità. */
async function elenco(companyId, kind) {
  if (!KINDS.includes(kind)) return null;
  const ctx = await loadCompany(companyId);
  if (kind === 'subappaltatori' && !ctx.subsEnabled) return null;
  return ctx.owners.filter(o => o.kind === kind).map(o => {
    const s = ownerStatus(o, ctx);
    return { kind: s.kind, id: s.id, name: s.name, detail: s.detail, state: s.state, worst: s.worst, issues: s.issues };
  }).sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name, 'it'));
}

/** Scheda di un proprietario. */
async function scheda(companyId, kind, id) {
  if (!KINDS.includes(kind)) return null;
  const ctx = await loadCompany(companyId);
  if (kind === 'subappaltatori' && !ctx.subsEnabled) return null;
  const o = ctx.owners.find(x => x.kind === kind && x.id === id);
  return o ? ownerStatus(o, ctx) : null;
}

module.exports = { riepilogo, elenco, scheda, REQUIREMENTS, KINDS, isVehicle, requirementsFor };
