#!/usr/bin/env node
/**
 * scripts/selftest_oggi_imprese.js — F-420 (AUDIT.md del frontend).
 *
 * «Pronta a lavorare», fase 2: ti avviso io, su Oggi. Su un'azienda di prova vera
 * (Da fare e Oggi veri, DB):
 *  - un'impresa di un tuo cantiere col DURC scaduto ieri → «X non può più entrare ·
 *    Da ieri: il DURC è scaduto», rossa; la riga «DURC — X» non si ripete tra i documenti;
 *  - un'impresa di un tuo cantiere senza patente → «Y non può entrare · Manca: patente a crediti»;
 *  - un'impresa che non è in nessun cantiere attivo → nessuna riga;
 *  - il titolare carica la patente che mancava → «Z ora può entrare», azzurra, una volta sola;
 *  - più di 3 imprese che non possono entrare → una riga sola.
 */
'use strict';
require('dotenv').config({ quiet: true });
process.env.PIN_SIGNING_SECRET ||= 'test';
const supabase = require('../lib/supabase');
const { costruisci } = require('../lib/oggi');
const L = require('../lib/impreseLink');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const tra = (g) => { const x = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + g); return x.toISOString().slice(0, 10); };
const righe = (h) => [h.prima, ...h.poi].filter(Boolean);

(async () => {
  console.log('\n\x1b[1mF-420 — le imprese su Oggi\x1b[0m');
  const T = `TEST-F420-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const site = await ins('sites', { company_id: co.id, name: `${T} Via Balbi`, address: 'Via Balbi 31', status: 'attivo' });
    const doc = (subId, category, extra = {}) => ins('subcontractor_documents', { company_id: co.id, subcontractor_id: subId, name: category, category, file_path: `x/${subId}/${category}`, esito: 'va_bene', ai_validity_ok: true, ...extra });
    const impresa = async (nome, { durc = tra(90), patente = true, cantiere = true } = {}) => {
      const s = await ins('subcontractors', { company_id: co.id, company_name: nome, is_active: true, durc_expiry: durc, visura_date: tra(-20) });
      if (patente) await doc(s.id, 'patente_crediti');
      await doc(s.id, 'durc', { valid_until: durc }); await doc(s.id, 'visura'); await doc(s.id, 'dvr'); await doc(s.id, 'dichiarazione_art14');
      if (cantiere) await ins('site_subcontractors', { company_id: co.id, site_id: site.id, subcontractor_id: s.id });
      return s;
    };
    await impresa('Impianti Verdi', { durc: tra(-1) });
    await impresa('Senza Patente', { patente: false });
    await impresa('Fuori Cantiere', { patente: false, cantiere: false });
    await impresa('In Regola');

    let h = await costruisci(co.id, null, 'owner');
    let r = righe(h);
    const iv = r.find(x => x.titolo === 'Impianti Verdi non può più entrare');
    check('«Impianti Verdi non può più entrare · Da ieri: il DURC è scaduto», rossa, porta alla sua scheda', iv?.sotto === 'Da ieri: il DURC è scaduto' && iv.tono === 'rosso' && /^\/imprese\//.test(iv.link), iv);
    const sp = r.find(x => x.titolo === 'Senza Patente non può entrare');
    check('«Senza Patente non può entrare · Manca: patente a crediti»', sp?.sotto === 'Manca: patente a crediti' && sp.tono === 'rosso', sp);
    check('l\'impresa che non è in nessun cantiere attivo non ha riga', !r.some(x => /Fuori Cantiere/.test(x.titolo)), r.map(x => x.titolo));
    check('la riga «DURC — Impianti Verdi» non si ripete tra i documenti scaduti', !r.some(x => /documenti scaduti|DURC di Impianti Verdi/.test(x.titolo)), r.map(x => `${x.titolo} · ${x.sotto}`));
    check('l\'impresa in regola non compare', !r.some(x => /In Regola/.test(x.titolo)));

    // Il titolare carica la patente che mancava: «ora può entrare»
    const { data: sp1 } = await supabase.from('subcontractors').select('id, company_name, piva, da_completare').eq('company_id', co.id).eq('company_name', 'Senza Patente').single();
    const pdf = { buffer: Buffer.from('%PDF-1.4 finto'), mimetype: 'application/pdf', originalname: 'patente.pdf', size: 14 };
    const finto = async () => ({ tipo: 'patente', ragione_sociale: 'Senza Patente', crediti: 30 });
    const up = await L.caricaDalTitolare(co.id, null, sp1.id, { tipo: 'patente', file: pdf }, finto);
    check('la patente caricata va bene', up.esito === 'va_bene', up);
    h = await costruisci(co.id, null, 'owner');
    r = righe(h);
    const ora = r.find(x => x.titolo === 'Senza Patente ora può entrare');
    check('«Senza Patente ora può entrare», azzurra, porta alla sua scheda', ora?.tono === 'blu' && /ho controllato, va bene/.test(ora.sotto) && ora.link === `/imprese/${sp1.id}`, ora);
    check('…e non c\'è più «Senza Patente non può entrare»', !r.some(x => x.titolo === 'Senza Patente non può entrare'));
    await L.caricaDalTitolare(co.id, null, sp1.id, { tipo: 'patente', file: pdf }, finto);
    const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('company_id', co.id).eq('type', 'sub_ora_pronta');
    check('un secondo caricamento non ripete l\'avviso', count === 1, count);

    // Più di 3 imprese che non possono entrare: una riga sola
    for (const n of ['A1', 'A2', 'A3']) await impresa(`Ditta ${n}`, { patente: false });
    h = await costruisci(co.id, null, 'owner');
    r = righe(h);
    const una = r.find(x => x.id === 'imprese-non-entrano');
    check('4 imprese che non possono entrare → «4 imprese non possono entrare», una riga', una?.titolo === '4 imprese non possono entrare' && !r.some(x => / non può (più )?entrare$/.test(x.titolo)), r.map(x => x.titolo));
  } finally {
    const { data: subs } = await supabase.from('subcontractors').select('id').eq('company_id', co.id);
    const ids = (subs || []).map(s => s.id);
    const { data: f } = ids.length ? await supabase.from('subcontractor_documents').select('file_path').in('subcontractor_id', ids) : { data: [] };
    const veri = (f || []).map(x => x.file_path).filter(p => !p.startsWith('x/'));
    if (veri.length) await supabase.storage.from('site-documents').remove(veri);
    for (const t of ['notifications', 'subcontractor_documents', 'site_subcontractors', 'sub_link', 'company_feature_flags']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('subcontractors').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
