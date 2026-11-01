#!/usr/bin/env node
/**
 * scripts/selftest_da_rinnovare.js — F-417 (AUDIT.md del frontend).
 *
 * «Da rinnovare» su un'azienda di prova vera (DB):
 *  - scaduti dal più vecchio: visita di un tuo operaio, DURC di un'impresa,
 *    visita di un operaio dell'impresa, assicurazione di un mezzo;
 *  - mancano: il corso sicurezza di un tuo operaio (obbligatorio); l'assicurazione
 *    RC di un'impresa (consigliata) NO;
 *  - entro un mese: il DURC della tua impresa tra 20 giorni; tra 60 giorni no;
 *  - cosa fare: tuoi operai e tua impresa → «carica» su /carica; mezzo → la sua
 *    scheda; impresa e suoi operai → «chiedi» con l'id dell'impresa;
 *  - un operaio che non lavora più qui e un'impresa disattivata non compaiono.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { daRinnovare } = require('../lib/daRinnovare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const tra = (g) => { const x = new Date(); x.setDate(x.getDate() + g); return x.toISOString().slice(0, 10); };

(async () => {
  console.log('\n\x1b[1mF-417 — Da rinnovare\x1b[0m');
  const T = `TEST-F417-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T, durc_expiry: tra(20) });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const lika = await ins('workers', { company_id: co.id, first_name: 'Elton', last_name: 'Lika', full_name: 'Elton Lika', is_active: true, badge_code: `T417A${Date.now()}`, health_fitness_expiry: tra(-3), safety_training_expiry: tra(400) });
    await ins('workers', { company_id: co.id, first_name: 'Carlo', last_name: 'Bianco', full_name: 'Carlo Bianco', is_active: true, badge_code: `T417B${Date.now()}`, health_fitness_expiry: tra(300) });
    await ins('workers', { company_id: co.id, first_name: 'Ex', last_name: 'Operaio', full_name: 'Ex Operaio', is_active: false, badge_code: `T417C${Date.now()}`, health_fitness_expiry: tra(-50) });
    const bianchi = await ins('subcontractors', { company_id: co.id, company_name: 'Edil Bianchi Srl', is_active: true, durc_expiry: tra(-10), visura_date: tra(-30) });
    await ins('subcontractors', { company_id: co.id, company_name: 'Vecchia Ditta Srl', is_active: false, durc_expiry: tra(-100) });
    const op = await ins('sub_workers', { company_id: co.id, subcontractor_id: bianchi.id, full_name: 'Paolo Neri', added_via: 'ufficio' });
    await ins('sub_worker_documenti', { company_id: co.id, sub_worker_id: op.id, tipo: 'idoneita', scadenza: tra(-1), file_path: `x/${op.id}/v`, esito: 'va_bene' });
    const furgone = await ins('equipment', { company_id: co.id, name: 'Furgone', type: 'Furgone', model: 'Iveco Daily', plate_or_serial: 'AB123CD', is_active: true, insurance_expiry: tra(-5) });
    await ins('equipment', { company_id: co.id, name: 'Auto', type: 'Auto', model: 'Panda', plate_or_serial: 'EF456GH', is_active: true, insurance_expiry: tra(60) });

    const r = await daRinnovare(co.id);
    const trova = (lista, chi, cosa) => lista.find(x => x.chi === chi && x.cosa === cosa);
    check('scaduti dal più vecchio: DURC di Edil Bianchi, assicurazione del furgone, visita di Lika, visita di Paolo Neri',
      r.scaduti.map(x => `${x.chi}|${x.cosa}`).join(',') === ['Edil Bianchi Srl|DURC', 'Furgone Iveco Daily|Assicurazione', 'Elton Lika|Visita medica', 'Paolo Neri (Edil Bianchi Srl)|Visita medica'].join(','), r.scaduti);
    check('mancano: il corso sicurezza di Carlo Bianco, DVR e dichiarazione di Edil Bianchi; MAI l’assicurazione RC (consigliata)',
      !!trova(r.mancano, 'Carlo Bianco', 'Corso sicurezza') && !!trova(r.mancano, 'Edil Bianchi Srl', 'DVR o autocertificazione') && !r.mancano.some(x => x.cosa === 'Assicurazione RC'), r.mancano);
    check('entro un mese: il DURC della tua impresa (tra 20 giorni); la Panda (tra 60) no',
      r.entroUnMese.length === 1 && r.entroUnMese[0].chi === 'La tua impresa' && r.entroUnMese[0].cosa === 'DURC' && r.entroUnMese[0].scadenza === tra(20), r.entroUnMese);
    const visita = trova(r.scaduti, 'Elton Lika', 'Visita medica');
    check('la visita di Lika: «carica» su /carica, con la data', visita?.azione === 'carica' && visita.link === '/carica' && visita.scadenza === tra(-3), visita);
    const ass = trova(r.scaduti, 'Furgone Iveco Daily', 'Assicurazione');
    check('l’assicurazione del furgone: «carica» nella scheda del mezzo', ass?.azione === 'carica' && ass.link === `/documenti/mezzi/${furgone.id}`, ass);
    const durc = trova(r.scaduti, 'Edil Bianchi Srl', 'DURC');
    const neri = trova(r.scaduti, 'Paolo Neri (Edil Bianchi Srl)', 'Visita medica');
    check('il DURC di Edil Bianchi e la visita del loro operaio: «chiedi» all’impresa', durc?.azione === 'chiedi' && durc.impresaId === bianchi.id && neri?.azione === 'chiedi' && neri.impresaId === bianchi.id, { durc, neri });
    check('chi non lavora più qui e l’impresa disattivata non compaiono', ![...r.scaduti, ...r.mancano].some(x => /Ex Operaio|Vecchia Ditta/.test(x.chi)));
    check('Lika: il corso (tra 400 giorni) non compare da nessuna parte', !trova([...r.scaduti, ...r.mancano, ...r.entroUnMese], 'Elton Lika', 'Corso sicurezza'));
    check('totale = scaduti + mancano + entro un mese', r.totale === r.scaduti.length + r.mancano.length + r.entroUnMese.length, r.totale);
    check('ogni riga ha un id diverso', new Set([...r.scaduti, ...r.mancano, ...r.entroUnMese].map(x => x.id)).size === r.totale);
  } finally {
    for (const t of ['sub_worker_documenti', 'sub_workers', 'subcontractors', 'equipment', 'workers', 'company_feature_flags']) await supabase.from(t).delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
