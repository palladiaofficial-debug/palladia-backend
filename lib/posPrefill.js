'use strict';
// ── Precompilazione del nuovo percorso POS (F-258, AUDIT.md del frontend) ───
// "Chi presenta il POS?" — l'impresa (affidataria) o un subappaltatore del
// cantiere. Qui raccogliamo tutto ciò che il sistema sa già, per non
// chiederlo: dati del cantiere, dati dell'impresa esecutrice, figure della
// sicurezza (dall'ultimo POS di QUELLA impresa: per un subappaltatore i dati
// inseriti una volta vengono ricordati), lavoratori con formazione e
// idoneità, mezzi registrati, orari, coordinatori già noti per il cantiere.
const supabase = require('./supabase');
const { figureSuggestions } = require('./posFigures');

const persona = (nome = '', tel = '', email = '', cf = '') => ({ nome: nome || '', telefono: tel || '', email: email || '', codiceFiscale: cf || '' });

function figuresFrom(d) {
  if (!d) return null;
  return {
    datoreLavoro: persona(d.datoreLavoro),
    rspp: persona(d.rspp, d.rsppTel, d.rsppEmail, d.rsppCf),
    rls: persona(d.rls, d.rlsTel),
    medicoCompetente: persona(d.medico, d.medicoTel),
    addettoPrimoSoccorso: persona(d.primoSoccorso, d.primoSoccorsoTel),
    addettoAntincendio: persona(d.antincendio, d.antincendioTel),
    direttoreTecnico: persona(d.direttoreTecnico),
    prepostoCantiere: persona(d.preposto),
  };
}

/** Ultimo POS emesso dall'impresa indicata (subId null = l'impresa stessa). */
async function lastPosOf(companyId, subId, siteId = null) {
  let q = supabase.from('pos_documents').select('pos_data, site_id, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200);
  if (siteId) q = q.eq('site_id', siteId);
  const { data } = await q;
  return (data || []).find(d => (d.pos_data?.subcontractorId || null) === (subId || null)) || null;
}

const statusOf = (date, today) => {
  if (!date) return 'mancante';
  if (date < today) return 'scaduto';
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return date <= in30 ? 'in_scadenza' : 'valido';
};

async function buildPosPrefill(companyId, siteId, subId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: site } = await supabase.from('sites')
    .select('id, name, address, city, client, client_name, start_date, end_date, budget_totale, shift_start_time, lunch_break_minutes, company_id')
    .eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!site) { const e = new Error('Cantiere non trovato'); e.status = 404; throw e; }

  const { data: company } = await supabase.from('companies')
    .select('name, vat_number, piva, address, city, safety_manager, shift_start_time, lunch_break_minutes')
    .eq('id', companyId).maybeSingle();

  let sub = null;
  if (subId) {
    const { data } = await supabase.from('subcontractors')
      .select('id, company_name, piva, legal_address, contact_person, durc_expiry, is_active')
      .eq('id', subId).eq('company_id', companyId).maybeSingle();
    if (!data) { const e = new Error('Subappaltatore non trovato'); e.status = 404; throw e; }
    sub = data;
  }

  // Figure: dall'ultimo POS di questa impresa (per il subappaltatore: quelle
  // inserite la volta scorsa). Coordinatori e committente: dall'ultimo POS del
  // cantiere, di qualunque impresa (sono gli stessi per tutti).
  const [ownLast, siteLastRes] = await Promise.all([
    lastPosOf(companyId, subId),
    supabase.from('pos_documents').select('pos_data').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const siteLast = siteLastRes.data || null;
  // F-263: per l'impresa le figure arrivano da registro, documenti, attestati,
  // ultimo POS e account, ognuna con la fonte (lib/posFigures.js). Per un
  // subappaltatore restano quelle del suo POS precedente.
  let figures, figureSources = {}, figureCandidates = {}, figuresFromRegistry = false;
  if (sub) {
    figures = figuresFrom(ownLast?.pos_data) || figuresFrom({});
    if (ownLast) for (const k of Object.keys(figures)) if (figures[k].nome) figureSources[k] = { tipo: 'pos', testo: 'Dal POS precedente di questa impresa' };
  } else {
    const fs = await figureSuggestions(companyId, siteId, { company, lastPos: ownLast });
    figures = fs.figures; figureSources = fs.sources; figureCandidates = fs.candidati; figuresFromRegistry = fs.registro;
  }
  const sd = siteLast?.pos_data || {};

  // Lavoratori: assegnati al cantiere e dell'impresa giusta; per un
  // subappaltatore senza assegnazioni, tutti i suoi lavoratori attivi.
  // F-301: anche gli altri lavoratori attivi della stessa impresa
  // (otherWorkers), da aggiungere al POS senza toccare le assegnazioni.
  const WCOLS = 'id, full_name, qualification, role, subcontractor_id, is_active, safety_training_expiry, health_fitness_expiry';
  const [{ data: assigned }, { data: sameImpresa }] = await Promise.all([
    supabase.from('worksite_workers').select(`worker_id, workers(${WCOLS})`).eq('site_id', siteId).eq('status', 'active'),
    (() => {
      let q = supabase.from('workers').select(WCOLS).eq('company_id', companyId).eq('is_active', true).limit(500);
      q = subId ? q.eq('subcontractor_id', subId) : q.is('subcontractor_id', null);
      return q;
    })(),
  ]);
  let wk = (assigned || []).map(a => a.workers).filter(w => w && w.is_active !== false && (w.subcontractor_id || null) === (subId || null));
  if (sub && wk.length === 0) wk = sameImpresa || [];
  const inSite = new Set(wk.map(w => w.id));
  const others = (sameImpresa || []).filter(w => !inSite.has(w.id));
  // F-263: corsi validi di ogni lavoratore, per il controllo "formazione
  // richiesta dai lavori" (anticaduta, ponteggi, mezzi, emergenze…).
  const corsiBy = new Map();
  const allIds = [...wk, ...others].map(w => w.id);
  if (allIds.length) {
    const { data: certs } = await supabase.from('worker_certificates')
      .select('worker_id, expiry_date, course_types(name)')
      .in('worker_id', allIds).is('deleted_at', null);
    for (const c of certs || []) {
      if (c.expiry_date && c.expiry_date < today) continue;
      const n = c.course_types?.name;
      if (!n) continue;
      if (!corsiBy.has(c.worker_id)) corsiBy.set(c.worker_id, new Set());
      corsiBy.get(c.worker_id).add(n);
    }
  }
  const toPrefill = w => ({
    id: w.id,
    name: w.full_name,
    qualification: w.qualification || w.role || '',
    training: { date: w.safety_training_expiry || null, status: statusOf(w.safety_training_expiry, today) },
    fitness: { date: w.health_fitness_expiry || null, status: statusOf(w.health_fitness_expiry, today) },
    corsi: [...(corsiBy.get(w.id) || [])].sort(),
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'it');
  const workers = wk.map(toPrefill).sort(byName);
  const otherWorkers = others.map(toPrefill).sort(byName);

  let mezzi = [];
  if (!sub) {
    const { data } = await supabase.from('equipment').select('name, type, model').eq('company_id', companyId).eq('is_active', true).limit(100);
    mezzi = [...new Set((data || []).map(e => (e.name || [e.type, e.model].filter(Boolean).join(' ')).trim()).filter(Boolean))];
  }

  const shift = site.shift_start_time || company?.shift_start_time || null;
  const lunch = site.lunch_break_minutes ?? company?.lunch_break_minutes ?? null;

  return {
    site: {
      id: site.id,
      name: site.name,
      address: [site.address, site.city].filter(Boolean).join(', '),
      client: site.client_name || site.client || sd.client || '',
      cfCommittente: sd.cfCommittente || '',
      startDate: site.start_date || sd.startDate || '',
      endDate: site.end_date || sd.endDate || '',
      budget: site.budget_totale != null ? String(site.budget_totale) : (sd.budget || ''),
      tipoAppalto: sd.tipoAppalto || '',
      responsabileLavori: sd.responsabileLavori || '',
      csp: sd.csp || '',
      cse: persona(sd.cse, sd.cseTel, sd.cseEmail, sd.cseCf),
      shiftStart: shift ? String(shift).slice(0, 5) : '',
      lunchMinutes: lunch,
    },
    impresa: sub
      ? { kind: 'subappaltatore', subcontractorId: sub.id, name: sub.company_name, vat: sub.piva || '', address: sub.legal_address || '', durcExpiry: sub.durc_expiry || null, contact: sub.contact_person || '' }
      : { kind: 'impresa', subcontractorId: null, name: company?.name || '', vat: company?.vat_number || company?.piva || '', address: [company?.address, company?.city].filter(Boolean).join(', ') },
    affidataria: { name: company?.name || '', vat: company?.vat_number || company?.piva || '' },
    figures,
    figureSources,
    figureCandidates,
    figuresFromRegistry,
    figuresRemembered: !!ownLast,
    workers,
    otherWorkers,
    mezzi,
  };
}

module.exports = { buildPosPrefill, lastPosOf };
