'use strict';
// ── Assegnazione di un subappaltatore a un cantiere (F-301, AUDIT.md del frontend)
// Usata dalla scheda del cantiere/subappaltatore e dal nuovo POS (/pos/crea),
// che assegna il subappaltatore scelto senza far uscire dal percorso.
// Idempotente: se l'assegnazione c'è già, non è un errore. Cantiere e
// subappaltatore devono appartenere entrambi all'azienda.
const supabase = require('./supabase');

const notFound = () => { const e = new Error('NOT_FOUND'); e.status = 404; return e; };

async function assignSubcontractorToSite(companyId, siteId, subcontractorId, role = null) {
  const [{ data: site }, { data: sub }] = await Promise.all([
    supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle(),
    supabase.from('subcontractors').select('id').eq('id', subcontractorId).eq('company_id', companyId).maybeSingle(),
  ]);
  if (!site || !sub) throw notFound();

  const { data: existing } = await supabase.from('site_subcontractors')
    .select('id').eq('site_id', siteId).eq('subcontractor_id', subcontractorId).eq('company_id', companyId).maybeSingle();
  if (existing) return { id: existing.id, created: false };

  const { data, error } = await supabase.from('site_subcontractors')
    .insert([{ company_id: companyId, site_id: siteId, subcontractor_id: subcontractorId, role: role || null }])
    .select('id').single();
  if (error?.code === '23505') return { id: null, created: false };
  if (error) throw error;
  return { id: data.id, created: true };
}

module.exports = { assignSubcontractorToSite };
