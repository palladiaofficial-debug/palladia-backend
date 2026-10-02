'use strict';
// ── Figure della sicurezza per il POS dell'impresa (F-263, AUDIT.md frontend) ─
// Tutto quello che Palladia sa già, ognuna con la sua fonte, in quest'ordine:
//  1. registro dell'azienda (company_safety_figures, "ricorda per i prossimi POS");
//  2. documenti aziendali (attestato RSPP, RLS, nomina medico) e attestati dei
//     lavoratori (primo soccorso, antincendio, preposto) ancora validi;
//  3. ultimo POS dell'azienda;
//  4. per il datore di lavoro: il titolare dell'account.
// I documenti vengono prima dell'ultimo POS: un POS fatto con dati sbagliati
// non deve diventare la verità per i successivi (caso MSCedilizia, 27/09).
const supabase = require('./supabase');

const FIG_KEYS = ['datoreLavoro', 'rspp', 'rls', 'medicoCompetente', 'prepostoCantiere', 'addettoPrimoSoccorso', 'addettoAntincendio', 'direttoreTecnico'];
const persona = (nome = '', tel = '', email = '', cf = '') => ({ nome: nome || '', telefono: tel || '', email: email || '', codiceFiscale: cf || '' });

// Parole che precedono o seguono il nome nel titolo di un attestato o di una
// nomina ("ATTESTATO AGG. RSPP R.A. CATALANO ARIANNA.pdf").
const STOP = new Set([
  'attestato', 'attestati', 'agg', 'aggiornamento', 'corso', 'nomina', 'nominato', 'lettera', 'incarico', 'designazione',
  'rspp', 'rls', 'rlst', 'aspp', 'medico', 'competente', 'ra', 'rspp/aspp', 'del', 'della', 'per', 'il', 'la', 'copia',
  'firmato', 'firmata', 'scansione', 'verbale', 'elezione', 'rev', 'n', 'mc', 'primo', 'soccorso', 'preposto', 'antincendio',
  'formazione', 'ore', 'h', 'pdf', 'doc', 'ddl', 'datore', 'lavoro', 'sig', 'dott', 'dr', 'ing', 'geom', 'arch',
]);
const clean = (t) => t.toLowerCase().replace(/[.,;:()[\]]/g, '');
const isDate = (t) => /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t) || /^\d{4,8}$/.test(t);

/** Nome e cognome dal titolo del file, o null se non c'è un nome credibile. */
function nameFromDocName(fileName) {
  if (!fileName) return null;
  const toks = String(fileName).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').split(/\s+/).filter(Boolean);
  let a = 0, b = toks.length;
  while (a < b && (STOP.has(clean(toks[a])) || isDate(toks[a]) || clean(toks[a]) === '')) a++;
  while (b > a && (STOP.has(clean(toks[b - 1])) || isDate(toks[b - 1]) || clean(toks[b - 1]) === '')) b--;
  const name = toks.slice(a, b);
  if (name.length < 2 || name.length > 4) return null;
  if (!name.every(t => /^[A-Za-zÀ-ÿ'’]+$/.test(t))) return null;
  return name.map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join(' ');
}

const fmt = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

function figuresFromPos(d) {
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

async function ownerName(companyId) {
  try {
    const { data } = await supabase.from('company_users').select('user_id').eq('company_id', companyId).eq('role', 'owner').limit(1).maybeSingle();
    if (!data?.user_id) return '';
    const { data: u } = await supabase.auth.admin.getUserById(data.user_id);
    return (u?.user?.user_metadata?.full_name || '').trim();
  } catch { return ''; }
}

/** Lavoratori dell'impresa (non dei subappaltatori) con un attestato valido del tipo indicato. */
function candidatesFrom(certs, re, siteWorkerIds, today) {
  const best = new Map();
  for (const c of certs) {
    if (!re.test(c.corso)) continue;
    if (c.expiry && c.expiry < today) continue;
    const prev = best.get(c.workerId);
    if (!prev || (c.expiry || '9999') > (prev.scadenza || '9999')) {
      best.set(c.workerId, { workerId: c.workerId, nome: c.nome, scadenza: c.expiry || null, inCantiere: siteWorkerIds.has(c.workerId) });
    }
  }
  return [...best.values()].sort((x, y) => (y.inCantiere - x.inCantiere) || x.nome.localeCompare(y.nome, 'it'));
}

/**
 * @returns {{ figures, sources, candidati, registro: boolean }}
 *   sources[k] = { tipo: 'registro'|'documento'|'attestato'|'pos'|'azienda'|'account', testo } | null
 */
async function figureSuggestions(companyId, siteId, { company = null, lastPos = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [regRes, docsRes, certsRes, siteWkRes, owner] = await Promise.all([
    supabase.from('company_safety_figures').select('figures, updated_at').eq('company_id', companyId).maybeSingle(),
    supabase.from('company_documents').select('name, category, created_at').eq('company_id', companyId)
      .in('category', ['rspp', 'rls', 'medico_competente']).order('created_at', { ascending: false }),
    supabase.from('worker_certificates').select('worker_id, expiry_date, course_types(name), workers(full_name, is_active, subcontractor_id)')
      .eq('company_id', companyId).is('deleted_at', null),
    siteId ? supabase.from('worksite_workers').select('worker_id').eq('site_id', siteId).eq('status', 'active') : Promise.resolve({ data: [] }),
    ownerName(companyId),
  ]);

  const reg = regRes.data?.figures || null;
  const docs = docsRes.data || [];
  const certs = (certsRes.data || [])
    .filter(c => c.workers && c.workers.is_active !== false && !c.workers.subcontractor_id)
    .map(c => ({ workerId: c.worker_id, nome: c.workers.full_name, corso: c.course_types?.name || '', expiry: c.expiry_date }));
  const siteWorkerIds = new Set((siteWkRes.data || []).map(w => w.worker_id));
  const fromPos = figuresFromPos(lastPos?.pos_data);
  const posDate = lastPos?.created_at ? fmt(lastPos.created_at.slice(0, 10)) : '';

  const candidati = {
    addettoPrimoSoccorso: candidatesFrom(certs, /primo soccorso/i, siteWorkerIds, today),
    addettoAntincendio: candidatesFrom(certs, /antincendio/i, siteWorkerIds, today),
    prepostoCantiere: candidatesFrom(certs, /preposto/i, siteWorkerIds, today),
  };
  const docName = (cat) => {
    for (const d of docs.filter(x => x.category === cat)) {
      const n = nameFromDocName(d.name);
      if (n) return { nome: n, file: d.name };
    }
    return null;
  };
  const docLabel = { rspp: 'attestato RSPP', rls: 'attestato RLS', medico_competente: 'nomina del medico competente' };

  const figures = {};
  const sources = {};
  const set = (k, p, src) => { figures[k] = p; sources[k] = src; };

  for (const k of FIG_KEYS) {
    const r = reg && reg[k];
    if (r && r.nome && String(r.nome).trim()) {
      set(k, persona(r.nome, r.telefono, r.email, r.codiceFiscale), { tipo: 'registro', testo: 'Figura ricordata dall’azienda' });
      continue;
    }
    const posP = fromPos && fromPos[k] && fromPos[k].nome ? fromPos[k] : null;
    const viaPos = () => set(k, posP, { tipo: 'pos', testo: `Dall’ultimo POS${posDate ? ` (${posDate})` : ''}` });
    const cat = { rspp: 'rspp', rls: 'rls', medicoCompetente: 'medico_competente' }[k];
    const fromDoc = cat ? docName(cat) : null;
    const cand = candidati[k] && candidati[k][0];

    if (fromDoc) {
      // Recapiti dall'ultimo POS solo se è la stessa persona
      const same = posP && posP.nome.toLowerCase().split(/\s+/).sort().join(' ') === fromDoc.nome.toLowerCase().split(/\s+/).sort().join(' ');
      set(k, same ? { ...posP, nome: fromDoc.nome } : persona(fromDoc.nome), { tipo: 'documento', testo: `Dall’${docLabel[cat]} nei documenti dell’azienda` });
    } else if (k === 'rspp' && company?.safety_manager) {
      set(k, persona(company.safety_manager), { tipo: 'azienda', testo: 'Dal profilo dell’azienda' });
    } else if ((k === 'addettoPrimoSoccorso' || k === 'addettoAntincendio') && cand) {
      set(k, persona(cand.nome), { tipo: 'attestato', testo: `Attestato ${k === 'addettoPrimoSoccorso' ? 'primo soccorso' : 'antincendio'} valido${cand.scadenza ? ` fino al ${fmt(cand.scadenza)}` : ''}` });
    } else if (posP) {
      viaPos();
    } else if (k === 'prepostoCantiere' && cand) {
      set(k, persona(cand.nome), { tipo: 'attestato', testo: `Attestato preposto valido${cand.scadenza ? ` fino al ${fmt(cand.scadenza)}` : ''}` });
    } else if (k === 'datoreLavoro' && owner) {
      set(k, persona(owner), { tipo: 'account', testo: 'Titolare dell’azienda in Palladia' });
    } else if (k === 'medicoCompetente' && docs.some(d => d.category === 'medico_competente')) {
      set(k, persona(), { tipo: 'manca', testo: 'La nomina è nei documenti, ma senza il nome: scrivilo una volta e lo ricordo' });
    } else {
      set(k, persona(), null);
    }
  }
  return { figures, sources, candidati, registro: !!reg };
}

/** Salva il registro dell'azienda (solo chiavi note, testi accorciati). */
async function saveRegistry(companyId, userId, input) {
  const out = {};
  for (const k of FIG_KEYS) {
    const p = input && input[k];
    if (!p || typeof p !== 'object') continue;
    const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const nome = s(p.nome, 200);
    if (!nome) continue;
    out[k] = { nome, telefono: s(p.telefono, 50), email: s(p.email, 200), codiceFiscale: s(p.codiceFiscale, 32) };
  }
  const { error } = await supabase.from('company_safety_figures')
    .upsert({ company_id: companyId, figures: out, updated_by: userId || null, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
  if (error) throw error;
  return out;
}

module.exports = { figureSuggestions, saveRegistry, nameFromDocName, FIG_KEYS };
