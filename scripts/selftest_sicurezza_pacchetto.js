#!/usr/bin/env node
/**
 * scripts/selftest_sicurezza_pacchetto.js — F-428 (AUDIT.md del frontend).
 *
 * La sicurezza del cantiere mandata al coordinatore, su un'azienda di prova vera (DB):
 *  - Via Balbi: il tuo POS (file), Edil Rossi col POS controllato che torna, Impianti Verdi col POS
 *    che non torna → nel link il tuo POS e quello di Edil Rossi, Impianti Verdi «in attesa»;
 *  - il destinatario è il coordinatore letto dal PSC; il messaggio pronto ha il link;
 *  - la pagina pubblica: azienda, cantiere, i due POS con «già confrontato», la prima apertura si segna;
 *  - ogni file si apre con un link firmato; un token inventato o di un altro cantiere no;
 *  - la sicurezza del cantiere dice «mandato il …, aperto il …»;
 *  - senza il tuo POS non si manda.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { PDFDocument } = require('pdf-lib');
const supabase = require('../lib/supabase');
const K = require('../lib/sicurezzaPacchetto');
const S = require('../lib/sicurezzaCantieri');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const UTENTE = 'a56d9d41-20aa-4b69-a5b9-913bf1707ac4';

(async () => {
  console.log('\n\x1b[1mF-428 — la sicurezza mandata al coordinatore\x1b[0m');
  const T = `TEST-F428-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const caricati = [];
  const carica = async (nome) => {
    const d = await PDFDocument.create(); d.addPage([595, 842]);
    const path = `${co.id}/${T}-${nome}.pdf`;
    const up = await supabase.storage.from('site-documents').upload(path, Buffer.from(await d.save()), { contentType: 'application/pdf' });
    if (up.error) throw new Error(up.error.message);
    caricati.push(path);
    return path;
  };
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const balbi = await ins('sites', { company_id: co.id, name: `${T} Via Balbi 31`, address: 'Via Balbi 31, Genova', status: 'attivo' });
    const vuoto = await ins('sites', { company_id: co.id, name: `${T} Via Vuota 1`, address: 'Via Vuota 1', status: 'attivo' });
    const rossi = await ins('subcontractors', { company_id: co.id, company_name: `${T} Edil Rossi` });
    const verdi = await ins('subcontractors', { company_id: co.id, company_name: `${T} Impianti Verdi` });
    for (const sub of [rossi, verdi]) await ins('site_subcontractors', { company_id: co.id, site_id: balbi.id, subcontractor_id: sub.id });
    await ins('site_documents', { company_id: co.id, site_id: balbi.id, name: 'POS MSC.pdf', category: 'pos', file_path: await carica('pos-tuo'), mime_type: 'application/pdf' });
    const psc = await ins('site_documents', { company_id: co.id, site_id: balbi.id, name: 'PSC.pdf', category: 'psc', file_path: await carica('psc'), mime_type: 'application/pdf' });
    await ins('psc_letture', { company_id: co.id, site_id: balbi.id, site_document_id: psc.id, dati: { cse: { nome: 'Arch. Bianchi' }, richieste: [], interferenze: [] } });
    const docR = await ins('subcontractor_documents', { company_id: co.id, subcontractor_id: rossi.id, site_id: balbi.id, name: 'POS Edil Rossi', category: 'pos', file_path: await carica('pos-rossi'), mime_type: 'application/pdf', esito: 'va_bene', dall_impresa: true });
    const docV = await ins('subcontractor_documents', { company_id: co.id, subcontractor_id: verdi.id, site_id: balbi.id, name: 'POS Impianti Verdi', category: 'pos', file_path: await carica('pos-verdi'), mime_type: 'application/pdf', esito: 'va_bene', dall_impresa: true });
    await ins('pos_controlli', { company_id: co.id, site_id: balbi.id, subcontractor_id: rossi.id, subcontractor_document_id: docR.id, esito: 'torna', controlli: [] });
    await ins('pos_controlli', { company_id: co.id, site_id: balbi.id, subcontractor_id: verdi.id, subcontractor_document_id: docV.id, esito: 'non_torna', controlli: [{ key: 'abil_gru', esito: 'manca', titolo: 'Nessun lavoratore abilitato gru a torre' }] });

    const m = await K.crea(co.id, UTENTE, balbi.id);
    const token = m.url.split('/').pop();
    check('il link e il messaggio pronto', /\/sicurezza-per\/[A-Za-z0-9_-]{20,}$/.test(m.url) && m.testo.includes(m.url) && /^https:\/\/wa\.me\/\?text=/.test(m.whatsapp), m);
    check('il destinatario è il coordinatore del PSC', m.destinatario === 'Arch. Bianchi', m.destinatario);
    check('Impianti Verdi resta fuori, «in attesa»', m.inAttesa.length === 1 && m.inAttesa[0] === `${T} Impianti Verdi`, m.inAttesa);

    const p = await K.pubblico(token);
    check('la pagina: azienda, cantiere, il tuo POS e quello di Edil Rossi', p.azienda === T && p.cantiere === `${T} Via Balbi 31` && p.documenti.length === 2 && p.documenti[0].tipo === 'tuo' && p.documenti[1].titolo === `${T} Edil Rossi`, p);
    check('…con «controllato» e chi è in attesa', /Controllato da/.test(p.documenti[1].sotto) && p.inAttesa.join() === `${T} Impianti Verdi`, p.documenti);
    const { data: pk } = await supabase.from('pacchetti_sicurezza').select('aperto_at').eq('company_id', co.id).single();
    check('la prima apertura si segna', !!pk.aperto_at, pk);
    const f = await K.file(token, p.documenti[1].chiave);
    check('ogni file si apre con un link firmato', /token=/.test(f.url), f);
    let negato = 0;
    for (const t of ['inventato-inventato-inventato', token.slice(0, -2) + 'xx']) { try { await K.pubblico(t); } catch (e) { if (e.status === 404) negato++; } }
    try { await K.file(token, 'z9'); } catch (e) { if (e.status === 404) negato++; }
    check('token inventati e chiavi sbagliate: niente', negato === 3, negato);

    const c = await S.cantiere(co.id, balbi.id);
    check('la sicurezza del cantiere: mandato, aperto', c.coordinatore?.destinatario === 'Arch. Bianchi' && !!c.coordinatore.mandatoIl && !!c.coordinatore.apertoIl, c.coordinatore);

    let senza = null;
    try { await K.crea(co.id, UTENTE, vuoto.id); } catch (e) { senza = e.code; }
    check('senza il tuo POS non si manda', senza === 'SENZA_POS', senza);
  } finally {
    await supabase.from('pacchetti_sicurezza').delete().eq('company_id', co.id);
    await supabase.from('pos_controlli').delete().eq('company_id', co.id);
    await supabase.from('psc_letture').delete().eq('company_id', co.id);
    await supabase.from('subcontractor_documents').delete().eq('company_id', co.id);
    await supabase.from('site_documents').delete().eq('company_id', co.id);
    await supabase.from('site_subcontractors').delete().eq('company_id', co.id);
    await supabase.from('subcontractors').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    await supabase.from('company_feature_flags').delete().eq('company_id', co.id);
    await supabase.from('companies').delete().eq('id', co.id);
    if (caricati.length) await supabase.storage.from('site-documents').remove(caricati);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
