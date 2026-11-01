#!/usr/bin/env node
/**
 * scripts/selftest_bolle.js — F-422 (AUDIT.md del frontend).
 *
 * Le bolle, dal caricamento al cantiere, su un'azienda di prova vera (DB, modello finto):
 *  - una bolla per «Via Balbi 31» va da sola nel tuo cantiere Via Balbi, con fornitore,
 *    numero, data, firma e materiali (quantità vere, anche 2,5 mc);
 *  - una bolla senza destinazione, con due cantieri, chiede il cantiere: non si salva finché
 *    non lo scegli; scelto, si salva;
 *  - «Qualcosa è sbagliato»: correggo una quantità e il fornitore → si salva corretta;
 *  - salvate nella tabella bolle, coi file al loro posto; la scheda «Bolle» del cantiere le
 *    mostra dalla più recente, stato «aspetto la fattura»; la foto si apre con un link firmato;
 *  - la stessa bolla caricata di nuovo è un doppione; un altro cantiere non ne vede nessuna.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const K = require('../lib/impreseCarica');
const B = require('../lib/bolle');
const { extractPdfText } = require('../lib/pdfExtract');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
async function pdf(t) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText(t, { x: 40, y: 780, size: 12, font: f });
  return Buffer.from(await d.save());
}
const RISPOSTE = {
  balbi: { tipo: 'bolla', ragione_sociale: 'EDILMATERIALI LIGURIA SRL', partita_iva: '01987654329', numero: '1482', data_documento: '2026-10-30', firmato: true, cantiere: 'Via Balbi 31, Genova',
    righe: [{ descrizione: 'Cemento 32.5R sacchi 25 kg', quantita: 40, unita: 'sacchi' }, { descrizione: 'Ferro B450C d.12', quantita: 600, unita: 'kg' }, { descrizione: 'Sabbia lavata', quantita: 2.5, unita: 'mc' }] },
  senza: { tipo: 'bolla', ragione_sociale: 'NOLEGGI GENOVA SRL', numero: 'A-77', data_documento: '2026-10-28', firmato: false, cantiere: null, righe: [{ descrizione: 'Nolo betoniera', quantita: 1, unita: 'pz' }] },
};
async function chiediFinto({ contenuto }) {
  const { text } = await extractPdfText(Buffer.from(contenuto[0].source.data, 'base64'), { maxPages: 2, minChars: 0 });
  return RISPOSTE[text.match(/DOC:(\w+)/)[1]];
}
const unoAllaVolta = async () => [{ da: 1, a: 1 }];
const UTENTE = 'a56d9d41-20aa-4b69-a5b9-913bf1707ac4'; // il titolare dell'azienda E2E (created_by)

(async () => {
  console.log('\n\x1b[1mF-422 — le bolle\x1b[0m');
  const T = `TEST-F422-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const balbi = await ins('sites', { company_id: co.id, name: `${T} Via Balbi`, address: 'Via Balbi 31, Genova', status: 'attivo' });
    const altro = await ins('sites', { company_id: co.id, name: `${T} Corso Sardegna`, address: 'Corso Sardegna 1, Genova', status: 'attivo' });
    const f = { balbi: await pdf(`DOC:balbi ${T}`), senza: await pdf(`DOC:senza ${T}`) };
    const { id } = await K.crea(co.id, UTENTE, {});
    for (const k of ['balbi', 'senza']) await K.aggiungi(co.id, id, { originalname: `${k}.pdf`, mimetype: 'application/pdf', buffer: f[k] }, { senzaLavoro: true });
    await K.lavora(co.id, id, { chiedi: chiediFinto, dividi: unoAllaVolta });
    let s = await K.stato(co.id, id);
    const bb = s.bolle.find(x => x.bolla?.fornitore === 'EDILMATERIALI LIGURIA SRL');
    check('la bolla per Via Balbi 31 va da sola nel cantiere Via Balbi, con numero, data e firma', bb?.bolla.cantiere?.id === balbi.id && bb.bolla.numero === '1482' && bb.bolla.data === '2026-10-30' && bb.bolla.firmata === true, bb);
    check('…con i 3 materiali e le quantità vere (2,5 mc di sabbia)', bb?.bolla.righe.length === 3 && bb.bolla.righe[2].quantita === 2.5 && bb.bolla.righe[2].unita === 'mc', bb?.bolla.righe);
    const sn = s.bolle.find(x => x.bolla?.fornitore === 'NOLEGGI GENOVA SRL');
    check('la bolla senza destinazione, con due cantieri: chiede il cantiere, non si salva ancora', sn && !sn.bolla.cantiere && !s.daSalvare.includes(sn.id) && s.daSalvare.includes(bb.id), { sn, daSalvare: s.daSalvare });

    const sbagliata = await K.correggi(co.id, id, sn.id, { siteId: '00000000-0000-0000-0000-000000000000' }).then(() => null, e => e);
    check('un cantiere che non è tuo è rifiutato', sbagliata?.code === 'CANTIERE_NON_VALIDO', sbagliata?.code);
    await K.correggi(co.id, id, sn.id, { siteId: altro.id });
    await K.correggi(co.id, id, bb.id, { fornitore: 'Edilmateriali Liguria', righe: [...bb.bolla.righe.slice(0, 2), { descrizione: 'Sabbia lavata', quantita: '3', unita: 'mc' }] });
    s = await K.stato(co.id, id);
    check('«Qualcosa è sbagliato»: il cantiere scelto, il fornitore e la quantità corretti', s.daSalvare.includes(sn.id) && s.bolle.find(x => x.id === bb.id)?.bolla.fornitore === 'Edilmateriali Liguria' && s.bolle.find(x => x.id === bb.id)?.bolla.righe[2].quantita === 3, s.bolle.map(x => x.bolla));

    const r = await K.salva(co.id, UTENTE, id);
    check('salva: 2 bolle, in 2 cantieri, verificate', r.salvati === 2 && r.bolle.length === 2 && r.resultCard.fatto.verified && /2 bolle in 2 cantieri/.test(r.resultCard.fatto.after), r);
    const { data: righe } = await supabase.from('bolle').select('site_id, fornitore, numero, data, firmata, righe, file_path, content_hash').eq('company_id', co.id);
    const rb = righe.find(x => x.site_id === balbi.id);
    check('nella tabella bolle: Via Balbi con Edilmateriali Liguria, n. 1482, firmata, 3 righe (sabbia 3 mc)', rb?.fornitore === 'Edilmateriali Liguria' && rb.numero === '1482' && rb.firmata === true && rb.righe.length === 3 && rb.righe[2].quantita === 3, rb);
    const { data: blob } = await supabase.storage.from('site-documents').download(rb.file_path);
    check('il file della bolla è al suo posto', !!blob && blob.size > 100, blob?.size);

    const el = await B.elenco(co.id, balbi.id);
    check('la scheda «Bolle» di Via Balbi: una bolla, «aspetto la fattura», con i materiali', el.bolle.length === 1 && el.bolle[0].stato === 'aspetto_fattura' && el.bolle[0].righe.length === 3 && el.cantiere.nome === `${T} Via Balbi`, el);
    const u = await B.file(co.id, el.bolle[0].id);
    check('la foto si apre con un link firmato', /token=/.test(u.url), u);
    const { data: altraCo } = await supabase.from('companies').insert({ name: `${T}-altra` }).select().single();
    const spia = await B.elenco(altraCo.id, balbi.id).then(() => null, e => e);
    await supabase.from('companies').delete().eq('id', altraCo.id);
    check('un\'altra azienda non vede le bolle di questo cantiere', spia?.status === 404, spia?.code);

    const { id: id2 } = await K.crea(co.id, UTENTE, {});
    await K.aggiungi(co.id, id2, { originalname: 'balbi-di-nuovo.pdf', mimetype: 'application/pdf', buffer: f.balbi }, { senzaLavoro: true });
    await K.lavora(co.id, id2, { chiedi: chiediFinto, dividi: unoAllaVolta });
    const s2 = await K.stato(co.id, id2);
    check('la stessa bolla caricata di nuovo: doppione, non si salva due volte', s2.doppioni.length === 1 && !s2.daSalvare.length, { doppioni: s2.doppioni, bolle: s2.bolle });
  } finally {
    const { data: fb } = await supabase.from('bolle').select('file_path').eq('company_id', co.id);
    if (fb?.length) await supabase.storage.from('site-documents').remove(fb.map(x => x.file_path));
    for (const t of ['bolle', 'imprese_caricamento_doc', 'imprese_caricamenti', 'company_feature_flags']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
