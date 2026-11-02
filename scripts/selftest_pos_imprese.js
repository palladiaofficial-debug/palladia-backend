#!/usr/bin/env node
/**
 * scripts/selftest_pos_imprese.js — F-427 (AUDIT.md del frontend).
 *
 * Il POS di un'impresa in subappalto, controllato dall'impresa principale (art. 97 c. 3-ter), su
 * un'azienda di prova vera (DB, modello finto):
 *  - Impianti Verdi manda il POS di Via Balbi: dichiara la gru ma nessun gruista, non recepisce la
 *    recinzione del PSC → «non torna»: il titolo è la cosa più grave, ogni controllo con la pagina,
 *    il messaggio pronto (WhatsApp col numero dell'impresa, email);
 *  - il controllo si salva: riaprire non richiama il modello;
 *  - nella catena e su Oggi «Il POS di Impianti Verdi non torna con il tuo»;
 *  - «Va bene così» → la catena torna a posto, Oggi non lo dice più;
 *  - Edil Rossi con il POS che torna → «Torna su tutto»; un POS fatto con Palladia non si rilegge;
 *  - un'altra azienda non vede niente.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const P = require('../lib/posImprese');
const S = require('../lib/sicurezzaCantieri');
const { buildDaFare } = require('../lib/daFare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
async function pdf(t) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) d.addPage([595, 842]).drawText(`${t} POS piano operativo di sicurezza pagina ${i + 1} `.repeat(10).match(/.{1,90}/g).join('\n'), { x: 30, y: 800, size: 9, font: f, lineHeight: 11 });
  return Buffer.from(await d.save());
}
const contenutiOk = require('../lib/psc/catalog').POS_CONTENUTI.map(c => ({ key: c.key, presente: true, pagina: 1 }));
const RISPOSTE = {
  verdi: { e_un_pos: true, impresa: 'Impianti Verdi', contenuti: contenutiOk, lavoratori: [{ nome: 'Paolo Neri', formazione: ['Formazione generale'], pagina: 2 }], attrezzature: [{ nome: 'Gru a torre (uso comune)', pagina: 2 }], lavorazioni: ['Impianto elettrico'], prescrizioni: [{ id: 'p0', recepita: false }, { id: 'p1', recepita: true, pagina: 2 }] },
  rossi: { e_un_pos: true, impresa: 'Edil Rossi', contenuti: contenutiOk, lavoratori: [{ nome: 'Ion Popescu', formazione: ['Formazione generale'], pagina: 2 }], attrezzature: [{ nome: 'Betoniera', pagina: 2 }], lavorazioni: ['Intonaci'], prescrizioni: [{ id: 'p0', recepita: true, pagina: 1 }, { id: 'p1', recepita: true, pagina: 2 }] },
};

(async () => {
  console.log('\n\x1b[1mF-427 — il POS di un\'impresa, controllato\x1b[0m');
  const T = `TEST-F427-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const altra = await ins('companies', { name: `${T}-altra` });
  let chiamate = 0;
  const file = { verdi: await pdf('DOC:verdi'), rossi: await pdf('DOC:rossi') };
  const deps = (k) => ({ ai: async () => { chiamate++; return { input: RISPOSTE[k] }; }, download: async () => file[k] });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const balbi = await ins('sites', { company_id: co.id, name: `${T} Via Balbi 31`, address: 'Via Balbi 31, Genova', status: 'attivo' });
    const verdi = await ins('subcontractors', { company_id: co.id, company_name: `${T} Impianti Verdi`, phone: '+39 333 1234567', email: 'verdi@example.com' });
    const rossi = await ins('subcontractors', { company_id: co.id, company_name: `${T} Edil Rossi` });
    for (const sub of [verdi, rossi]) await ins('site_subcontractors', { company_id: co.id, site_id: balbi.id, subcontractor_id: sub.id });
    // Il tuo POS e il PSC letto (con due richieste)
    await ins('pos_documents', { company_id: co.id, site_id: balbi.id, revision: 1, content: 'x', pos_data: { subcontractorId: null, pscRichieste: [{ titolo: 'Recinzione alta 2 m' }, { titolo: 'Turni per la gru' }] } });
    const pscDoc = await ins('site_documents', { company_id: co.id, site_id: balbi.id, name: 'PSC.pdf', category: 'psc', file_path: `${co.id}/psc.pdf`, mime_type: 'application/pdf' });
    await ins('psc_letture', { company_id: co.id, site_id: balbi.id, site_document_id: pscDoc.id, dati: { richieste: [{ titolo: 'Recinzione alta 2 m', dettaglio: 'con il cartello', pagina: 2 }, { titolo: 'Turni per la gru', pagina: 3 }], interferenze: [] } });
    const subDoc = (sub, k) => ins('subcontractor_documents', { company_id: co.id, subcontractor_id: sub.id, site_id: balbi.id, name: `POS · ${k}`, category: 'pos', file_path: `${co.id}/pos-${k}.pdf`, mime_type: 'application/pdf', esito: 'va_bene', dall_impresa: true });
    await subDoc(verdi, 'verdi');
    await subDoc(rossi, 'rossi');

    const v = await P.controllo(co.id, balbi.id, verdi.id, { deps: deps('verdi'), attendi: true });
    check('Impianti Verdi: letto, «non torna»', v.stato === 'letto' && v.esito === 'non_torna', { stato: v.stato, esito: v.esito });
    check('il titolo è la cosa più grave', /gru|abilitat/i.test(v.titolo), v.titolo);
    check('la recinzione del PSC non recepita, con la pagina del PSC', v.controlli.some(c => c.esito === 'manca' && /Recinzione alta 2 m/.test(c.titolo)), v.controlli);
    check('il messaggio pronto: WhatsApp al numero dell\'impresa, email', /^https:\/\/wa\.me\/393331234567\?text=/.test(v.chiedi?.whatsapp || '') && /^mailto:verdi@example\.com\?/.test(v.chiedi.email) && /Prima di mandarlo al coordinatore/.test(v.chiedi.testo), v.chiedi);
    await P.controllo(co.id, balbi.id, verdi.id, { deps: deps('verdi'), attendi: true });
    check('il controllo si salva: riaprire non richiama il modello', chiamate === 1, { chiamate });

    const r = await P.controllo(co.id, balbi.id, rossi.id, { deps: deps('rossi'), attendi: true });
    check('Edil Rossi: «Torna su tutto»', r.esito === 'torna' && r.titolo === 'Torna su tutto', { esito: r.esito, titolo: r.titolo, controlli: r.controlli });

    let c = (await S.elenco(co.id)).cantieri.find(x => x.id === balbi.id);
    check('nella catena: «Il POS di … Impianti Verdi non torna con il tuo»', c?.frase === `Il POS di ${T} Impianti Verdi non torna con il tuo` && !c.aPosto && c.imprese.find(i => i.id === verdi.id)?.stato === 'non_torna', c && { frase: c.frase, imprese: c.imprese });
    let df = await buildDaFare(co.id, null, { role: 'owner' });
    let it = df.items.find(i => i.kind === 'impresa_pos' && i.entityId === verdi.id);
    check('su Oggi la riga, verso la pagina del controllo', it?.title === `Il POS di ${T} Impianti Verdi non torna con il tuo` && it.link === `/cantieri/${balbi.id}/imprese/${verdi.id}/pos`, it);

    await P.vaBene(co.id, balbi.id, verdi.id);
    const v2 = await P.controllo(co.id, balbi.id, verdi.id, { deps: deps('verdi'), attendi: true });
    check('«Va bene così» resta segnato', v2.accettato === true, v2.accettato);
    c = (await S.elenco(co.id)).cantieri.find(x => x.id === balbi.id);
    check('…la catena torna a posto', c?.aPosto && c.imprese.every(i => i.stato === 'ok'), c && { frase: c.frase, imprese: c.imprese });
    df = await buildDaFare(co.id, null, { role: 'owner' });
    check('…e Oggi non lo dice più', !df.items.some(i => i.kind === 'impresa_pos'), df.items.filter(i => i.kind === 'impresa_pos'));

    await ins('pos_documents', { company_id: co.id, site_id: balbi.id, revision: 1, content: 'x', pos_data: { subcontractorId: rossi.id } });
    const rp = await P.controllo(co.id, balbi.id, rossi.id, { deps: deps('rossi'), attendi: true });
    check('un POS fatto con Palladia non si rilegge', rp.stato === 'palladia' && chiamate === 2, { stato: rp.stato, chiamate });

    let negato = false;
    try { await P.controllo(altra.id, balbi.id, verdi.id, { deps: deps('verdi'), attendi: true }); } catch (e) { negato = e.status === 404; }
    check('un\'altra azienda non vede niente', negato);
  } finally {
    for (const id of [co.id, altra.id]) {
      await supabase.from('pos_controlli').delete().eq('company_id', id);
      await supabase.from('psc_letture').delete().eq('company_id', id);
      await supabase.from('pos_documents').delete().eq('company_id', id);
      await supabase.from('subcontractor_documents').delete().eq('company_id', id);
      await supabase.from('site_documents').delete().eq('company_id', id);
      await supabase.from('site_subcontractors').delete().eq('company_id', id);
      await supabase.from('subcontractors').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('company_feature_flags').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
