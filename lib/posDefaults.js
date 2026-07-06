'use strict';
const supabase = require('./supabase');

// Figure di sicurezza dall'ultimo POS emesso in azienda — riusate sia da
// GET /api/v1/pos/defaults (form legacy) sia dal tool chat get_pos_defaults
// (Ladia, per proporre il riuso invece di chiedere a freddo).
async function getCompanyPosDefaults(companyId) {
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id')
    .eq('company_id', companyId);

  if (sitesErr || !sites?.length) return null;

  const siteIds = sites.map(s => s.id);

  const { data: doc } = await supabase
    .from('pos_documents')
    .select('pos_data')
    .in('site_id', siteIds)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!doc?.pos_data) return null;

  const d = doc.pos_data;
  const persona = (nome = '', tel = '', email = '', cf = '') =>
    ({ nome, telefono: tel, email, codiceFiscale: cf });

  return {
    ragioneSocialeImpresa: d.companyName || '',
    partitaIvaImpresa:     d.companyVat  || '',
    responsabileLavori:    persona(d.responsabileLavori),
    csp:                   persona(d.csp),
    cse:                   persona(d.cse, d.cseTel, d.cseEmail, d.cseCf),
    rspp:                  persona(d.rspp, d.rsppTel, d.rsppEmail, d.rsppCf),
    rls:                   persona(d.rls, d.rlsTel),
    medicoCompetente:      { ...persona(d.medico, d.medicoTel), firma: '' },
    addettoPrimoSoccorso:  persona(d.primoSoccorso, d.primoSoccorsoTel),
    addettoAntincendio:    persona(d.antincendio, d.antincendioTel),
    direttoreTecnico:      persona(d.direttoreTecnico),
    prepostoCantiere:      persona(d.preposto),
  };
}

module.exports = { getCompanyPosDefaults };
