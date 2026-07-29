'use strict';
/**
 * services/studioMonthlyReport.js
 *
 * Layer "proof of value" — step 5: versione aggregata per lo studio CDL del
 * report mensile impresa (services/monthlyValueReport.js). Riusa
 * buildMonthlyReportData PER OGNI CLIENTE — stessi numeri, stessa logica di
 * verifica, mai un secondo calcolo indipendente che potrebbe disallinearsi
 * da quello che il singolo cliente vede sul proprio report.
 *
 * Un'unica email va all'owner dello STUDIO (non ai singoli clienti — quello
 * lo fa già monthlyReportCron.js in autonomia per le imprese con un proprio
 * account). Il report è impaginato per poter essere inoltrato/condiviso dal
 * consulente con i propri clienti come prova del lavoro svolto.
 */

const supabase = require('../lib/supabase');
const { buildMonthlyReportData } = require('./monthlyValueReport');
const { sendStudioMonthlyValueReport } = require('./email');

async function buildStudioMonthlyReportData(studioId) {
  const { data: studio } = await supabase
    .from('studio_partners')
    .select('id, studio_name, user_id')
    .eq('id', studioId).maybeSingle();

  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name)')
    .eq('studio_id', studioId).eq('status', 'active');

  if (!clients?.length) return null;

  const perClient = await Promise.all(clients.map(async (c) => {
    try {
      const d = await buildMonthlyReportData(c.company_id);
      return { companyId: c.company_id, companyName: c.companies?.name || d.companyName, ...d };
    } catch (e) {
      console.error(`[studioMonthlyReport] errore company ${c.company_id}:`, e.message);
      return null;
    }
  }));
  const valid = perClient.filter(Boolean);
  if (!valid.length) return null;

  let oreNelMese = 0, documentiNelMese = 0, scadenzeNelMese = 0, sanzioniNelMeseCents = 0;
  const semaforoCounts = { verde: 0, giallo: 0, rosso: 0 };
  const allUpcoming = [];

  for (const c of valid) {
    oreNelMese            += c.stats.oreNelMese;
    documentiNelMese       += c.stats.documentiNelMese;
    scadenzeNelMese        += c.stats.scadenzeNelMese;
    sanzioniNelMeseCents   += c.stats.sanzioniNelMeseCents;
    semaforoCounts[c.semaforo.semaforo] = (semaforoCounts[c.semaforo.semaforo] || 0) + 1;
    for (const u of c.upcoming) allUpcoming.push({ ...u, companyName: c.companyName });
  }
  allUpcoming.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));

  return {
    studioId,
    studioName:     studio?.studio_name || 'Il tuo studio',
    studioUserId:   studio?.user_id,
    monthLabel:     valid[0].monthLabel,
    totalClients:   valid.length,
    semaforoCounts,
    stats: {
      oreNelMese:  Math.round(oreNelMese * 10) / 10,
      documentiNelMese, scadenzeNelMese, sanzioniNelMeseCents,
    },
    upcoming: allUpcoming.slice(0, 20),
    clients: valid
      .map(c => ({
        companyId: c.companyId, companyName: c.companyName, semaforo: c.semaforo.semaforo,
        oreNelMese: c.stats.oreNelMese, documentiNelMese: c.stats.documentiNelMese,
        scadenzeNelMese: c.stats.scadenzeNelMese, sanzioniNelMeseCents: c.stats.sanzioniNelMeseCents,
      }))
      .sort((a, b) => (b.scadenzeNelMese - a.scadenzeNelMese) || (b.documentiNelMese - a.documentiNelMese)),
  };
}

async function sendStudioMonthlyReportForStudio(studioId) {
  const data = await buildStudioMonthlyReportData(studioId);
  if (!data) return { sent: false, reason: 'no_clients' };

  const hasActivity = data.stats.oreNelMese > 0 || data.stats.documentiNelMese > 0 || data.stats.scadenzeNelMese > 0;
  if (!hasActivity) return { sent: false, reason: 'no_activity' };

  if (!data.studioUserId) return { sent: false, reason: 'no_owner' };
  const { data: { user: owner } } = await supabase.auth.admin.getUserById(data.studioUserId);
  if (!owner?.email) return { sent: false, reason: 'no_recipient' };

  await sendStudioMonthlyValueReport({ to: owner.email, ...data });
  return { sent: true };
}

module.exports = { buildStudioMonthlyReportData, sendStudioMonthlyReportForStudio };
