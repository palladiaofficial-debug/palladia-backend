#!/usr/bin/env node
/**
 * scripts/selftest_contratti.js — F-398 (AUDIT.md del frontend).
 *
 * Il 28/10 il contratto di subappalto l'ha scritto Ladia a mano in chat (il
 * generatore era congelato) e ha messo la P.IVA dell'impresa in subappalto
 * anche sull'affidataria. Ora c'è «Fai il contratto» da Imprese:
 *  - le clausole e il loro testo (puri): scelte con un tocco, consigliate di
 *    default, costi della sicurezza sempre presenti (art. 26 c.5 D.Lgs. 81/08),
 *    reverse charge, art. 29 D.Lgs. 276/03, art. 1656 c.c. / art. 119 per i
 *    lavori pubblici, righe vuote per le date e la tabella da compilare;
 *  - il controllo dei dati: P.IVA vere, MAI la stessa per le due parti;
 *  - la visura letta (modello finto) e salvata come documento dell'impresa;
 *  - il PDF vero, archiviato nell'impresa e nel cantiere, e chi firma ricordato.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const C = require('../lib/contratti/clausole');
const { contrattoHtml } = require('../lib/contratti/documento');
const { pulisci } = require('../lib/contratti/visura');
const K = require('../lib/contratti');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// Una partita IVA valida con le prime 10 cifre date
function piva(dieci) {
  let t = 0;
  for (let i = 0; i < 10; i++) { let d = Number(dieci[i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } t += d; }
  return dieci + ((10 - (t % 10)) % 10);
}
const stamp = String(Date.now()).slice(-6);
const PIVA_NOI = piva(`0${stamp}123`), PIVA_SUB = piva(`0${stamp}456`);
const testoTutto = (arts) => arts.map(a => `${a.titolo}: ${a.testo.join(' ')}`).join('\n');

function base(over = {}) {
  return {
    affidataria: { ragioneSociale: 'Edilizia Prova srl', sede: 'Via Roma 1, Genova', piva: PIVA_NOI, legaleRappresentante: 'Mario Rossi', citta: 'Genova' },
    subappaltatrice: { ragioneSociale: 'Impianti Bianchi srl', sede: 'Via Prova 2, Genova', piva: PIVA_SUB, legaleRappresentante: 'Paolo Bianchi', pec: 'bianchi@pec.it' },
    lavoro: { cantiere: 'Piazza Galileo Ferraris 1, Genova', descrizione: 'Impianto elettrico, rifacimento interni', inizio: null, fine: null, costiSicurezza: null },
    prezzo: { modo: 'tabella' },
    ...over,
  };
}

function puri() {
  console.log('\n\x1b[1mF-398 — clausole e testo\x1b[0m');
  check('P.IVA: cifra di controllo giusta e sbagliata', C.pivaValida(PIVA_NOI) && !C.pivaValida(PIVA_NOI.slice(0, 10) + ((Number(PIVA_NOI[10]) + 1) % 10)) && C.pivaValida(`IT${PIVA_SUB}`));
  const s0 = C.scelteComplete({ pagamento: 'boh', penale: 'no' });
  check('scelte: una sbagliata prende la consigliata, una valida resta', s0.pagamento === '30fm' && s0.penale === 'no' && s0.iva === 'reverse' && s0.solidale === 'si', s0);

  const a1 = C.articoli(base(), {});
  const t1 = testoTutto(a1);
  check('articoli numerati da 1', a1.every((a, i) => a.n === i + 1) && a1.length >= 10, a1.map(a => a.titolo));
  check('costi della sicurezza sempre scritti, a mano se mancano (art. 26 c.5)', /costi della sicurezza.*€ _{6,}.*art\. 26, comma 5/s.test(t1), t1.match(/costi della sicurezza[^.]*\./)?.[0]);
  check('date in bianco: righe da compilare', /hanno inizio in data _{6,} e devono essere ultimati entro il _{6,}/.test(t1));
  check('prezzi in tabella: tabella vuota da 8 righe', a1.find(a => a.titolo === 'Corrispettivo').tabella?.vuota === 8);
  check('reverse charge di default', /inversione contabile.*art\. 17, comma 6/.test(t1));
  check('lavoro privato: autorizzazione del committente art. 1656 c.c., niente art. 119', /1656/.test(t1) && !/119/.test(t1));
  check('autonomia organizzativa (niente somministrazione mascherata)', /organizzazione dei mezzi necessari e gestione a proprio rischio/.test(t1));
  check('consigliate: F24 e buste ogni mese, divieto di sub-subappalto, polizza 2 milioni, ritenuta 5%', /art\. 29, comma 2, D\.Lgs\. 276\/2003/.test(t1) && /senza il preventivo consenso scritto/.test(t1) && /€ 2\.000\.000,00/.test(t1) && /ritenuta a garanzia del 5%/.test(t1));
  check('PEC nelle comunicazioni', /bianchi@pec\.it/.test(t1));

  const a2 = C.articoli(base({ lavoro: { cantiere: 'Via X 1', descrizione: 'Rifacimento copertura e lattonerie', inizio: '2026-11-02', durataGiorni: 30, costiSicurezza: 850 }, prezzo: { modo: 'corpo', importo: 14000 } }),
    { pubblico: 'si', iva: 'ordinaria', penale: '03', solidale: 'no', subsub: 'no', polizza: 'no', ritenuta: 'no', recesso: 'no', foro: 'legge' });
  const t2 = testoTutto(a2);
  check('a corpo: importo e costi della sicurezza in euro', /a corpo in € 14\.000,00/.test(t2) && /€ 850,00/.test(t2));
  check('copertura → ponteggio e PiMUS', /PiMUS/.test(t2));
  check('pubblico → art. 119 e tracciabilità L. 136/2010', /art\. 119 del D\.Lgs\. 36\/2023/.test(t2) && /L\. 136\/2010/.test(t2));
  check('penale 0,3‰ calcolata sull\'importo', /0,3 per mille.*€ 4,20 al giorno/.test(t2), t2.match(/penale[^.]*\./)?.[0]);
  check('scelte spente: niente F24, niente polizza, niente ritenuta, niente recesso', !/F24/.test(t2) && !/RCT\/RCO/.test(t2) && !/ritenuta/.test(t2) && !/1671/.test(t2));
  check('date: inizio scritto, fine in giorni', /in data 2 novembre 2026/.test(t2) && /entro 30 giorni naturali e consecutivi/.test(t2));

  const a3 = C.articoli(base({ prezzo: { modo: 'misura', voci: [{ descrizione: 'Punto luce', um: 'cad', quantita: 40, prezzo: 35.5 }, { descrizione: 'Quadro', um: 'cad', quantita: 1, prezzo: 900 }] } }), {});
  const corr = a3.find(a => a.titolo === 'Corrispettivo');
  check('a misura: totale ricalcolato (40×35,50 + 900 = 2.320)', corr.tabella.totale === 2320 && /€ 2\.320,00/.test(corr.testo.join(' ')), corr.tabella);

  const html = contrattoHtml(base({ subappaltatrice: { ...base().subappaltatrice, ragioneSociale: 'Bianchi <script>x</script> srl' } }), {});
  check('PDF: doppia firma artt. 1341-1342 con i numeri degli articoli', /1341 e 1342 c\.c\..*art\. \d+ \(Pagamenti\).*art\. \d+ \(Foro competente\)/s.test(html));
  check('PDF: il testo è sempre escapato', !html.includes('<script>x') && html.includes('&lt;script&gt;'));
  check('PDF: lavori privati nel sottotitolo', /per lavori privati/.test(html));

  const sug = C.suggerimenti(base({ lavoro: { cantiere: 'x', descrizione: 'tetto' } }), { polizza: 'no' }, { durcScadenza: '2026-01-01', oggi: '2026-10-28' });
  check('suggerimenti: DURC scaduto, quota, costi sicurezza, polizza', ['scaduto', 'alto', 'costi della sicurezza', 'assicurazione'].every(w => sug.some(x => x.testo.toLowerCase().includes(w.toLowerCase()))), sug);

  // ── controlla(): il 28/10 la P.IVA del sub era anche sull'affidataria ──
  const errOf = (b, o) => { try { K.controlla(b, o); return null; } catch (e) { return e; } };
  const e1 = errOf(base({ affidataria: { ...base().affidataria, piva: PIVA_SUB } }));
  check('F-398: la stessa P.IVA su tutte e due le parti è rifiutata', e1?.code === 'STESSA_PIVA', e1?.code);
  const e2 = errOf(base({ subappaltatrice: { ...base().subappaltatrice, piva: '12345678901', legaleRappresentante: '' } }));
  check('P.IVA non valida e firmatario mancante → campi da sistemare', e2?.code === 'DATI_MANCANTI' && e2.campi.includes('subappaltatrice.piva') && e2.campi.includes('subappaltatrice.legaleRappresentante'), e2?.campi);
  const e3 = errOf(base(), { pivaAzienda: piva('0999999999') });
  check('la P.IVA dell\'affidataria deve essere quella del profilo azienda', e3?.code === 'PIVA_AZIENDA_DIVERSA', e3?.code);
  const e4 = errOf(base({ prezzo: { modo: 'corpo', importo: 0 }, lavoro: { cantiere: 'x', descrizione: '' } }));
  check('a corpo senza importo e senza lavoro → rifiutato', e4?.campi?.includes('prezzo.importo') && e4.campi.includes('lavoro.descrizione'), e4?.campi);

  // ── visura: la risposta del modello ripulita ──
  const v = pulisci({ e_una_visura: true, ragione_sociale: 'CEAM S.R.L.S.', partita_iva: 'IT 12345678901', codice_fiscale: '02976910998', sede: 'Via Bacigalupo 4/17, 16122 Genova (GE)', rea: 'ge-123456', pec: 'CEAM@PEC.IT', legale_rappresentante: 'CAAMANO VERA FRANCISCO JAVIER', data_estrazione: '2026-10-01' });
  check('visura: P.IVA con cifra di controllo sbagliata → vuota e segnalata, mai inventata', v.piva === null && v.pivaLettaMaSbagliata === true, v);
  check('visura: nome in maiuscolo → «Caamano Vera Francisco Javier», REA e PEC normalizzati', v.legaleRappresentante === 'Caamano Vera Francisco Javier' && v.rea === 'GE-123456' && v.pec === 'ceam@pec.it', v);
  check('visura: «non è una visura» riconosciuto', pulisci({ e_una_visura: false }).eUnaVisura === false);
}

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function db() {
  console.log('\n\x1b[1mF-398 — contratto contro il DB\x1b[0m');
  const T = `TEST-F398-${Date.now()}`;
  const co = await ins('companies', { name: T, piva: PIVA_NOI, address: 'Via Roma 1', city: 'Genova', province: 'GE' });
  const altra = await ins('companies', { name: `${T}-altra` });
  const paths = [];
  try {
    const site = await ins('sites', { company_id: co.id, name: `${T} Galileo`, address: 'Piazza Galileo Ferraris 1', city: 'Genova', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: co.id, company_name: 'Impresa da completare', da_completare: true, is_active: true, durc_expiry: '2026-01-01' });
    await ins('site_subcontractors', { company_id: co.id, site_id: site.id, subcontractor_id: sub.id });

    const p = await K.prepara(co.id, sub.id);
    check('prepara: l\'affidataria dal profilo (P.IVA, sede), manca chi firma', p.affidataria.piva === PIVA_NOI && /Via Roma 1, Genova/.test(p.affidataria.sede) && p.mancano.affidataria.includes('legaleRappresentante'), p.affidataria);
    check('prepara: impresa da completare → mancano nome, P.IVA, sede, firmatario', ['ragioneSociale', 'piva', 'sede', 'legaleRappresentante'].every(k => p.mancano.subappaltatrice.includes(k)), p.mancano);
    check('prepara: il suo cantiere per primo, clausole consigliate, nessun contratto prima', p.cantieri[0]?.id === site.id && p.cantieri[0].suo && p.scelte.pagamento === '30fm' && !p.comeUltimaVolta && p.precedenti.length === 0, p.cantieri);

    // Visura (modelli finti): legge i dati e la salva come documento dell'impresa
    const finto = { buffer: Buffer.from('%PDF-1.4 visura finta'), mimetype: 'application/pdf', originalname: 'visura.pdf', size: 22 };
    const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    const chiedi = async () => ({ e_una_visura: true, ragione_sociale: 'Impianti Bianchi S.r.l.', partita_iva: PIVA_SUB, sede: 'Via Prova 2, 16100 Genova (GE)', rea: 'GE-998877', pec: 'bianchi@pec.it', legale_rappresentante: 'PAOLO BIANCHI', data_estrazione: oggi });
    const chiediControllo = async () => ({ tipo: 'visura', ragione_sociale: 'Impianti Bianchi S.r.l.', partita_iva: PIVA_SUB, data_documento: oggi });
    const v = await K.visura(co.id, null, sub.id, finto, { chiedi, chiediControllo });
    check('visura: dati letti per il contratto', v.letto.ragioneSociale === 'Impianti Bianchi S.r.l.' && v.letto.piva === PIVA_SUB && v.letto.legaleRappresentante === 'Paolo Bianchi' && !v.altraImpresa, v);
    const { data: docs } = await supabase.from('subcontractor_documents').select('category, esito, file_path').eq('subcontractor_id', sub.id);
    paths.push(...(docs || []).map(d => d.file_path));
    check('visura: salvata anche come «Visura camerale» dell\'impresa, controllata', docs?.length === 1 && docs[0].category === 'visura' && docs[0].esito === 'va_bene', docs);
    const nonVisura = await rifiuta(() => K.visura(co.id, null, sub.id, finto, { chiedi: async () => ({ e_una_visura: false }) }));
    check('un foglio che non è una visura: rifiutato e non salvato', nonVisura?.code === 'NON_E_UNA_VISURA');

    // Genera (PDF vero)
    const body = {
      affidataria: { ...p.affidataria, legaleRappresentante: 'Mario Rossi' },
      subappaltatrice: { ragioneSociale: v.letto.ragioneSociale, piva: v.letto.piva, sede: v.letto.sede, rea: v.letto.rea, pec: v.letto.pec, legaleRappresentante: v.letto.legaleRappresentante },
      lavoro: { siteId: site.id, cantiere: p.cantieri[0].indirizzo, descrizione: 'Impianto elettrico, rifacimento interni', costiSicurezza: 600 },
      prezzo: { modo: 'tabella' },
      scelte: { pagamento: 'sal', penale: '03' },
    };
    const stessa = await rifiuta(() => K.genera(co.id, null, sub.id, { ...body, subappaltatrice: { ...body.subappaltatrice, piva: PIVA_NOI } }));
    check('genera: la P.IVA dell\'affidataria sull\'impresa in subappalto è rifiutata', stessa?.code === 'STESSA_PIVA', stessa?.code);
    const g = await K.genera(co.id, null, sub.id, body);
    const { data: row } = await supabase.from('contratti_subappalto').select('*').eq('id', g.id).single();
    paths.push(row.file_path);
    check('genera: contratto salvato con dati e clausole scelte', row.clausole.pagamento === 'sal' && row.clausole.penale === '03' && row.clausole.iva === 'reverse' && row.dati.subappaltatrice.piva === PIVA_SUB && row.dati.affidataria.piva === PIVA_NOI, row.clausole);
    const file = await supabase.storage.from('site-documents').download(row.file_path);
    const bytes = file.data ? Buffer.from(await file.data.arrayBuffer()) : Buffer.alloc(0);
    check('genera: il PDF c\'è davvero ed è un PDF', bytes.slice(0, 4).toString() === '%PDF' && bytes.length > 5000, bytes.length);
    check('genera: ResultCard verificata, con il PDF da scaricare', g.resultCard.fatto.verified === true && /cantiere/.test(g.resultCard.fatto.after) && !!g.resultCard.inMano.downloadUrl && !!g.url, g.resultCard);
    const { data: sd } = await supabase.from('site_documents').select('category, file_path').eq('site_id', site.id);
    check('genera: anche nei documenti del cantiere, come «contratto»', sd?.some(x => x.category === 'contratto' && x.file_path === row.file_path), sd);
    const { data: subDopo } = await supabase.from('subcontractors').select('company_name, piva, legale_rappresentante, rea, da_completare').eq('id', sub.id).single();
    const { data: coDopo } = await supabase.from('companies').select('legale_rappresentante').eq('id', co.id).single();
    check('genera: chi firma resta scritto (impresa completata, firmatario dell\'azienda)', subDopo.company_name === 'Impianti Bianchi S.r.l.' && subDopo.piva === PIVA_SUB && subDopo.legale_rappresentante === 'Paolo Bianchi' && !subDopo.da_completare && coDopo.legale_rappresentante === 'Mario Rossi', { subDopo, coDopo });
    check('genera: avvisa del DURC scaduto', g.suggerimenti.some(s => s.tipo === 'avviso' && /DURC/.test(s.testo)), g.suggerimenti);

    const p2 = await K.prepara(co.id, sub.id);
    check('la volta dopo: niente da scrivere, le scelte dell\'ultima volta, il contratto in elenco', p2.mancano.affidataria.length === 0 && p2.mancano.subappaltatrice.length === 0 && p2.comeUltimaVolta && p2.scelte.pagamento === 'sal' && p2.precedenti.length === 1, { mancano: p2.mancano, scelte: p2.scelte });
    const s = await K.scarica(co.id, g.id);
    check('scarica: link al PDF', /^https?:\/\//.test(s.url));
    const fuori = await rifiuta(() => K.scarica(altra.id, g.id));
    check('un\'altra azienda non lo vede', fuori?.status === 404);
    const fuori2 = await rifiuta(() => K.prepara(altra.id, sub.id));
    check('un\'altra azienda non apre l\'impresa', fuori2?.status === 404);
  } finally {
    if (paths.length) await supabase.storage.from('site-documents').remove(paths.filter(Boolean)).catch(() => {});
    for (const t of ['contratti_subappalto', 'site_documents', 'subcontractor_documents', 'site_subcontractors', 'admin_audit_log']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('subcontractors').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    await supabase.from('companies').delete().in('id', [co.id, altra.id]);
  }
}

(async () => {
  puri();
  await db();
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
