'use strict';
/**
 * lib/impreseLink.js — F-376 (AUDIT.md del frontend): il link che riceve l'impresa.
 *
 * Disegno approvato il 18/10 (tela «Palladia semplice», I5–I7). L'impresa apre
 * il link dal telefono, senza registrarsi, e vede SOLO le sue cose: i documenti
 * che le chiede l'impresa principale (quello che c'è, quello che manca, quello
 * che non va e perché), i suoi operai con visita medica e corso. Carica una
 * foto o un file per ogni richiesta; Palladia lo controlla subito
 * (lib/impreseControllo.js) e le dice se va bene.
 *
 * Il link è uno per impresa e resta sempre lo stesso: l'impresa lo tiene per la
 * prossima volta. Nel DB c'è solo l'hash; il token è HMAC(segreto, id del link)
 * e il server lo ricalcola quando il titolare lo rimanda.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { scheda: schedaDocumenti } = require('./documentiStato');
const { controlla, NOMI } = require('./impreseControllo');

const BUCKET = 'site-documents';
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const RICHIESTE = ['durc', 'visura', 'dvr', 'dichiarazione', 'assicurazione'];
const CATEGORIA = { durc: 'durc', visura: 'visura', dvr: 'dvr', dichiarazione: 'dichiarazione_art14', assicurazione: 'insurance', pos: 'pos' };
const ETICHETTA = { durc: 'DURC', visura: 'Visura camerale', dvr: 'DVR o autocertificazione', dichiarazione: 'Dichiarazione che non è sospesa', assicurazione: 'Assicurazione RC', pos: 'POS' };

class LinkError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function segreto() {
  const s = process.env.PIN_SIGNING_SECRET;
  if (!s) throw new Error('PIN_SIGNING_SECRET mancante');
  return s;
}
const tokenDi = (linkId) => crypto.createHmac('sha256', segreto()).update(`impresa-link:${linkId}`).digest('base64url');
const base = () => (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const in30 = () => { const d = new Date(`${oggiRoma()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); };

/** Il link dell'impresa (lo crea la prima volta). Sempre lo stesso URL. */
async function linkImpresa(companyId, subcontractorId, userId) {
  const { data: sub, error } = await supabase.from('subcontractors').select('id').eq('id', subcontractorId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  dbErr(error);
  if (!sub) throw new LinkError(404, 'NOT_FOUND');
  let { data: link } = await supabase.from('sub_link').select('id, inviato_at, aperto_at').eq('subcontractor_id', subcontractorId).is('revoked_at', null).maybeSingle();
  if (!link) {
    const id = crypto.randomUUID();
    const ins = await supabase.from('sub_link').insert({ id, company_id: companyId, subcontractor_id: subcontractorId, token_hash: hash(tokenDi(id)), created_by: userId || null })
      .select('id, inviato_at, aperto_at').single();
    dbErr(ins.error);
    link = ins.data;
  }
  return { id: link.id, url: `${base()}/impresa/${tokenDi(link.id)}`, inviatoAt: link.inviato_at, apertoAt: link.aperto_at };
}

async function segnaInviato(companyId, subcontractorId) {
  const { error } = await supabase.from('sub_link').update({ inviato_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('subcontractor_id', subcontractorId).is('revoked_at', null);
  dbErr(error);
}

/** Dal token al link vivo, all'impresa e all'azienda che chiede. */
async function daToken(token) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(String(token || ''))) throw new LinkError(404, 'LINK_NON_VALIDO');
  const { data: link, error } = await supabase.from('sub_link').select('id, company_id, subcontractor_id, revoked_at, aperto_at')
    .eq('token_hash', hash(token)).maybeSingle();
  dbErr(error);
  if (!link || link.revoked_at) throw new LinkError(404, 'LINK_NON_VALIDO');
  const [s, c] = await Promise.all([
    supabase.from('subcontractors').select('id, company_name, piva, legal_address, contact_person, phone, email, da_completare, is_active').eq('id', link.subcontractor_id).maybeSingle(),
    supabase.from('companies').select('id, name').eq('id', link.company_id).maybeSingle(),
  ]);
  dbErr(s.error); dbErr(c.error);
  if (!s.data || !s.data.is_active || !c.data) throw new LinkError(404, 'LINK_NON_VALIDO');
  return { link, impresa: s.data, azienda: c.data };
}

const statoData = (scadenza) => (!scadenza ? 'ok' : scadenza < oggiRoma() ? 'scaduto' : scadenza <= in30() ? 'in_scadenza' : 'ok');

/** I cantieri attivi dove lavora l'impresa (per il POS). */
async function cantieriImpresa(companyId, subcontractorId) {
  const { data, error } = await supabase.from('site_subcontractors').select('site_id, sites(id, name, address, status)')
    .eq('company_id', companyId).eq('subcontractor_id', subcontractorId);
  dbErr(error);
  const visti = new Set();
  return (data || []).filter(r => r.sites && ['attivo', 'sospeso'].includes(r.sites.status) && !visti.has(r.site_id) && visti.add(r.site_id))
    .map(r => ({ id: r.sites.id, nome: r.sites.name, indirizzo: r.sites.address || null }));
}

/**
 * Lo stato di ogni richiesta, uguale per il titolare (lib/imprese.js) e per l'impresa.
 * stato: ok | in_scadenza | scaduto | manca | non_va | da_guardare
 */
async function statoImpresa(companyId, impresa, giaCalcolato) {
  const [s, docs, cantieri, operai] = await Promise.all([
    giaCalcolato !== undefined ? giaCalcolato : schedaDocumenti(companyId, 'subappaltatori', impresa.id),
    supabase.from('subcontractor_documents').select('id, category, site_id, name, valid_until, esito, esito_motivo, dall_impresa, visto_at, created_at, file_path, mime_type')
      .eq('company_id', companyId).eq('subcontractor_id', impresa.id).order('created_at', { ascending: false }),
    cantieriImpresa(companyId, impresa.id),
    supabase.from('sub_workers').select('id, full_name, added_via, created_at').eq('company_id', companyId).eq('subcontractor_id', impresa.id).is('deactivated_at', null).order('full_name'),
  ]);
  dbErr(docs.error); dbErr(operai.error);
  const tutti = docs.data || [];
  const ultimo = (cat, siteId) => tutti.find(d => d.category === cat && (siteId === undefined || d.site_id === siteId)) || null;
  const motivo = (d) => { try { return d?.esito_motivo ? JSON.parse(d.esito_motivo) : null; } catch { return null; } };

  const requisiti = RICHIESTE.map(key => {
    const r = s?.requirements.find(x => x.key === key);
    const u = ultimo(CATEGORIA[key]);
    let stato = !r ? 'manca' : r.state === 'in_regola' ? 'ok' : r.state;
    // L'ultimo foglio mandato decide se «non va» o «da guardare», finché non ne arriva uno buono
    if (stato !== 'ok' && stato !== 'in_scadenza' && u) stato = u.esito === 'non_va' ? 'non_va' : u.esito === null && u.dall_impresa ? 'da_guardare' : stato;
    return {
      key, label: ETICHETTA[key], stato, scadenza: r?.expiry || null, consigliata: key === 'assicurazione',
      motivo: stato === 'non_va' ? motivo(u) : null, docId: u?.id || null, doc: r?.doc || null,
    };
  });
  const pos = cantieri.map(c => {
    const u = ultimo('pos', c.id);
    const stato = !u ? 'manca' : u.esito === 'non_va' ? 'non_va' : u.esito === null && u.dall_impresa ? 'da_guardare' : 'ok';
    return { key: 'pos', siteId: c.id, cantiere: c.nome, indirizzo: c.indirizzo, label: `POS per ${c.nome}`, stato, scadenza: null, motivo: stato === 'non_va' ? motivo(u) : null, docId: u?.id || null };
  });

  const ids = (operai.data || []).map(o => o.id);
  const { data: dOp, error: eOp } = ids.length
    ? await supabase.from('sub_worker_documenti').select('id, sub_worker_id, tipo, scadenza, esito, esito_motivo, created_at').in('sub_worker_id', ids).order('created_at', { ascending: false })
    : { data: [], error: null };
  dbErr(eOp);
  const docOperaio = (id, tipo) => {
    const u = (dOp || []).find(d => d.sub_worker_id === id && d.tipo === tipo);
    if (!u) return { stato: 'manca', scadenza: null, motivo: null };
    if (u.esito === 'non_va') return { stato: 'non_va', scadenza: u.scadenza, motivo: motivo(u) };
    return { stato: u.esito === null ? 'da_guardare' : statoData(u.scadenza), scadenza: u.scadenza, motivo: null };
  };
  const lista = (operai.data || []).map(o => ({ id: o.id, nome: o.full_name, idoneita: docOperaio(o.id, 'idoneita'), formazione: docOperaio(o.id, 'formazione') }));

  const obbligatori = [...requisiti.filter(r => !r.consigliata), ...pos];
  const mancano = obbligatori.filter(r => r.stato !== 'ok' && r.stato !== 'in_scadenza');
  const operaiNonOk = lista.filter(o => [o.idoneita, o.formazione].some(d => d.stato !== 'ok' && d.stato !== 'in_scadenza'));
  const futuri = [...requisiti, ...lista.flatMap(o => [o.idoneita, o.formazione])].filter(x => x.scadenza && x.scadenza >= oggiRoma()).sort((a, b) => a.scadenza.localeCompare(b.scadenza));
  return {
    requisiti, pos, operai: lista, cantieri,
    mancano: mancano.length, operaiNonOk: operaiNonOk.length,
    puoLavorare: mancano.length === 0,
    prossima: futuri[0] ? { label: futuri[0].label || null, scadenza: futuri[0].scadenza } : null,
    daVedere: tutti.filter(d => d.dall_impresa && !d.visto_at),
  };
}

/** Quello che vede l'impresa aprendo il link. */
async function datiPubblici(token) {
  const { link, impresa, azienda } = await daToken(token);
  if (!link.aperto_at) await supabase.from('sub_link').update({ aperto_at: new Date().toISOString() }).eq('id', link.id);
  const st = await statoImpresa(link.company_id, impresa);
  const pubblica = ({ key, siteId, cantiere, label, stato, scadenza, motivo, consigliata }) => ({ key, siteId: siteId || null, cantiere: cantiere || null, label, stato, scadenza, motivo, consigliata: !!consigliata });
  return {
    azienda: azienda.name,
    impresa: { nome: impresa.da_completare ? null : impresa.company_name, piva: impresa.piva, indirizzo: impresa.legal_address, referente: impresa.contact_person, telefono: impresa.phone, email: impresa.email, daCompletare: !!impresa.da_completare },
    richieste: [...st.requisiti, ...st.pos].map(pubblica),
    operai: st.operai,
    prossima: st.prossima,
    tuttoInviato: st.mancano === 0 && st.operaiNonOk === 0,
  };
}

const sicuro = (n) => String(n || 'documento').normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80);
function controllaFile(file) {
  if (!file?.buffer) throw new LinkError(400, 'FILE_REQUIRED');
  if (!ALLOWED.includes(file.mimetype)) throw new LinkError(400, 'INVALID_FILE_TYPE');
}

/** L'impresa carica un documento per una richiesta: si controlla e si salva, anche se non va (il titolare lo vede). */
async function caricaDaImpresa(token, { tipo, siteId, file }, chiedi) {
  const { link, impresa } = await daToken(token);
  return caricaPer({ companyId: link.company_id, impresa, tipo, siteId, file, chiedi, dallImpresa: true });
}

/** Lo stesso caricamento dal titolare (un foglio arrivato su carta o per email): stesso controllo, già «visto». */
async function caricaDalTitolare(companyId, userId, subcontractorId, { tipo, siteId, file }, chiedi) {
  const { data: impresa, error } = await supabase.from('subcontractors').select('id, company_name, piva, da_completare')
    .eq('id', subcontractorId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  dbErr(error);
  if (!impresa) throw new LinkError(404, 'NOT_FOUND');
  return caricaPer({ companyId, impresa, tipo, siteId, file, chiedi, dallImpresa: false, userId });
}

async function caricaPer({ companyId, impresa, tipo, siteId, file, chiedi, dallImpresa, userId = null }) {
  const link = { company_id: companyId };
  controllaFile(file);
  if (![...RICHIESTE, 'pos'].includes(tipo)) throw new LinkError(400, 'TIPO_NON_VALIDO');
  let cantiere = null;
  if (tipo === 'pos') {
    cantiere = (await cantieriImpresa(link.company_id, impresa.id)).find(c => c.id === siteId);
    if (!cantiere) throw new LinkError(400, 'CANTIERE_NON_VALIDO');
  }
  const esito = await controlla({ atteso: tipo, file, companyId: link.company_id, chiedi,
    ctx: { impresa: { nome: impresa.da_completare ? null : impresa.company_name, piva: impresa.piva }, cantiere } });
  const path = `${link.company_id}/subcontractors/${impresa.id}/${crypto.randomUUID()}-${sicuro(file.originalname)}`;
  const up = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (up.error) throw new Error(up.error.message);
  const ins = await supabase.from('subcontractor_documents').insert({
    company_id: link.company_id, subcontractor_id: impresa.id, site_id: cantiere?.id || null,
    name: cantiere ? `POS · ${cantiere.nome}` : ETICHETTA[tipo], category: CATEGORIA[tipo],
    file_path: path, file_size: file.size || file.buffer.length, mime_type: file.mimetype,
    valid_until: esito.esito === 'va_bene' ? esito.scadenza : null,
    ai_validity_ok: esito.esito === 'non_va' ? false : esito.esito === 'va_bene' ? true : null,
    ai_analyzed_at: new Date().toISOString(),
    dall_impresa: dallImpresa, visto_at: dallImpresa ? null : new Date().toISOString(), uploaded_by: userId,
    esito: esito.esito, esito_motivo: esito.motivo ? JSON.stringify(esito.motivo) : null,
  }).select('id').single();
  if (ins.error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(ins.error.message); }
  // Un documento buono porta avanti la data sull'impresa (mai indietro): avvisi e Documenti la vedono
  if (esito.esito === 'va_bene') {
    const campo = tipo === 'durc' ? ['durc_expiry', esito.scadenza] : tipo === 'visura' ? ['visura_date', esito.letto?.dataDocumento] : tipo === 'assicurazione' ? ['insurance_expiry', esito.scadenza] : null;
    if (campo && campo[1]) {
      const { data: row } = await supabase.from('subcontractors').select(campo[0]).eq('id', impresa.id).maybeSingle();
      if (!row?.[campo[0]] || String(row[campo[0]]) < campo[1]) await supabase.from('subcontractors').update({ [campo[0]]: campo[1] }).eq('id', impresa.id);
    }
  }
  return { id: ins.data.id, esito: esito.esito, motivo: esito.motivo, scadenza: esito.scadenza };
}

/** L'impresa scrive i suoi dati (quando è stata aggiunta col solo telefono, o per correggerli). */
async function salvaDati(token, b) {
  const { impresa } = await daToken(token);
  const t = (v, n) => (v === undefined ? undefined : String(v || '').trim().slice(0, n) || null);
  const patch = {};
  const nome = t(b.nome, 160); if (nome !== undefined && nome && nome.length >= 2) patch.company_name = nome;
  const piva = b.piva === undefined ? undefined : String(b.piva || '').replace(/\D/g, '');
  if (piva !== undefined) { if (piva && piva.length !== 11) throw new LinkError(400, 'PIVA_NON_VALIDA'); patch.piva = piva || null; }
  for (const [k, col, n] of [['indirizzo', 'legal_address', 200], ['referente', 'contact_person', 120], ['telefono', 'phone', 40], ['email', 'email', 160]]) {
    const v = t(b[k], n); if (v !== undefined) patch[col] = v;
  }
  const nomeFinale = patch.company_name || (impresa.da_completare ? null : impresa.company_name);
  const pivaFinale = patch.piva !== undefined ? patch.piva : impresa.piva;
  if (impresa.da_completare && nomeFinale && pivaFinale) patch.da_completare = false;
  if (!Object.keys(patch).length) return;
  const { error } = await supabase.from('subcontractors').update(patch).eq('id', impresa.id);
  dbErr(error);
}

async function aggiungiOperaio(token, { nome }) {
  const { link, impresa } = await daToken(token);
  const n = String(nome || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (n.length < 3 || !/\s/.test(n)) throw new LinkError(400, 'NOME_E_COGNOME');
  const { data, error } = await supabase.from('sub_workers').insert({ company_id: link.company_id, subcontractor_id: impresa.id, full_name: n, added_via: 'link' }).select('id').single();
  dbErr(error);
  return data;
}

async function caricaOperaio(token, operaioId, { tipo, file }, chiedi) {
  const { link, impresa } = await daToken(token);
  controllaFile(file);
  if (!['idoneita', 'formazione'].includes(tipo)) throw new LinkError(400, 'TIPO_NON_VALIDO');
  const { data: op, error } = await supabase.from('sub_workers').select('id, full_name').eq('id', operaioId).eq('subcontractor_id', impresa.id).is('deactivated_at', null).maybeSingle();
  dbErr(error);
  if (!op) throw new LinkError(404, 'OPERAIO_NON_TROVATO');
  const esito = await controlla({ atteso: tipo, file, companyId: link.company_id, chiedi, ctx: { operaio: { nome: op.full_name } } });
  const path = `${link.company_id}/sub_workers/${op.id}/${crypto.randomUUID()}-${sicuro(file.originalname)}`;
  const up = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (up.error) throw new Error(up.error.message);
  const ins = await supabase.from('sub_worker_documenti').insert({
    company_id: link.company_id, sub_worker_id: op.id, tipo, scadenza: esito.scadenza, file_path: path, mime_type: file.mimetype,
    dall_impresa: true, esito: esito.esito, esito_motivo: esito.motivo ? JSON.stringify(esito.motivo) : null,
  }).select('id').single();
  if (ins.error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(ins.error.message); }
  return { id: ins.data.id, esito: esito.esito, motivo: esito.motivo, scadenza: esito.scadenza };
}

module.exports = {
  linkImpresa, segnaInviato, daToken, datiPubblici, statoImpresa, cantieriImpresa,
  caricaDaImpresa, caricaDalTitolare, salvaDati, aggiungiOperaio, caricaOperaio,
  LinkError, ETICHETTA, NOMI, BUCKET, _tokenDi: tokenDi,
};
