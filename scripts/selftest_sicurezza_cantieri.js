#!/usr/bin/env node
/**
 * scripts/selftest_sicurezza_cantieri.js — F-424 (AUDIT.md del frontend).
 *
 * La sicurezza di ogni cantiere su un'azienda di prova vera (DB):
 *  - Via Balbi (parte tra 3 giorni): PSC caricato, due imprese (Edil Rossi col POS mandato dal suo
 *    link e andato bene, Impianti Verdi senza), il tuo POS manca → «Manca il tuo POS · parte …»;
 *  - Via Verdi: il tuo POS fatto con Palladia, 3 operai attesi e 2 che l'hanno letto (in rumeno),
 *    Edil Rossi col POS fatto con Palladia → a posto, «2 operai su 3 l'hanno letto», azzurro;
 *  - Via Roma: lavori solo tu, POS caricato come file → il PSC non serve, gli operai non lo vedono;
 *  - Corso Italia: imprese a posto ma niente PSC → «Manca il PSC del coordinatore»;
 *  - Corso Sardegna: il POS di Impianti Verdi non va → «Il POS di Impianti Verdi non va»;
 *  - un cantiere chiuso non c'è; prima quelli da sistemare; «2 su 5 a posto»;
 *  - la pagina di Via Verdi: la catena e chi ha letto (prima chi manca, con impresa e lingua);
 *  - un'altra azienda non vede il cantiere.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const S = require('../lib/sicurezzaCantieri');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const giorno = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  console.log('\n\x1b[1mF-424 — la sicurezza dei cantieri\x1b[0m');
  const T = `TEST-F424-${Date.now()}`;
  const stamp = String(Date.now()).slice(-6);
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const altra = await ins('companies', { name: `${T}-altra` });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const sito = (nome, extra = {}) => ins('sites', { company_id: co.id, name: `${T} ${nome}`, address: `${nome}, Genova`, status: 'attivo', ...extra });
    const balbi = await sito('Via Balbi 31', { start_date: giorno(3) });
    const verdi = await sito('Via Verdi 13', { start_date: giorno(-60) });
    const roma = await sito('Via Roma 4');
    const corso = await sito('Corso Italia 8');
    const sardegna = await sito('Corso Sardegna 2');
    await sito('Via Chiusa 1', { status: 'chiuso' });

    const rossi = await ins('subcontractors', { company_id: co.id, company_name: `${T} Edil Rossi` });
    const verdiImp = await ins('subcontractors', { company_id: co.id, company_name: `${T} Impianti Verdi` });
    for (const [s, sub] of [[balbi, rossi], [balbi, verdiImp], [verdi, rossi], [corso, rossi], [sardegna, verdiImp]]) {
      await ins('site_subcontractors', { company_id: co.id, site_id: s.id, subcontractor_id: sub.id });
    }
    const subDoc = (sub, s, esito) => ins('subcontractor_documents', { company_id: co.id, subcontractor_id: sub.id, site_id: s.id, name: 'POS', category: 'pos', file_path: `${co.id}/pos-${s.id}-${sub.id}.pdf`, mime_type: 'application/pdf', esito, dall_impresa: true });
    await subDoc(rossi, balbi, 'va_bene');
    await subDoc(rossi, corso, 'va_bene');
    await subDoc(verdiImp, sardegna, 'non_va');

    const psc = (s) => ins('site_documents', { company_id: co.id, site_id: s.id, name: 'PSC.pdf', category: 'psc', file_path: `${co.id}/${s.id}/psc.pdf` });
    await psc(balbi); await psc(verdi); await psc(sardegna);
    await ins('site_documents', { company_id: co.id, site_id: roma.id, name: 'POS consulente.pdf', category: 'pos', file_path: `${co.id}/${roma.id}/pos.pdf` });

    const posVerdi = await ins('pos_documents', { company_id: co.id, site_id: verdi.id, revision: 2, pos_data: { companyName: T }, content: 'x' });
    await ins('pos_documents', { company_id: co.id, site_id: verdi.id, revision: 1, pos_data: { subcontractorId: rossi.id }, content: 'x' });
    await ins('pos_documents', { company_id: co.id, site_id: corso.id, revision: 1, pos_data: { companyName: T }, content: 'x' });
    await ins('pos_documents', { company_id: co.id, site_id: sardegna.id, revision: 1, pos_data: { companyName: T }, content: 'x' });

    const op = (n, cf) => ins('workers', { company_id: co.id, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F424${cf}${stamp}`, badge_code: `F424${cf}${stamp}` });
    const ion = await op('Ion Popescu', 'AA'), marco = await op('Marco Rossi', 'BB'), luca = await op('Luca Bianco', 'CC');
    for (const w of [ion, marco, luca]) await ins('worksite_workers', { company_id: co.id, site_id: verdi.id, worker_id: w.id, status: 'active' });
    await ins('pos_acknowledgments', { pos_id: posVerdi.id, worker_id: marco.id, company_id: co.id, site_id: verdi.id, lingua: 'ro' });
    await ins('pos_acknowledgments', { pos_id: posVerdi.id, worker_id: luca.id, company_id: co.id, site_id: verdi.id, lingua: 'it' });

    const el = await S.elenco(co.id);
    const riga = (s) => el.cantieri.find(c => c.id === s.id);
    const b = riga(balbi), v = riga(verdi), r = riga(roma), c = riga(corso), sa = riga(sardegna);
    check('5 cantieri aperti, il chiuso no', el.cantieri.length === 5, el.cantieri.map(x => x.nome));
    check('«2 su 5 a posto»', el.aPosto === 2 && el.totale === 5, { aPosto: el.aPosto, totale: el.totale });
    check('prima quelli da sistemare', el.cantieri.slice(0, 3).every(x => !x.aPosto) && el.cantieri.slice(3).every(x => x.aPosto), el.cantieri.map(x => [x.nome, x.aPosto]));

    check('Via Balbi: PSC presente, il tuo POS manca', b?.psc.stato === 'presente' && b.pos.stato === 'manca', b);
    check('Via Balbi: Edil Rossi ok dal suo link, Impianti Verdi manca', b?.imprese.find(i => i.id === rossi.id)?.stato === 'ok' && b.imprese.find(i => i.id === verdiImp.id)?.stato === 'manca', b?.imprese);
    check('Via Balbi: «Manca il tuo POS · parte …», arancione, tasto POS', /^Manca il tuo POS · parte /.test(b?.frase || '') && b.tono === 'arancio' && b.azione === 'pos', b && { frase: b.frase, tono: b.tono, azione: b.azione });

    check('Via Verdi: a posto, il tuo POS rev. 2 fatto con Palladia', v?.aPosto && v.pos.stato === 'presente' && v.pos.fonte === 'palladia' && v.pos.revisione === 2, v?.pos);
    check('Via Verdi: Edil Rossi col POS fatto con Palladia conta', v?.imprese[0]?.stato === 'ok', v?.imprese);
    check('Via Verdi: 2 operai su 3 l\'hanno letto, azzurro', v?.operai?.letto === 2 && v.operai.attesi === 3 && v.frase === "A posto · 2 operai su 3 l'hanno letto" && v.tono === 'blu' && v.azione === 'operai', v && { operai: v.operai, frase: v.frase, tono: v.tono });

    check('Via Roma: lavori solo tu, il PSC non serve', r?.psc.stato === 'non_serve' && r.imprese.length === 0, r);
    check('Via Roma: POS caricato come file conta, ma gli operai non lo vedono', r?.aPosto && r.pos.fonte === 'file' && r.operai === null && /file/.test(r.frase) && r.tono === 'verde', r && { pos: r.pos, operai: r.operai, frase: r.frase });

    check('Corso Italia: «Manca il PSC del coordinatore»', c?.psc.stato === 'manca' && !c.aPosto && c.frase === 'Manca il PSC del coordinatore' && c.azione === 'psc', c && { psc: c.psc, frase: c.frase });
    check('Corso Sardegna: «Il POS di … Impianti Verdi non va»', !sa?.aPosto && sa.frase === `Il POS di ${T} Impianti Verdi non va` && sa.azione === 'impresa' && sa.impresaId === verdiImp.id, sa && { frase: sa.frase, azione: sa.azione });

    const pv = await S.cantiere(co.id, verdi.id);
    check('la pagina di Via Verdi ha la stessa catena', pv.nome === v.nome && pv.operai.letto === 2 && pv.psc.stato === 'presente', pv);
    const nomi = pv.operaiElenco.map(o => o.nome);
    check('chi ha letto: prima chi manca (Ion), poi gli altri', nomi.length === 3 && nomi[0] === `${T} Ion Popescu` && pv.operaiElenco[0].letto === null, pv.operaiElenco);
    const m = pv.operaiElenco.find(o => o.workerId === marco.id);
    check('Marco: letto, in rumeno, impresa la tua', !!m?.letto && m.lingua === 'Rumeno' && m.impresa === T, m);

    let negato = false;
    try { await S.cantiere(altra.id, verdi.id); } catch (e) { negato = e.status === 404; }
    check('un\'altra azienda non vede il cantiere', negato);
  } finally {
    for (const id of [co.id, altra.id]) {
      await supabase.from('pos_acknowledgments').delete().eq('company_id', id);
      await supabase.from('pos_documents').delete().eq('company_id', id);
      await supabase.from('subcontractor_documents').delete().eq('company_id', id);
      await supabase.from('site_documents').delete().eq('company_id', id);
      await supabase.from('site_subcontractors').delete().eq('company_id', id);
      const { data: ss } = await supabase.from('sites').select('id').eq('company_id', id);
      for (const s of ss || []) await supabase.from('worksite_workers').delete().eq('site_id', s.id);
      await supabase.from('workers').delete().eq('company_id', id);
      await supabase.from('subcontractors').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('company_feature_flags').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
