'use strict';
/**
 * lib/impreseAvviso.js — F-377 (AUDIT.md del frontend): avvisare, non bloccare.
 *
 * Deciso dal titolare il 18/10: se entra in cantiere un operaio di un'impresa
 * che non è in regola (F-376: visura, DURC, DVR, dichiarazione, POS del
 * cantiere) o un operaio senza visita medica o corso, l'entrata si registra
 * come sempre e il titolare riceve un avviso. Stessa scelta di F-139 per i
 * dipendenti con un documento scaduto.
 *
 * Si chiama DOPO aver registrato l'entrata, a parte (subPresenze.segna): non
 * può rallentarla né farla fallire. Un avviso al giorno per impresa e cantiere
 * (notifications, entity_id = impresa:cantiere:giorno); chi entra dopo si
 * aggiunge ai nomi e l'avviso torna da leggere. Telegram solo la prima volta
 * del giorno.
 *
 * F-420 (schermata 4 del disegno «Pronta a lavorare»): l'avviso parla come
 * il disegno — «Paolo Neri è in Via Balbi, ma non può entrare · Ha timbrato
 * alle 7:40. Manca la sua visita medica» — e c'è anche il contrario:
 * avvisaSeOraPronta() quando un documento appena caricato fa passare
 * un'impresa da «non può entrare» a «può entrare».
 */
const supabase = require('./supabase');
const { statoImpresa } = require('./impreseLink');

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const ok = (s) => s === 'ok' || s === 'in_scadenza';
// «Visura camerale» → «visura camerale», ma le sigle restano: «DURC», «DVR»
const minuscola = (s) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

const ora = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).replace(/^0/, '');

/**
 * Puro: il testo dell'avviso, o null se non c'è niente da dire.
 * orari: { nome → ISO della prima entrata di oggi } (per «Ha timbrato alle 7:40»).
 */
function testoAvviso({ impresa, cantiere, nomi, stato, siteId, orari = {} }) {
  const mancaImpresa = stato.requisiti.filter(r => !r.consigliata && !ok(r.stato)).map(r => minuscola(r.label.split(' · ')[0]));
  const mancaPos = stato.pos.some(p => p.siteId === siteId && !ok(p.stato));
  const operai = nomi.map(n => {
    const o = stato.operai.find(x => x.nome.toLowerCase() === n.toLowerCase());
    if (!o) return null;
    const cosa = [!ok(o.idoneita.stato) && 'visita medica', !ok(o.formazione.stato) && 'corso di sicurezza'].filter(Boolean);
    return cosa.length ? { nome: o.nome, cosa } : null;
  }).filter(Boolean);
  if (!mancaImpresa.length && !mancaPos && !operai.length) return null;
  const timbrato = nomi.length === 1
    ? `Ha timbrato ${nomi[0]}${orari[nomi[0]] ? ` alle ${ora(orari[nomi[0]])}` : ''}.`
    : `Hanno timbrato ${nomi.join(', ')}.`;
  const coda = `L'entrata è registrata: non l'ho bloccat${nomi.length > 1 ? 'i' : 'o'}.`;
  if (mancaImpresa.length) {
    return {
      title: `${impresa} è in ${cantiere}, ma non può entrare`,
      body: [timbrato, `All'impresa manca: ${[...mancaImpresa, ...(mancaPos ? ['il POS di questo cantiere'] : [])].join(', ')}.`, operai.length ? `${operai.map(o => `${o.nome} senza ${o.cosa.join(' e ')}`).join('; ')}.` : null, coda].filter(Boolean).join(' '),
    };
  }
  if (operai.length === 1 && !mancaPos) {
    const o = operai[0];
    return {
      title: `${o.nome} è in ${cantiere}, ma non può entrare`,
      body: `Ha timbrato${orari[o.nome] ? ` alle ${ora(orari[o.nome])}` : ''}. Manca la sua ${o.cosa.join(' e il suo ').replace('il suo corso', 'il corso')}. ${coda}`,
    };
  }
  if (!operai.length) {
    return { title: `${impresa} è in ${cantiere}, ma manca il POS`, body: `${timbrato} Manca il POS di ${impresa} per questo cantiere. ${coda}` };
  }
  return {
    title: `${operai.length} operai di ${impresa} sono in ${cantiere} senza documenti`,
    body: [timbrato, `${operai.map(o => `${o.nome} senza ${o.cosa.join(' e ')}`).join('; ')}.`, mancaPos ? 'E manca il POS per questo cantiere.' : null, coda].filter(Boolean).join(' '),
  };
}

async function avvisaIngresso({ companyId, siteId, siteName, subcontractorId }) {
  const oggi = oggiRoma();
  const { data: impresa } = await supabase.from('subcontractors').select('id, company_name, da_completare').eq('id', subcontractorId).maybeSingle();
  if (!impresa) return null;
  const inizio = new Date(Date.now() - 20 * 3600e3).toISOString();
  const [stato, entrate] = await Promise.all([
    statoImpresa(companyId, impresa),
    supabase.from('sub_presenze').select('at, sub_workers(full_name)').eq('company_id', companyId).eq('subcontractor_id', subcontractorId)
      .eq('site_id', siteId).eq('event', 'entrata').is('annullata_at', null).gte('at', inizio).order('at'),
  ]);
  const diOggi = (entrate.data || []).filter(e => new Date(e.at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) === oggi && e.sub_workers?.full_name);
  const nomi = [...new Set(diOggi.map(e => e.sub_workers.full_name))];
  if (!nomi.length) return null;
  const orari = {};
  for (const e of diOggi) orari[e.sub_workers.full_name] ||= e.at;  // la prima entrata di oggi (sono in ordine)
  const nome = impresa.da_completare ? 'Un\'impresa nuova' : impresa.company_name;
  const testo = testoAvviso({ impresa: nome, cantiere: siteName, nomi, stato, siteId, orari });
  if (!testo) return null;

  const entityId = `${subcontractorId}:${siteId}:${oggi}`;
  const { data: c } = await supabase.from('notifications').select('id, body').eq('company_id', companyId)
    .eq('type', 'sub_non_in_regola').eq('entity_type', 'subcontractor').eq('entity_id', entityId).maybeSingle();
  if (c) {
    if (c.body === testo.body) return { id: c.id, nuovo: false };
    // Qualcuno in più è entrato: l'avviso si aggiorna e torna da leggere
    await supabase.from('notifications').update({ title: testo.title, body: testo.body, read_by: [], updated_at: new Date().toISOString() }).eq('id', c.id);
    return { id: c.id, nuovo: false };
  }
  const { data: n, error } = await supabase.from('notifications').insert({
    company_id: companyId, type: 'sub_non_in_regola', severity: 'warning',
    title: testo.title, body: testo.body, entity_type: 'subcontractor', entity_id: entityId,
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return null; // due entrate nello stesso istante: l'avviso c'è già
    throw new Error(error.message);
  }
  try {
    const { notifySubNonInRegola } = require('../services/telegramNotifications');
    await notifySubNonInRegola(companyId, siteId, testo.title, testo.body);
  } catch (e) { console.error('[impreseAvviso] telegram:', e.message); }
  return { id: n.id, nuovo: true };
}

/**
 * F-420: un documento appena caricato ha fatto passare l'impresa da «non può
 * entrare» a «può entrare» → un avviso azzurro su Oggi (uno al giorno per impresa).
 * `primaStato`: lo stato del verdetto prima del caricamento ('si' | 'no' | 'controllo').
 * Non deve mai far fallire il caricamento: gli errori si scrivono e basta.
 */
async function avvisaSeOraPronta(companyId, subcontractorId, primaStato) {
  try {
    if (primaStato === 'si') return null;
    const { data: impresa } = await supabase.from('subcontractors').select('id, company_name, da_completare').eq('id', subcontractorId).maybeSingle();
    if (!impresa || impresa.da_completare) return null;
    const st = await statoImpresa(companyId, impresa);
    if (st.verdetto.stato !== 'si') return null;
    const entityId = `${subcontractorId}:${oggiRoma()}`;
    const { data: c } = await supabase.from('notifications').select('id').eq('company_id', companyId).eq('type', 'sub_ora_pronta').eq('entity_id', entityId).maybeSingle();
    if (c) return { id: c.id, nuovo: false };
    const operaiNo = st.verdetto.operai.totale - st.verdetto.operai.possono;
    const { data: n, error } = await supabase.from('notifications').insert({
      company_id: companyId, type: 'sub_ora_pronta', severity: 'info', entity_type: 'subcontractor', entity_id: entityId,
      title: `${impresa.company_name} ora può entrare`,
      body: `Hanno mandato quello che mancava: ho controllato, va bene${operaiNo ? ` · ${operaiNo === 1 ? '1 operaio non ancora' : `${operaiNo} operai non ancora`}` : ''}`,
    }).select('id').single();
    if (error) { if (error.code !== '23505') console.error('[impreseAvviso] ora pronta:', error.message); return null; }
    return { id: n.id, nuovo: true };
  } catch (e) { console.error('[impreseAvviso] ora pronta:', e.message); return null; }
}

module.exports = { avvisaIngresso, testoAvviso, avvisaSeOraPronta };
