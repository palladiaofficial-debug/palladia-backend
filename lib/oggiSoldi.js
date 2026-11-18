'use strict';
/**
 * lib/oggiSoldi.js — F-510/F-511 (AUDIT.md del frontend, 18/11/2026).
 * I soldi che chiedono qualcosa al titolare, per le righe di Oggi (lib/oggi.js):
 *  - F-511: cantieri vicini alla fine lavori (entro 30 giorni, o finiti da meno di
 *    60) dove la manodopera non basta ancora per la congruità della Cassa Edile.
 *    La congruità si dimostra prima del saldo finale: l'avviso arriva prima, da solo;
 *  - F-510: quante fatture dei fornitori non sanno ancora di quale cantiere sono.
 * Solo owner e admin: sono paghe e soldi.
 */
const supabase = require('./supabase');
const { soldiCantiere } = require('./quantoRende');

const GIORNO = 86400000;

/** Cantieri da avvisare (puro): fine lavori fra -60 e +30 giorni da oggi, congruità sotto il 100%. */
function daAvvisare(cantieri, oggi) {
  const t = Date.parse(`${oggi}T12:00:00Z`);
  return cantieri.filter(c => {
    if (!c.congruita || !c.congruita.obbligatoria || c.congruita.percentuale >= 100 || !c.fine) return false;
    const giorni = Math.round((Date.parse(`${c.fine}T12:00:00Z`) - t) / GIORNO);
    return giorni <= 30 && giorni >= -60;
  });
}

async function avvisiSoldi(companyId, role, oggi) {
  if (!['owner', 'admin'].includes(role)) return null;
  // F-514: l'avviso Cassa Edile usa la stima del costo della manodopera: solo col flag quanto_rende
  const conto = await require('./featureFlags').isFeatureEnabled(companyId, 'quanto_rende');
  const [{ count: fatture }, { data: siti }] = await Promise.all([
    supabase.from('company_expenses').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).is('site_id', null).is('cantiere_scelto_at', null),
    supabase.from('sites').select('id, name, end_date')
      .eq('company_id', companyId).neq('status', 'eliminato')
      .not('budget_totale', 'is', null).not('congruita_categoria', 'is', null).not('end_date', 'is', null),
  ]);
  const t = Date.parse(`${oggi}T12:00:00Z`);
  const vicini = !conto ? [] : (siti || []).filter(s => Math.abs(Date.parse(`${s.end_date}T12:00:00Z`) - t) <= 60 * GIORNO);
  const conti = await Promise.all(vicini.map(async s => {
    const r = await soldiCantiere(companyId, s.id).catch(() => null);
    return r ? { siteId: s.id, nome: s.name, fine: s.end_date, congruita: r.congruita } : null;
  }));
  return {
    fattureSenzaCantiere: fatture || 0,
    congruita: daAvvisare(conti.filter(Boolean), oggi).map(c => ({ siteId: c.siteId, nome: c.nome, fine: c.fine, mancano: c.congruita.mancano })),
  };
}

module.exports = { avvisiSoldi, daAvvisare };
