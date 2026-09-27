'use strict';
// ── Panoramica POS per cantiere (F-257, AUDIT.md del frontend) ──────────────
// Per ogni cantiere aperto: le imprese che ci lavorano (l'impresa stessa e i
// subappaltatori assegnati) e lo stato del loro POS. Un POS appartiene a un
// subappaltatore quando `pos_data.subcontractorId` è valorizzato (nuovo
// percorso POS, F-258); senza, è dell'impresa. Stati, onesti rispetto a ciò
// che il sistema sa davvero:
//   firmato — esiste il POS e tutti i lavoratori assegnati hanno la presa visione
//   pronto  — esiste il POS (rev. e data), presa visione non completa
//   bozza   — solo per l'impresa: bozza compilata con Ladia (pos_drafts)
//   manca   — nessun POS
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');

const CLOSED = ['chiuso', 'eliminato', 'completato', 'archiviato'];

async function computePosOverview(companyId) {
  const [{ data: company }, { data: sites, error: sErr }] = await Promise.all([
    supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, address, city, client, client_name, status, start_date').eq('company_id', companyId).order('name'),
  ]);
  if (sErr) throw sErr;
  const open = (sites || []).filter(s => !CLOSED.includes(String(s.status || '').toLowerCase()));
  if (!open.length) return { companyName: company?.name || '', subsEnabled: false, sites: [] };
  const siteIds = open.map(s => s.id);

  let subsEnabled = false;
  try { subsEnabled = await isFeatureEnabled(companyId, 'subappaltatori'); } catch { subsEnabled = false; }

  const [docsRes, draftsRes, assignRes, subsAssignRes] = await Promise.all([
    supabase.from('pos_documents').select('id, site_id, revision, created_at, pos_data').eq('company_id', companyId).in('site_id', siteIds).order('created_at', { ascending: false }).limit(1000),
    supabase.from('pos_drafts').select('site_id, updated_at').eq('company_id', companyId).in('site_id', siteIds),
    supabase.from('worksite_workers').select('site_id, worker_id, workers(id, subcontractor_id, is_active)').in('site_id', siteIds).eq('status', 'active'),
    subsEnabled
      ? supabase.from('site_subcontractors').select('site_id, subcontractor_id, role, subcontractors(id, company_name, is_active)').eq('company_id', companyId).in('site_id', siteIds)
      : Promise.resolve({ data: [] }),
  ]);
  for (const r of [docsRes, draftsRes, assignRes, subsAssignRes]) if (r.error) throw r.error;

  // Ultimo POS per (cantiere, impresa)
  const latest = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.site_id}|${d.pos_data?.subcontractorId || ''}`;
    if (!latest.has(key)) latest.set(key, d);
  }
  const posIds = [...latest.values()].map(d => d.id);
  const acks = posIds.length
    ? (await supabase.from('pos_acknowledgments').select('pos_id, worker_id').in('pos_id', posIds)).data || []
    : [];
  const ackByPos = new Map();
  for (const a of acks) {
    if (!ackByPos.has(a.pos_id)) ackByPos.set(a.pos_id, new Set());
    ackByPos.get(a.pos_id).add(a.worker_id);
  }
  const drafts = new Set((draftsRes.data || []).map(d => d.site_id));

  // Lavoratori assegnati per (cantiere, impresa)
  const workersBy = new Map();
  for (const a of assignRes.data || []) {
    if (!a.workers || a.workers.is_active === false) continue;
    const key = `${a.site_id}|${a.workers.subcontractor_id || ''}`;
    if (!workersBy.has(key)) workersBy.set(key, new Set());
    workersBy.get(key).add(a.worker_id);
  }

  const entry = (siteId, subId) => {
    const key = `${siteId}|${subId || ''}`;
    const doc = latest.get(key);
    const assigned = workersBy.get(key) || new Set();
    if (!doc) return { status: !subId && drafts.has(siteId) ? 'bozza' : 'manca', posId: null, workers: assigned.size };
    const acked = ackByPos.get(doc.id) || new Set();
    const signed = [...assigned].filter(w => acked.has(w)).length;
    return {
      status: assigned.size > 0 && signed >= assigned.size ? 'firmato' : 'pronto',
      posId: doc.id, revision: doc.revision, createdAt: doc.created_at,
      workers: assigned.size, signed,
    };
  };

  const subsBySite = new Map();
  for (const a of subsAssignRes.data || []) {
    if (!a.subcontractors || a.subcontractors.is_active === false) continue;
    if (!subsBySite.has(a.site_id)) subsBySite.set(a.site_id, []);
    subsBySite.get(a.site_id).push({ id: a.subcontractors.id, name: a.subcontractors.company_name, role: a.role || null });
  }

  return {
    companyName: company?.name || '',
    subsEnabled,
    sites: open.map(s => ({
      id: s.id,
      name: s.name,
      address: [s.address, s.city].filter(Boolean).join(', '),
      client: s.client_name || s.client || null,
      status: s.status,
      imprese: [
        { kind: 'impresa', subcontractorId: null, name: company?.name || 'La tua impresa', role: 'Impresa affidataria', ...entry(s.id, null) },
        ...(subsBySite.get(s.id) || []).map(sub => ({ kind: 'subappaltatore', subcontractorId: sub.id, name: sub.name, role: sub.role ? `Subappaltatore · ${sub.role}` : 'Subappaltatore', ...entry(s.id, sub.id) })),
      ],
    })),
  };
}

module.exports = { computePosOverview };
