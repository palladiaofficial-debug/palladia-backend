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
 */
const supabase = require('./supabase');
const { statoImpresa } = require('./impreseLink');

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const ok = (s) => s === 'ok' || s === 'in_scadenza';
// «Visura camerale» → «visura camerale», ma le sigle restano: «DURC», «DVR»
const minuscola = (s) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** Puro: il testo dell'avviso, o null se non c'è niente da dire. */
function testoAvviso({ impresa, cantiere, nomi, stato, siteId }) {
  const mancano = [
    ...stato.requisiti.filter(r => !r.consigliata && !ok(r.stato)).map(r => minuscola(r.label)),
    ...stato.pos.filter(p => p.siteId === siteId && !ok(p.stato)).map(() => 'il POS di questo cantiere'),
  ];
  const operai = nomi.map(n => {
    const o = stato.operai.find(x => x.nome.toLowerCase() === n.toLowerCase());
    if (!o) return null;
    const cosa = [!ok(o.idoneita.stato) && 'visita medica', !ok(o.formazione.stato) && 'corso di sicurezza'].filter(Boolean);
    return cosa.length ? `${o.nome} senza ${cosa.join(' e ')}` : null;
  }).filter(Boolean);
  if (!mancano.length && !operai.length) return null;
  const parti = [`Oggi in ${cantiere}: ${nomi.join(', ')}.`];
  if (mancano.length) parti.push(`All'impresa mancano: ${mancano.join(', ')}.`);
  if (operai.length) parti.push(`${operai.join('; ')}.`);
  parti.push(`L'entrata è registrata: non l'ho bloccat${nomi.length > 1 ? 'i' : 'o'}.`);
  return {
    title: mancano.length ? `${impresa} è in cantiere ma non è in regola` : `${impresa}: in cantiere operai senza documenti`,
    body: parti.join(' '),
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
  const nomi = [...new Set((entrate.data || [])
    .filter(e => new Date(e.at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) === oggi)
    .map(e => e.sub_workers?.full_name).filter(Boolean))];
  if (!nomi.length) return null;
  const nome = impresa.da_completare ? 'Un\'impresa nuova' : impresa.company_name;
  const testo = testoAvviso({ impresa: nome, cantiere: siteName, nomi, stato, siteId });
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

module.exports = { avvisaIngresso, testoAvviso };
