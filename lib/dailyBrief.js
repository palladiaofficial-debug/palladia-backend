'use strict';
// ── Card "Buonasera" della home di Ladia (F-242) ──────────────────────────────
// Prima (computeDailyBrief in chat.js) la card aveva una lista sua: campi
// `*_expiry` dei lavoratori, DURC dalla scheda subappaltatore (modulo
// congelato), budget dall'economia (congelata), NC (eliminate) — senza vedere i
// documenti caricati. Risultato: un DURC rinnovato restava "scaduto" nella card
// e la card diceva cose diverse da Da fare. Ora la card È Da fare in piccolo:
// stessa fonte (lib/daFare.js), stesse regole (documenti rinnovati, moduli
// congelati esclusi, prenotazioni F-243), e ogni riga porta dove si sistema.
const supabase = require('./supabase');
const { buildDaFare } = require('./daFare');
const { riassuntoPagamenti } = require('./daPagare');

const ICON_BY_TYPE = {
  idoneita: 'medical',
  formazione: 'certificate',
  durc: 'company',
  documento: 'company',
  assicurazione: 'company',
  revisione: 'company',
  manutenzione: 'company',
  fine_cantiere: 'alert',
  suolo: 'alert',
  pioggia: 'alert',
  weather_alert: 'alert',
  uscita: 'worker',
  punch_help_request: 'worker',
  worker_doc_missing: 'worker',
  pagamento: 'payment',
};

// F-332: il tasto della riga nella card, lo stesso della pagina Da fare —
// "Fatto" su un avviso (letto per te), "È giusta" su una timbratura da
// controllare, "Prenotata" (7 giorni) su una scadenza. null = nessuna azione
// in un tocco (es. uscita da correggere): la card offre solo "nascondi".
function rowAction(i) {
  if (i.kind === 'avviso' && i.notificationId) {
    return { kind: 'fatto', label: 'Fatto', method: 'PATCH', path: `/api/v1/notifications/${i.notificationId}/read` };
  }
  if (i.fixDismiss && i.fixId) {
    return { kind: 'giusta', label: i.fixDismiss.label || 'È giusta', method: 'POST',
      path: `${i.fixEndpoint || `/api/v1/presence/fix-requests/${i.fixId}`}/dismiss` };
  }
  if (i.prenotabile) {
    return { kind: 'prenota', label: 'Prenotata', method: 'POST', path: '/api/v1/da-fare/prenota',
      body: { itemId: i.id, giorni: 7 },
      undo: { method: 'DELETE', path: `/api/v1/da-fare/prenota?itemId=${encodeURIComponent(i.id)}` } };
  }
  return null;
}

// userId: senza, gli avvisi già letti (o chiusi con "Fatto") restavano nella
// card anche se in Da fare erano spariti (F-332).
async function buildDailyBrief(companyId, userId = null) {
  const todayStr = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const [daFare, sitesRes, workersRes, presenceRes] = await Promise.all([
    buildDaFare(companyId, userId, { todayStr }),
    supabase.from('sites').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).in('status', ['attivo', 'sospeso']),
    supabase.from('workers').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('is_active', true),
    supabase.from('presence_logs').select('worker_id')
      .eq('company_id', companyId).eq('event_type', 'ENTRY')
      .gte('timestamp_server', `${todayStr}T00:00:00`).lte('timestamp_server', `${todayStr}T23:59:59`),
  ]);

  // Come la vecchia card: le urgenti (scadute, questa settimana) e le
  // scadenze entro 14 giorni come informazione. Mai le righe "In corso".
  // F-357: i pagamenti non sono più una riga per fattura con "Pagato" (cinque
  // righe rosse uguali e una fattura segnata pagata con un clic dalla home):
  // una riga sola con quante, quanto e a chi, che apre Da pagare. Solo se c'è
  // qualcosa di scaduto, sollecitato, da controllare o entro 3 giorni.
  const pagamentiUrgenti = daFare.items.filter(i => i.kind === 'pagamento'
    && (i.bucket === 'scaduto' || i.daControllare || i.days <= 3));
  const riassunto = riassuntoPagamenti(pagamentiUrgenti.length ? daFare.items : []);
  const alertPagamenti = riassunto ? [{
    id: riassunto.id,
    action: null,
    severity: riassunto.urgente ? 'critical' : 'warning',
    category: 'anomalia',
    icon: 'payment',
    title: riassunto.titolo,
    detail: riassunto.dettaglio,
    amount: riassunto.totaleTesto,
    link: riassunto.link,
  }] : [];
  const alerts = daFare.items
    .filter(i => i.kind !== 'pagamento')
    .filter(i => i.bucket === 'scaduto' || i.bucket === 'settimana' || (i.bucket === 'mese' && i.days <= 14))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)) // aiuto dalla timbratura in cima
    .map(i => ({
      id: i.id,
      action: rowAction(i),
      severity: i.bucket === 'mese' ? 'info' : (i.urgent || i.bucket === 'scaduto' ? 'critical' : 'warning'),
      category: i.kind === 'scadenza' ? 'scadenza' : 'anomalia',
      icon: ICON_BY_TYPE[i.type] || 'alert',
      title: i.title,
      detail: (i.subtitle || '').split('\n')[0],
      days: i.days,
      link: i.link,
    }));

  const sitesActive = sitesRes.count ?? 0;
  return {
    generated_at: new Date().toISOString(),
    kpi: {
      sites_active: sitesActive,
      workers_total: workersRes.count ?? 0,
      present_today: new Set((presenceRes.data || []).map(p => p.worker_id)).size,
      da_fare: daFare.attention,
      open_nc: 0, // NC eliminate da F-229; campo lasciato per i client vecchi
    },
    alerts: [...alertPagamenti, ...alerts].slice(0, 12),
    sites_count: sitesActive,
  };
}

module.exports = { buildDailyBrief };
