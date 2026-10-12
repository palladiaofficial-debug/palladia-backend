#!/usr/bin/env node
/**
 * scripts/selftest_pos_pdf_contenuti.js — F-342 / F-343 (AUDIT.md del frontend).
 *
 * Verifica del 12/10 su un POS con i dati veri di MSCedilizia (Via Lucarno 45,
 * copertura e facciate): il PDF aveva parti generiche che non c'entravano col
 * cantiere (gru a torre "biennale", resine, amianto, cancello carraio 4 m),
 * norme superate (Accordi 2011/2012), firme ripetute due volte, in copertina
 * la ragione sociale al posto del datore di lavoro, nessuna sede legale,
 * nessuna formazione reale dei lavoratori, oggetto = elenco delle categorie.
 * Qui si genera l'HTML vero del POS (stesso codice del PDF) e si controlla.
 */
'use strict';
const { generatePosHtml } = require('../pos-html-generator');
const { composeSezione5 } = require('../lib/posSezione5');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ');
const count = (s, sub) => s.split(sub).length - 1;

const WORKS = ['allestimento-cantiere', 'ponteggio-montaggio', 'ponteggio-uso', 'rimozione-guaine-copertura', 'guaina-fiamma', 'lattonerie-canne-fumarie', 'spicconatura-intonaci', 'intonaci', 'tinteggiature', 'macerie'];
const base = {
  siteAddress: 'Via Lucarno 45, Genova', client: 'Condominio Via Ezio Lucarno 45', tipoAppalto: 'privato',
  workType: 'Lavori in quota, Demolizioni, Caldo e chimico, Finiture, Allestimento',
  descrizioneOpera: 'Manutenzione straordinaria della copertura e delle facciate',
  budget: '52000', startDate: '2026-04-20', endDate: '2027-06-24', inizioTurno: '08:00', oreLavorative: '8', pausaPranzo: '1 ora',
  companyName: 'MSCedilizia S.r.l.', companyVat: '02515980999', companyAddress: 'Corte Lambruschini 40 int 44, Genova', companyPhone: '010 555123',
  datoreLavoro: 'Ricardo Carpio', rspp: 'Catalano Arianna', rls: 'Di Leonardo Carlo', medico: 'Dott. Santagati Antonino',
  primoSoccorso: 'Daniel Miosi', antincendio: 'Daniel Miosi', preposto: 'Metwalli Elsaid Ahmed',
  selectedSchede: WORKS, selectedWorks: ['Allestimento e smobilizzo del cantiere', 'Lavori sul ponteggio'],
  workers: [
    { name: 'Aldo Mantelli', qualification: 'Geometra', matricola: '', corsi: ['Preposto'], formazioneScad: '2029-05-01', idoneitaScad: '2027-01-10' },
    { name: 'Binozi Armand', qualification: 'Operaio', matricola: '', corsi: [], formazioneScad: null, idoneitaScad: '2025-01-01' },
  ],
  rischiSpecifici: ['Lavori in quota (> 2m)'], opereProvvisionali: ['Ponteggio metallico fisso'],
  impiantiCantiere: ['Impianto elettrico di cantiere', 'Impianto di messa a terra'],
  lavoriInQuota: 'Sì, dal ponteggio', macchine: ['Betoniera', 'Montacarichi', 'Smerigliatrice (flessibile)'],
  sostanze: ['Bitumi, guaine e primer', 'Gas in bombole (propano, GPL)', 'Malte, cementi e calce'],
  rumore: 'Tra 80 e 85 dB(A)', noteAggiuntive: '', pscRichieste: [], presentedBy: 'impresa',
};

async function main() {
  console.log('\n\x1b[1mF-342/F-343 — contenuti del PDF del POS\x1b[0m');
  const html = await generatePosHtml(base, 1, composeSezione5(WORKS).markdown, []);
  const t = text(html);

  // Copertina e intestazione
  check('copertina: oggetto = descrizione del lavoro, non le categorie', /Oggetto Manutenzione straordinaria della copertura e delle facciate/.test(t) && !/Oggetto Lavori in quota, Demolizioni/.test(t));
  check('copertina: datore di lavoro = la persona', /Datore di lavoro Ricardo Carpio/i.test(t), t.slice(t.indexOf('Firme del documento'), t.indexOf('Firme del documento') + 120));
  check('sede legale e telefono dell\'impresa (All. XV 3.2.1 a.1)', t.includes('Sede legale Corte Lambruschini 40 int 44, Genova') && t.includes('Telefono 010 555123'));
  check('tipo di appalto e importo', t.includes('Tipo di appalto Privato') && /Importo lavori EUR 52\.000/.test(t));

  // Lavoratori e formazione reale
  check('niente colonna "Matricola" vuota per tutti', !t.includes('Matricola'));
  check('formazione di ogni lavoratore: corsi e scadenze', t.includes('Aldo Mantelli') && t.includes('Preposto') && /01\/05\/2029/.test(t) && /10\/01\/2027/.test(t));
  check('idoneità scaduta segnalata', /Binozi Armand[^|]*?scadut/i.test(t), t.slice(t.indexOf('Binozi Armand'), t.indexOf('Binozi Armand') + 160));
  check('2.4: niente "Nessuna fase di lavoro inserita" quando ci sono le lavorazioni', !t.includes('Nessuna fase di lavoro inserita'));

  // Sezione 4: prescrizioni, non descrizioni inventate
  check('4: niente cancello carraio di 4 m né frigorifero inventati', !t.includes('larghezza minima 4 m') && !t.includes('frigorifero') && !t.includes('su basi in calcestruzzo'));
  const sub4 = [...html.matchAll(/class="sub-title"[^>]*>4\.(\d+) /g)].map(m => Number(m[1]));
  check('4: numerazione senza buchi', sub4.every((n, i) => n === i + 1), sub4);

  // Sezione 9: verifiche e abilitazioni pertinenti
  check('9.2: niente gru a torre né PLE se non si usano', !/Gru a torre/.test(t.slice(t.indexOf('9.2 '), t.indexOf('Sezione 10 — '))) && !/Piattaforme elevabili/.test(t.slice(t.indexOf('9.2 '), t.indexOf('Sezione 10 — '))));
  check('9.2: il montacarichi usato ha la sua verifica', /9\.2[\s\S]*Montacarichi/.test(t));
  check('9: abilitazioni citano l\'Accordo 17/04/2025, non quello del 2012', !t.includes('22/02/2012'));
  const conGru = text(await generatePosHtml({ ...base, macchine: ['Gru a torre'] }, 1, '', []));
  check('gru a torre in edilizia: verifica periodica annuale (All. VII), non biennale', /Gru a torre [^]*?Annuale/.test(conGru.slice(conGru.indexOf('9.2'))) && !/Gru a torre[^.]{0,80}Biennale/.test(conGru));

  // Sezione 10: sostanze vere
  const s10 = t.slice(t.indexOf('Sezione 10 — '), t.indexOf('Sezione 11 — '));
  check('10: bitumi e gas in bombole descritti', /Bitumi/.test(s10) && /propano|GPL/.test(s10) && /H220/.test(s10));
  check('10: niente resine epossidiche, gasolio, amianto se non usati', !/Resine epossidiche|Gasolio|Amianto/.test(s10), s10.slice(0, 600));

  // Sezione 11: rifiuti del lavoro
  const s11 = t.slice(t.indexOf('Sezione 11 — '), t.indexOf('Sezione 12 — '));
  check('11: guaine rimosse = 17 03 02, lattonerie = metalli', s11.includes('17 03 02') && /17 04 0[124]/.test(s11));
  check('11: niente amianto se non c\'è', !/amianto/i.test(s11));

  // Sezione 12: formazione aggiornata
  const s12 = t.slice(t.indexOf('Sezione 12 — '), t.indexOf('Sezione 13 — '));
  check('12: Accordo Stato-Regioni 17/04/2025, non 21/12/2011', s12.includes('17/04/2025') && !s12.includes('21/12/2011'));
  check('12: preposto 12 ore', /Preposto 12 ore/.test(s12), s12.slice(0, 500));
  check('12: presa visione registrata dal badge spiegata', /badge/i.test(s12));

  // Recapiti non richiesti dall'All. XV: vuoti = trattino, non segnaposto
  const s32 = t.slice(t.indexOf('3.2 Recapiti'), t.indexOf('3.3 Compiti'));
  check('3.2: telefoni ed email mancanti come "—", non [DA COMPILARE]', !s32.includes('[DA COMPILARE] [DA COMPILARE]') && s32.includes('Catalano Arianna — —'), s32.slice(0, 300));

  // Firme una volta sola
  check('firme delle figure una sola volta (prima erano ripetute alla fine)', count(t, 'RSPP — Responsabile Servizio Prevenzione e Protezione') === 1, count(t, 'RSPP — Responsabile Servizio Prevenzione e Protezione'));
  check('dichiarazione di presa visione dei lavoratori resta', t.includes('Dichiarazione presa visione dei lavoratori') && t.includes('Binozi Armand'));

  // Compatibilità: POS del vecchio generatore (senza i campi nuovi) si genera ancora
  const old = text(await generatePosHtml({ siteAddress: 'Via X', companyName: 'Ditta', workType: 'Ristrutturazione', workers: [{ name: 'Mario', qualification: 'Muratore', matricola: 'M12' }] }, 2, '', []));
  check('vecchio generatore: oggetto = natura dei lavori, matricola mostrata se c\'è', /Oggetto Ristrutturazione/.test(old) && old.includes('M12'));
  check('vecchio generatore: tabelle 9.2, 10 e 11 ancora presenti', old.includes('9.2') && old.includes('Sezione 10') && old.includes('17 09 04'));

  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
