'use strict';
/**
 * lib/imprese.js — F-376 (AUDIT.md del frontend): la pagina Imprese del titolare.
 *
 * Disegno approvato il 18/10 (tela «Palladia semplice», I1–I4 e N). In cima la
 * cosa da fare (l'impresa ha mandato dei documenti → guardali; un'impresa non
 * è in regola → chiedili); una riga per impresa con una frase sola; la scheda
 * risponde a una domanda: «Può lavorare nei tuoi cantieri?». Lo stato dei
 * documenti è quello di /documenti (documentiStato.statoImprese) più il POS
 * per cantiere e gli operai (lib/impreseLink.statoImpresa, lo stesso che vede
 * l'impresa dal suo link).
 */
const supabase = require('./supabase');
const { statoImprese } = require('./documentiStato');
const L = require('./impreseLink');
const { leggi, motivoItaliano } = require('./impreseControllo');

class ImpreseError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
// Mezzanotte di Roma (ora legale o solare)
function inizioOggi() {
  const off = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'GMT+1';
  const h = Number((off.match(/[+-]\d+/) || ['+1'])[0]);
  return new Date(`${oggiRoma()}T00:00:00${h >= 0 ? '+' : '-'}${String(Math.abs(h)).padStart(2, '0')}:00`).toISOString();
}
const motivo = (d) => { try { return d?.esito_motivo ? motivoItaliano(JSON.parse(d.esito_motivo)) : null; } catch { return null; } };

async function presenzeOggi(companyId, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from('sub_presenze').select('subcontractor_id, sub_worker_id, event, at')
    .eq('company_id', companyId).in('subcontractor_id', ids).is('annullata_at', null).gte('at', inizioOggi()).order('at');
  dbErr(error);
  // In cantiere = l'ultimo evento di oggi è un'entrata
  const ultimo = new Map();
  for (const p of data || []) ultimo.set(p.sub_worker_id, p);
  const per = new Map();
  for (const p of ultimo.values()) if (p.event === 'entrata') per.set(p.subcontractor_id, (per.get(p.subcontractor_id) || 0) + 1);
  return per;
}

async function contiDa(companyId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from('sub_conti').select('id, subcontractor_id, mese, stato, totale_scritto, totale_approvato, site_id, cantiere_testo, sites(name)')
    .eq('company_id', companyId).in('subcontractor_id', ids).order('mese', { ascending: false });
  dbErr(error);
  return data || [];
}

/** Una frase per impresa, come sulla tela: la cosa più importante e basta. */
function frase(st, oggi) {
  if (st.daVedere.length) return { testo: `Ha mandato ${st.daVedere.length === 1 ? 'un documento' : `${st.daVedere.length} documenti`}: guardali`, tono: 'blu' };
  const nonVa = [...st.requisiti, ...st.pos].filter(r => r.stato === 'non_va');
  if (nonVa.length) return { testo: `${nonVa[0].label}: non va`, tono: 'rosso' };
  if (st.mancano) return { testo: `Mancano ${st.mancano === 1 ? 'un documento' : `${st.mancano} documenti`}`, tono: 'rosso' };
  const presto = st.requisiti.find(r => r.stato === 'in_scadenza');
  if (presto) {
    const g = Math.round((Date.parse(`${presto.scadenza}T12:00:00Z`) - Date.parse(`${oggi}T12:00:00Z`)) / 86400000);
    return { testo: `${presto.label} scade ${g <= 0 ? 'oggi' : g === 1 ? 'domani' : `fra ${g} giorni`}`, tono: 'arancio' };
  }
  if (st.operaiNonOk) return { testo: `${st.operaiNonOk === 1 ? 'Un operaio' : `${st.operaiNonOk} operai`} senza visita o corso`, tono: 'arancio' };
  const durc = st.requisiti.find(r => r.key === 'durc');
  return { testo: `In regola${durc?.scadenza ? ` · DURC fino al ${new Date(`${durc.scadenza}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' })}` : ''}`, tono: 'verde' };
}

async function panoramica(companyId) {
  const stati = await statoImprese(companyId);
  const ids = stati.map(s => s.id);
  const [pres, conti, ...st] = await Promise.all([
    presenzeOggi(companyId, ids), contiDa(companyId, ids),
    ...stati.map(s => L.statoImpresa(companyId, { id: s.id, company_name: s.name }, s)),
  ]);
  const oggi = oggiRoma();
  const imprese = stati.map((s, i) => {
    const x = st[i];
    return {
      id: s.id, nome: s.row?.da_completare ? `Nuova impresa${s.row?.phone ? ` · ${s.row.phone}` : ''}` : s.name, daCompletare: !!s.row?.da_completare,
      frase: frase(x, oggi), puoLavorare: x.puoLavorare, mancano: x.mancano, daVedere: x.daVedere.length,
      oggiInCantiere: pres.get(s.id) || 0, cantieri: x.cantieri.map(c => c.nome),
      contiDaApprovare: conti.filter(c => c.subcontractor_id === s.id && c.stato === 'da_controllare').length,
    };
  });
  const peso = (m) => (m.daVedere ? 0 : !m.puoLavorare ? 1 : m.frase.tono === 'arancio' ? 2 : 3);
  imprese.sort((a, b) => peso(a) - peso(b) || a.nome.localeCompare(b.nome, 'it'));
  const p = imprese[0];
  const prima = !p ? null
    : p.daVedere ? { tipo: 'guardare', id: p.id, nome: p.nome, quanti: p.daVedere }
    : !p.puoLavorare ? { tipo: 'chiedere', id: p.id, nome: p.nome, mancano: p.mancano, cantieri: p.cantieri }
    : null;
  return { imprese, daSistemare: imprese.filter(m => peso(m) <= 1).length, prima };
}

async function impresaDellAzienda(companyId, id) {
  const { data, error } = await supabase.from('subcontractors').select('id, company_name, piva, legal_address, contact_person, phone, email, da_completare, durc_expiry, visura_date, insurance_expiry')
    .eq('id', id).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!data) throw new ImpreseError(404, 'NOT_FOUND');
  return data;
}

async function scheda(companyId, id) {
  const impresa = await impresaDellAzienda(companyId, id);
  const [st, link, pres, conti, siti, azienda, contratti] = await Promise.all([
    L.statoImpresa(companyId, impresa),
    supabase.from('sub_link').select('inviato_at, aperto_at').eq('subcontractor_id', id).is('revoked_at', null).maybeSingle(),
    presenzeOggi(companyId, [id]),
    contiDa(companyId, [id]),
    supabase.from('sites').select('id, name, address').eq('company_id', companyId).in('status', ['attivo', 'sospeso']).order('name'),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    // F-398: i contratti di subappalto fatti con lei
    supabase.from('contratti_subappalto').select('id, created_at, dati').eq('company_id', companyId).eq('subcontractor_id', id).order('created_at', { ascending: false }).limit(5),
  ]);
  dbErr(link.error); dbErr(siti.error); dbErr(contratti.error);
  const assegnati = new Set(st.cantieri.map(c => c.id));
  return {
    id, nome: impresa.da_completare ? 'Nuova impresa' : impresa.company_name, daCompletare: !!impresa.da_completare,
    piva: impresa.piva, indirizzo: impresa.legal_address, referente: impresa.contact_person, telefono: impresa.phone, email: impresa.email,
    azienda: azienda.data?.name || null,
    puoLavorare: st.puoLavorare, mancano: st.mancano,
    requisiti: st.requisiti.map(r => ({ ...r, motivo: r.motivo ? motivoItaliano(r.motivo) : null })),
    pos: st.pos.map(r => ({ ...r, motivo: r.motivo ? motivoItaliano(r.motivo) : null })),
    operai: st.operai.map(o => ({ ...o, idoneita: { ...o.idoneita, motivo: o.idoneita.motivo ? motivoItaliano(o.idoneita.motivo) : null }, formazione: { ...o.formazione, motivo: o.formazione.motivo ? motivoItaliano(o.formazione.motivo) : null } })),
    ricevuti: st.daVedere.map(d => ({ id: d.id, label: d.name, esito: d.esito, motivo: motivo(d), scadenza: d.valid_until, creato: d.created_at })),
    link: link.data ? { inviatoAt: link.data.inviato_at, apertoAt: link.data.aperto_at } : null,
    oggiInCantiere: pres.get(id) || 0,
    conti: conti.slice(0, 3).map(c => ({ id: c.id, mese: c.mese, stato: c.stato, totale: c.totale_approvato ?? c.totale_scritto, cantiere: c.sites?.name || c.cantiere_testo || null })),
    cantieriLiberi: (siti.data || []).filter(s => !assegnati.has(s.id)).map(s => ({ id: s.id, nome: s.name, indirizzo: s.address })),
    contratti: (contratti.data || []).map(c => ({ id: c.id, at: c.created_at, cantiere: c.dati?.lavoro?.cantiere || null })),
  };
}

/** Il link e il messaggio da mandare su WhatsApp o per email. */
async function chiedi(companyId, userId, id, { rifare } = {}) {
  const impresa = await impresaDellAzienda(companyId, id);
  const [link, st, az] = await Promise.all([
    L.linkImpresa(companyId, id, userId),
    L.statoImpresa(companyId, impresa),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ]);
  const azienda = az.data?.name || 'la nostra impresa';
  const daFare = [...st.requisiti.filter(r => !r.consigliata), ...st.pos].filter(r => r.stato !== 'ok' && r.stato !== 'in_scadenza');
  let testo;
  if (rifare) {
    const r = [...st.requisiti, ...st.pos].find(x => x.docId === rifare);
    testo = `Buongiorno, il documento «${r?.label || 'caricato'}» non va${r?.motivo ? `: ${motivoItaliano(r.motivo).toLowerCase()}` : ''}. Lo può ricaricare da qui, anche dal telefono: ${link.url}`;
  } else {
    const elenco = daFare.map(r => (r.key === 'dichiarazione' ? 'dichiarazione (gliela prepariamo noi, va solo firmata)' : r.label.toLowerCase())).join(', ');
    testo = `Buongiorno, sono di ${azienda}. Per lavorare nei nostri cantieri ci servono alcuni documenti${elenco ? ` (${elenco})` : ''} e i nomi dei vostri operai con visita medica e corso di sicurezza. Può caricare tutto da qui, anche dal telefono, senza registrarsi: ${link.url}`;
  }
  const tel = String(impresa.phone || '').replace(/[^\d+]/g, '').replace(/^00/, '+');
  const numero = tel ? (tel.startsWith('+') ? tel.slice(1) : tel.startsWith('3') ? `39${tel}` : tel) : '';
  return {
    url: link.url, testo,
    whatsapp: `https://wa.me/${numero}?text=${encodeURIComponent(testo)}`,
    email: impresa.email ? `mailto:${impresa.email}?subject=${encodeURIComponent(`Documenti per ${azienda}`)}&body=${encodeURIComponent(testo)}` : null,
  };
}

/** «Manda su WhatsApp» toccato: si segna quando, per dire «Link mandato ieri alle 18:20». */
async function inviato(companyId, id) {
  await impresaDellAzienda(companyId, id);
  await L.segnaInviato(companyId, id);
}

/** Il titolare ha guardato quello che ha mandato l'impresa. */
async function visti(companyId, id) {
  await impresaDellAzienda(companyId, id);
  const { error } = await supabase.from('subcontractor_documents').update({ visto_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('subcontractor_id', id).eq('dall_impresa', true).is('visto_at', null);
  dbErr(error);
}

/** «Va bene lo stesso»: il titolare decide sopra al controllo di Palladia. */
async function vaBene(companyId, docId) {
  const { data, error } = await supabase.from('subcontractor_documents').update({ esito: 'va_bene', esito_motivo: null, ai_validity_ok: true })
    .eq('id', docId).eq('company_id', companyId).select('id').maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!data) throw new ImpreseError(404, 'NOT_FOUND');
}

/** + Aggiungi impresa: nome e P.IVA, oppure il solo telefono (i dati li scrive lei dal link). */
async function crea(companyId, b) {
  const nome = String(b.nome || '').trim().slice(0, 160);
  const piva = String(b.piva || '').replace(/\D/g, '');
  const telefono = String(b.telefono || '').trim().slice(0, 40) || null;
  const email = String(b.email || '').trim().slice(0, 160) || null;
  if (piva && piva.length !== 11) throw new ImpreseError(400, 'PIVA_NON_VALIDA');
  if (nome.length < 2 && !telefono && !email) throw new ImpreseError(400, 'NOME_O_TELEFONO');
  if (piva) {
    const { data } = await supabase.from('subcontractors').select('id').eq('company_id', companyId).eq('piva', piva).eq('is_active', true).maybeSingle();
    if (data) throw Object.assign(new ImpreseError(409, 'IMPRESA_GIA_PRESENTE'), { id: data.id });
  }
  const daCompletare = nome.length < 2;
  const { data, error } = await supabase.from('subcontractors').insert({
    company_id: companyId, company_name: daCompletare ? `Nuova impresa${telefono ? ` · ${telefono}` : ''}` : nome,
    piva: piva || null, phone: telefono, email, legal_address: String(b.indirizzo || '').trim().slice(0, 200) || null,
    da_completare: daCompletare, notify_expiry: true,
  }).select('id').single();
  dbErr(error);
  if (b.siteId) await mettiInCantiere(companyId, data.id, b.siteId).catch(() => null);
  return data;
}

async function mettiInCantiere(companyId, id, siteId) {
  await impresaDellAzienda(companyId, id);
  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!site) throw new ImpreseError(400, 'SITE_NOT_FOUND');
  const { data: c } = await supabase.from('site_subcontractors').select('id').eq('site_id', siteId).eq('subcontractor_id', id).maybeSingle();
  if (c) return;
  const { error } = await supabase.from('site_subcontractors').insert({ company_id: companyId, site_id: siteId, subcontractor_id: id });
  dbErr(error);
}

/** Dalla foto di una visura o di un DURC: nome, partita IVA, sede. Non salva. */
async function leggiPerAggiungere(companyId, file, chiediModello) {
  const r = await leggi({ file, companyId, chiedi: chiediModello });
  let esistente = null;
  if (r.piva) {
    const { data } = await supabase.from('subcontractors').select('id, company_name').eq('company_id', companyId).eq('piva', r.piva).eq('is_active', true).maybeSingle();
    if (data) esistente = { id: data.id, nome: data.company_name };
  }
  return { nome: r.ragioneSociale, piva: r.piva, indirizzo: r.sede, tipo: r.tipo, esistente };
}

module.exports = { panoramica, scheda, chiedi, inviato, visti, vaBene, crea, mettiInCantiere, leggiPerAggiungere, ImpreseError };
