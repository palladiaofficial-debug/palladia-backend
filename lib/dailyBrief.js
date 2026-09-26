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
};

async function buildDailyBrief(companyId) {
  const todayStr = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const [daFare, sitesRes, workersRes, presenceRes] = await Promise.all([
    buildDaFare(companyId, null, { todayStr }),
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
  const alerts = daFare.items
    .filter(i => i.bucket === 'scaduto' || i.bucket === 'settimana' || (i.bucket === 'mese' && i.days <= 14))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)) // aiuto dalla timbratura in cima
    .map(i => ({
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
    alerts: alerts.slice(0, 12),
    sites_count: sitesActive,
  };
}

module.exports = { buildDailyBrief };
