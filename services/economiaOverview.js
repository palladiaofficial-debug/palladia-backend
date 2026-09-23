'use strict';
/**
 * services/economiaOverview.js
 *
 * F-215 (AUDIT.md): pagina "Economia" unificata — sostituisce come fonte dati
 * per la vista d'insieme le tre pagine separate di oggi (Economia cantieri,
 * Economia subappaltatori, Spese aziendali). Non introduce una quarta fonte
 * di verità: legge le stesse tabelle già reali e in uso (site_costs,
 * company_expenses, site_sal_history, site_subcontractors) — nessun dato dal
 * registro Controllo Economico (site_economia_movimenti, F-119), ancora
 * dietro flag e mai validato su un'azienda reale.
 *
 * Due soli numeri per livello (azienda o singolo cantiere), niente storico
 * "speso/incassato" in prima vista — deciso dopo un giro dal vivo sui dati
 * reali dell'azienda, che ha mostrato quanto la vecchia struttura (3 pagine,
 * fino a 4 sezioni impilate per cantiere) restasse in pratica inutilizzata:
 *
 *   da_incassare = quanto resta scoperto sull'ultimo SAL emesso per il
 *                  cantiere. `importo_maturato` è un CUMULATIVO (contratto ×
 *                  SAL% al momento dell'emissione, routes/v1/economia.js::
 *                  calcPnl) — mai un incremento. Sommare l'`importo_maturato`
 *                  di più SAL non pagati dello stesso cantiere (F-219,
 *                  AUDIT.md) conterebbe più volte lo stesso lavoro: il dovuto
 *                  reale è il maturato dell'ULTIMO SAL emesso, meno quanto già
 *                  incassato per davvero (i SAL precedenti segnati pagati).
 *   da_pagare    = fatture/altre spese aperte (site_costs + company_expenses,
 *                  pagato_il IS NULL) + saldo residuo verso i subappaltatori
 *                  (budget pattuito − acconti già dati, stesso identico
 *                  calcolo già in uso e verificato in
 *                  services/subcontractorEconomia.js — non ricalcolato qui
 *                  con una formula diversa che potrebbe disallinearsi).
 *
 * Un "acconto" (tipo='acconto') non è mai un debito aperto — per definizione
 * è denaro già dato — quindi è sempre escluso da da_pagare, sia per i
 * subappaltatori (già escluso dalla formula saldo_da_erogare) sia per
 * qualunque altro fornitore.
 */

const supabase = require('../lib/supabase');

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// F-219 (AUDIT.md): `site_sal_history.importo_maturato` è cumulativo (vedi
// calcPnl) — quanto resta scoperto per UN cantiere è il maturato dell'ultimo
// SAL emesso (per sal_number, l'unico ordine atomico/affidabile — le date di
// emissione possono coincidere) meno quanto già incassato davvero (le righe
// segnate pagate). Righe precedenti non pagate non si sommano: sono già
// interamente contenute nel cumulativo dell'ultima.
function netSalOwed(salRowsOneSite) {
  if (!salRowsOneSite.length) return { amount: 0, latestUnpaid: null };
  const sorted = [...salRowsOneSite].sort((a, b) => b.sal_number - a.sal_number);
  const latest = sorted[0];
  const giaIncassato = salRowsOneSite
    .filter(s => s.pagato_il)
    .reduce((s, r) => s + Number(r.importo_maturato || 0), 0);
  const amount = round2(Math.max(0, Number(latest.importo_maturato || 0) - giaIncassato));
  const latestUnpaid = sorted.find(s => !s.pagato_il) || null;
  return { amount, latestUnpaid };
}

// ── Previsione di cassa a 30 giorni (solo dati certi) ───────────────────────
// Deciso dopo un confronto con Pillar (competitor): NON stimiamo scadenze che
// non abbiamo (site_costs/company_expenses non hanno una data di scadenza
// reale, solo la data del documento) — un numero "quanto esce" che inventasse
// un termine standard sarebbe esattamente il tipo di stima spacciata per
// certezza che l'utente ha chiesto di evitare. Contiamo solo due fonti con
// una data vera: i SAL con data_pagamento_prevista (migrazione 086) e le
// spese ricorrenti con day_of_month (company_recurring_expenses, esisteva
// già nel DB ma non era mai stata esposta in nessuna schermata).
function nextRecurringOccurrence(dayOfMonth, from) {
  const lastDayThisMonth = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
  const dayThisMonth = Math.min(dayOfMonth, lastDayThisMonth);
  const thisMonth = new Date(from.getFullYear(), from.getMonth(), dayThisMonth);
  if (thisMonth >= from) return thisMonth;
  const lastDayNextMonth = new Date(from.getFullYear(), from.getMonth() + 2, 0).getDate();
  return new Date(from.getFullYear(), from.getMonth() + 1, Math.min(dayOfMonth, lastDayNextMonth));
}

async function buildCashForecast30gg(companyId) {
  const today = new Date();
  const in30gg = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const todayISO = today.toISOString().slice(0, 10);
  const in30ggISO = in30gg.toISOString().slice(0, 10);
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

  const [salRes, recurringRes, invoiceDueRes] = await Promise.all([
    // F-219 (AUDIT.md): tutte le righe SAL del cantiere (non solo quelle non
    // pagate) servono per calcolare quanto resta scoperto per DAVVERO (vedi
    // netSalOwed) — filtrare qui a monte per pagato_il/scadenza impedirebbe di
    // vedere i SAL precedenti già incassati che vanno sottratti dal cumulativo.
    supabase.from('site_sal_history')
      .select('site_id, sal_number, importo_maturato, pagato_il, data_pagamento_prevista')
      .eq('company_id', companyId),
    supabase.from('company_recurring_expenses')
      .select('id, amount, day_of_month').eq('company_id', companyId).eq('is_active', true),
    // F-216 (AUDIT.md), seguito: fatture importate (A-Cube/email/importazione
    // massiva) con una vera scadenza di pagamento dichiarata nell'XML FatturaPA
    // (data_scadenza, migrazione 227) — mai stimata, solo quella che il
    // documento dichiara esplicitamente.
    supabase.from('company_expenses')
      .select('amount').eq('company_id', companyId).is('pagato_il', null)
      .not('data_scadenza', 'is', null).lte('data_scadenza', in30ggISO),
  ]);

  // Per ciascun cantiere: quanto resta scoperto per davvero (netSalOwed),
  // contato nei 30gg solo se l'ULTIMO SAL non pagato ha una scadenza vera
  // entro la finestra — un SAL precedente già incassato non ha più una
  // scadenza propria da guardare, è superato dal cumulativo del successivo.
  const salBySite = {};
  for (const r of (salRes.data || [])) {
    (salBySite[r.site_id] ||= []).push(r);
  }
  const inEntrata30gg = round2(Object.values(salBySite).reduce((sum, rows) => {
    const { amount, latestUnpaid } = netSalOwed(rows);
    if (amount <= 0 || !latestUnpaid?.data_pagamento_prevista) return sum;
    return latestUnpaid.data_pagamento_prevista <= in30ggISO ? sum + amount : sum;
  }, 0));
  const inUscitaFattureConScadenza30gg = (invoiceDueRes.data || []).reduce((s, r) => s + Number(r.amount || 0), 0);

  // Un template la cui occorrenza di questo mese è già stata materializzata
  // (services/recurringExpenseCron.js) e SEGNATA PAGATA non deve continuare
  // a proiettarsi nella previsione — è già uscita, non "sta per uscire".
  // Se non è ancora pagata (materializzata o no) conta come prima: è ancora
  // denaro che sta per uscire nei prossimi 30gg.
  const recurringIds = (recurringRes.data || []).map(r => r.id);
  let paidThisCycle = new Set();
  if (recurringIds.length) {
    const { data: paidRows } = await supabase.from('company_expenses')
      .select('recurring_expense_id')
      .in('recurring_expense_id', recurringIds)
      .gte('expense_date', monthStart)
      .not('pagato_il', 'is', null);
    paidThisCycle = new Set((paidRows || []).map(r => r.recurring_expense_id));
  }

  const inUscitaCerta30gg = round2((recurringRes.data || []).reduce((s, r) => {
    if (paidThisCycle.has(r.id)) return s;
    const next = nextRecurringOccurrence(r.day_of_month, today);
    return next.toISOString().slice(0, 10) <= in30ggISO ? s + Number(r.amount || 0) : s;
  }, inUscitaFattureConScadenza30gg));

  return { da: todayISO, a: in30ggISO, in_entrata: inEntrata30gg, in_uscita_certa: inUscitaCerta30gg };
}

// ── Un singolo cantiere ────────────────────────────────────────────────────
async function buildSiteEconomiaOverview(siteId, companyId) {
  const [siteRes, computoRes, salRes, costsRes, subCostsRes, expensesRes, subAssignRes] = await Promise.all([
    supabase.from('sites').select('id, name, budget_totale, sal_percentuale, status')
      .eq('id', siteId).eq('company_id', companyId).maybeSingle(),
    supabase.from('site_computo').select('id').eq('site_id', siteId).eq('company_id', companyId).eq('tipo', 'base').limit(1),
    supabase.from('site_sal_history').select('id, sal_number, importo_maturato, pagato_il, data_emissione')
      .eq('site_id', siteId).eq('company_id', companyId),
    // subcontractor_id: escluso qui dal calcolo di da_pagare, il saldo verso i
    // subappaltatori si calcola sotto con la stessa formula (budget − acconti)
    // già in uso altrove — sommare anche le loro fatture qui creerebbe un
    // doppio conteggio. Incluse comunque nell'elenco movimenti (informative).
    supabase.from('site_costs').select('id, importo, tipo, pagato_il, data_documento, descrizione, fornitore, created_at, file_url')
      .eq('site_id', siteId).eq('company_id', companyId).is('subcontractor_id', null),
    supabase.from('site_costs').select('id, importo, tipo, pagato_il, data_documento, descrizione, fornitore, created_at, file_url, subcontractor_id, subcontractor:subcontractor_id(company_name)')
      .eq('site_id', siteId).eq('company_id', companyId).not('subcontractor_id', 'is', null),
    supabase.from('company_expenses').select('id, amount, pagato_il, expense_date, description, source, created_at, receipt_url')
      .eq('site_id', siteId).eq('company_id', companyId),
    supabase.from('site_subcontractors').select('subcontractor_id, budget_totale, subcontractor:subcontractor_id(company_name)')
      .eq('site_id', siteId).eq('company_id', companyId),
  ]);

  if (siteRes.error) throw new Error('DB_ERROR: ' + siteRes.error.message);
  if (!siteRes.data) { const e = new Error('SITE_NOT_FOUND'); e.status = 404; throw e; }

  const salRows     = salRes.data || [];
  const allCostRows = costsRes.data || [];
  const costRows    = allCostRows.filter(c => c.importo !== null); // un DDT senza importo non è mai "da pagare"
  const subCostRows = subCostsRes.data || [];
  const expRows     = expensesRes.data || [];
  const hasContratto = siteRes.data.budget_totale !== null || (computoRes.data || []).length > 0;

  const daIncassare = netSalOwed(salRows).amount;

  const fattureAperte = costRows.filter(c => c.tipo !== 'acconto' && !c.pagato_il);
  const speseAperte   = expRows.filter(e => !e.pagato_il);
  const daPagareDiretto = round2(
    fattureAperte.reduce((s, c) => s + Number(c.importo), 0) +
    speseAperte.reduce((s, e) => s + Number(e.amount || 0), 0)
  );

  const acconti = {};
  for (const a of subCostRows.filter(c => c.tipo === 'acconto')) {
    acconti[a.subcontractor_id] = (acconti[a.subcontractor_id] || 0) + Number(a.importo || 0);
  }
  const subappaltatori = (subAssignRes.data || []).map(a => {
    const budgetTotale = a.budget_totale !== null ? Number(a.budget_totale) : 0;
    const dati = acconti[a.subcontractor_id] || 0;
    return {
      subcontractor_id: a.subcontractor_id,
      company_name:     a.subcontractor?.company_name || '—',
      saldo_da_erogare: round2(budgetTotale - dati),
    };
  }).filter(s => s.saldo_da_erogare > 0);
  const daPagareSubappalti = round2(subappaltatori.reduce((s, x) => s + x.saldo_da_erogare, 0));

  const daPagare = round2(daPagareDiretto + daPagareSubappalti);

  // ── Elenco movimenti unico (fatture/DDT/acconti/subappalti/SAL) ────────────
  // Un "acconto" è sempre mostrato come già pagato (per definizione lo è),
  // un DDT senza importo è sempre mostrato con importo "—", mai un valore
  // inventato. Ordinato dal più recente.
  const movimenti = [
    ...allCostRows.map(c => ({
      id: c.id, fonte: 'site_costs', tipo: c.tipo,
      descrizione: c.descrizione, controparte: c.fornitore,
      importo: c.importo, data: c.data_documento || c.created_at?.slice(0, 10),
      pagato: c.tipo === 'acconto' ? true : !!c.pagato_il,
      pagato_il: c.pagato_il,
      file_path: c.file_url || null, file_bucket: 'site-media',
    })),
    ...subCostRows.map(c => ({
      id: c.id, fonte: 'site_costs', tipo: c.tipo === 'acconto' ? 'acconto_subappalto' : c.tipo,
      descrizione: c.descrizione, controparte: c.subcontractor?.company_name || 'Subappaltatore',
      importo: c.importo, data: c.data_documento || c.created_at?.slice(0, 10),
      pagato: c.tipo === 'acconto' ? true : !!c.pagato_il,
      pagato_il: c.pagato_il,
      file_path: c.file_url || null, file_bucket: 'site-media',
    })),
    ...expRows.map(e => ({
      id: e.id, fonte: 'company_expenses', tipo: 'spesa_generale',
      descrizione: e.description, controparte: null,
      importo: e.amount, data: e.expense_date || e.created_at?.slice(0, 10),
      pagato: !!e.pagato_il, pagato_il: e.pagato_il,
      // Il bucket di receipt_url dipende dalla fonte (routes/v1/expenses.js
      // ne assume genericamente uno solo, 'site-documents', per ogni fonte —
      // sbagliato per le spese caricate da badge DDT, che finiscono in
      // 'site-media' come i DDT su site_costs, vedi routes/v1/badgeDdt.js).
      // Genera un link solo per la fonte di cui conosciamo il bucket vero,
      // per non firmare un percorso nel bucket sbagliato (fallirebbe
      // silenziosamente, ma è comunque scorretto tentarlo).
      file_path: e.source === 'badge_ddt' ? (e.receipt_url || null) : null,
      file_bucket: 'site-media',
    })),
    ...salRows.map(s => ({
      id: s.id, fonte: 'site_sal_history', tipo: 'sal',
      descrizione: `SAL n. ${s.sal_number}`, controparte: null,
      importo: s.importo_maturato, data: s.data_emissione,
      pagato: !!s.pagato_il, pagato_il: s.pagato_il,
      file_path: null, file_bucket: null,
    })),
  ].sort((a, b) => (b.data || '').localeCompare(a.data || ''));

  // Signed URL per i movimenti con una foto/documento allegato (DDT in
  // primis, F-213/F-214/F-227) — mai il path grezzo dello storage al
  // frontend, sempre un URL firmato a breve scadenza come fa già
  // routes/v1/siteCosts.js per lo stesso bucket.
  const movimentiConFoto = await Promise.all(movimenti.map(async (m) => {
    if (!m.file_path) return m;
    try {
      const { data: signed } = await supabase.storage
        .from(m.file_bucket).createSignedUrl(m.file_path, 3600);
      return { ...m, foto_url: signed?.signedUrl || null };
    } catch {
      return { ...m, foto_url: null };
    }
  }));

  return {
    site: {
      id: siteRes.data.id, name: siteRes.data.name, status: siteRes.data.status, has_contratto: hasContratto,
      budget_totale: siteRes.data.budget_totale !== null ? Number(siteRes.data.budget_totale) : null,
      sal_percentuale: Number(siteRes.data.sal_percentuale) || 0,
    },
    da_incassare: { totale: daIncassare, sal_aperti: salRows.filter(s => !s.pagato_il).length },
    da_pagare: {
      totale: daPagare,
      fatture: round2(fattureAperte.reduce((s, c) => s + Number(c.importo), 0)),
      spese_generali: round2(speseAperte.reduce((s, e) => s + Number(e.amount || 0), 0)),
      subappalti: daPagareSubappalti,
      subappaltatori,
    },
    // Il path grezzo dello storage (file_path/file_bucket) resta interno —
    // il frontend riceve solo l'URL firmato, mai il percorso del bucket.
    movimenti: movimentiConFoto.map(({ file_path, file_bucket, ...m }) => m),
  };
}

// ── Tutta l'azienda ─────────────────────────────────────────────────────────
async function buildCompanyEconomiaOverview(companyId) {
  const { data: sites, error: sitesErr } = await supabase
    .from('sites').select('id, name, status')
    .eq('company_id', companyId).not('status', 'in', '(chiuso,eliminato)');
  if (sitesErr) throw new Error('DB_ERROR: ' + sitesErr.message);

  const [perSite, previsione30gg] = await Promise.all([
    Promise.all((sites || []).map(s => buildSiteEconomiaOverview(s.id, companyId))),
    buildCashForecast30gg(companyId),
  ]);

  // Spese davvero generali — mai legate a un cantiere (affitto, assicurazione,
  // o un DDT su cantiere non ancora censito, F-214) — sommate una volta sola
  // qui, non già incluse in nessun perSite (site_id IS NULL le esclude sopra).
  const { data: generali } = await supabase
    .from('company_expenses').select('amount, pagato_il')
    .eq('company_id', companyId).is('site_id', null);
  const daPagareGenerali = round2((generali || []).filter(e => !e.pagato_il).reduce((s, e) => s + Number(e.amount || 0), 0));

  const daIncassare = round2(perSite.reduce((s, x) => s + x.da_incassare.totale, 0));
  const daPagare    = round2(perSite.reduce((s, x) => s + x.da_pagare.totale, 0) + daPagareGenerali);

  const perSiteList = perSite
    .map(x => ({
      site_id: x.site.id, site_name: x.site.name, has_contratto: x.site.has_contratto,
      da_incassare: x.da_incassare.totale, da_pagare: x.da_pagare.totale,
      saldo: round2(x.da_incassare.totale - x.da_pagare.totale),
    }))
    // Un cantiere senza contratto non ha un saldo "peggiore o migliore" —
    // va segnalato (in fondo, serve un'azione diversa: configurarlo, non
    // pagare/incassare), non ordinato in mezzo agli altri per un numero
    // a zero che sembrerebbe "tutto a posto".
    .sort((a, b) => {
      if (a.has_contratto !== b.has_contratto) return a.has_contratto ? -1 : 1;
      return a.saldo - b.saldo; // peggiore (più negativo) prima
    });

  return {
    da_incassare: { totale: daIncassare },
    da_pagare: { totale: daPagare, spese_generali: daPagareGenerali },
    previsione_30gg: previsione30gg,
    cantieri: perSiteList,
  };
}

module.exports = { buildSiteEconomiaOverview, buildCompanyEconomiaOverview };
