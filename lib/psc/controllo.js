'use strict';
/**
 * lib/psc/controllo.js — F-270. Il controllo prima della firma:
 *  1) contenuti minimi del PSC (Allegato XV, punto 2.1.2, lettere a–l),
 *     ognuno con lo stato e il passo dove si completa;
 *  2) "riletto come un ispettore": incoerenze tra le parti del piano
 *     (misure senza costo, lavorazioni senza misure approvate, date fuori dal
 *     periodo dei lavori, prezzi solo indicativi...).
 * Per un contenuto mancante propone la frase che il coordinatore usa di solito
 * (dalla sua libreria), se c'è. Funzione pura.
 */
const { PSC_CONTENUTI } = require('./catalog');

const approvato = (v) => v && v.approvata !== false && v.approvato !== false;
const has = (s, n = 1) => typeof s === 'string' && s.trim().length >= n;
const fmt = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : '');
// Sempre col punto delle migliaia (1.200,00): Intl it-IT non raggruppa i numeri di 4 cifre.
const eur = (n) => { const v = Number(n) || 0; const [i, d] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`; };

/**
 * @param {object} x { project, lavorazioni, imprese, costi, decisioni, interferenzeAperte, library, riep }
 */
function controlla(x) {
  const { project: p, lavorazioni = [], imprese = [], costi = [], decisioni = [], interferenzeAperte = [], library = [], riep } = x;
  const sog = p.soggetti || {};
  const ctx = p.contesto || {};
  const org = p.organizzazione || {};
  const em = p.emergenze || {};
  const coord = p.coordinamento || {};
  const frasePiuUsata = (sezione) => library.filter(l => l.kind === 'frase' && l.sezione === sezione).sort((a, b) => (b.uses || 0) - (a.uses || 0))[0] || null;

  const items = [];
  const push = (key, ok, mancanze, passo, extra = {}) => {
    const def = PSC_CONTENUTI.find(c => c.key === key);
    items.push({ key, titolo: def.titolo, ok: ok && mancanze.length === 0, mancanze, passo, ...extra });
  };

  // a) opera
  const ma = [];
  if (!has(p.address, 5)) ma.push('indirizzo del cantiere');
  if (!has(p.descrizione, 10)) ma.push('descrizione dell\'opera');
  if (!p.start_date || !p.end_date) ma.push('date di inizio e fine lavori');
  push('a', true, ma, 'opera');

  // b) soggetti
  const mb = [];
  if (!has(sog.committente && sog.committente.nome, 2)) mb.push('committente');
  if (!has(sog.cse && sog.cse.nome, 2)) mb.push('coordinatore per l\'esecuzione');
  if (!has(sog.csp && sog.csp.nome, 2)) mb.push('coordinatore per la progettazione');
  if (!imprese.some(i => i.ruolo === 'affidataria')) mb.push('impresa affidataria (si può indicare anche dopo, in una revisione)');
  push('b', true, mb, 'opera');

  // c) rischi: area + organizzazione + lavorazioni + interferenze
  const mc = [];
  if (!ctx.analizzato) mc.push('analisi dell\'area intorno al cantiere');
  if (!lavorazioni.length) mc.push('lavorazioni');
  const lavSenzaRischi = lavorazioni.filter(l => !(l.rischi || []).length);
  if (lavSenzaRischi.length) mc.push(`rischi per ${lavSenzaRischi.length === 1 ? `"${lavSenzaRischi[0].nome}"` : `${lavSenzaRischi.length} lavorazioni`}`);
  push('c', true, mc, 'lavorazioni');

  // d) scelte e misure: organizzazione + misure approvate per ogni lavorazione
  const md = [];
  const orgOk = Object.values(org).filter(v => v && v.attivo !== false && has(v.testo, 10) && approvato(v)).length;
  const orgDaApprovare = Object.values(org).filter(v => v && v.attivo !== false && has(v.testo, 10) && !approvato(v)).length;
  if (orgOk < 4) md.push(orgDaApprovare ? `organizzazione del cantiere: ${orgDaApprovare} voci proposte da approvare` : 'organizzazione del cantiere (recinzione, servizi, viabilità, impianti...)');
  const lavSenzaMisure = lavorazioni.filter(l => !(l.misure || []).some(m => m.approvata));
  if (lavSenzaMisure.length) md.push(`misure approvate per ${lavSenzaMisure.length === 1 ? `"${lavSenzaMisure[0].nome}"` : `${lavSenzaMisure.length} lavorazioni`}`);
  push('d', true, md, md[0] && md[0].startsWith('organiz') ? 'organizzazione' : 'lavorazioni');

  // e) interferenze
  const me = [];
  if (interferenzeAperte.length) me.push(`${interferenzeAperte.length === 1 ? '1 interferenza da decidere' : `${interferenzeAperte.length} interferenze da decidere`}`);
  push('e', true, me, 'cronoprogramma');

  // f) uso comune
  const mf = [];
  if (!(p.uso_comune || []).some(u => has(u.testo, 10) && approvato(u))) mf.push((p.uso_comune || []).some(u => has(u.testo, 10)) ? 'uso comune: testi proposti da approvare' : 'chi installa, chi usa e chi verifica apprestamenti e impianti comuni');
  push('f', true, mf, 'uso_comune');

  // g) coordinamento
  const mg = [];
  if (!has(coord.riunioni, 20)) mg.push('come e quando si fanno le riunioni di coordinamento');
  else if (!approvato(coord)) mg.push('testo proposto da approvare');
  push('g', true, mg, 'coordinamento', mg.length ? { proposta: frasePiuUsata('coordinamento') } : {});

  // h) emergenze
  const mh = [];
  if (!has(em.procedura, 20)) mh.push('procedura in caso di infortunio e incendio');
  if (!has(em.gestione, 20)) mh.push('chi gestisce le emergenze (gestione comune o di ogni impresa)');
  if (has(em.procedura, 20) && !approvato(em)) mh.push('testi proposti da approvare');
  if (!has(em.pronto_soccorso && em.pronto_soccorso.nome, 2)) mh.push('pronto soccorso più vicino');
  push('h', true, mh, 'emergenze', mh.length ? { proposta: frasePiuUsata('emergenze') } : {});

  // i) cronoprogramma + uomini-giorno
  const mi = [];
  const senzaDate = lavorazioni.filter(l => !l.start_date || !l.end_date);
  if (senzaDate.length) mi.push(`date per ${senzaDate.length === 1 ? `"${senzaDate[0].nome}"` : `${senzaDate.length} lavorazioni`}`);
  const ug = lavorazioni.reduce((s, l) => s + (Number(l.uomini_giorno) || 0), 0);
  if (!(ug > 0)) mi.push('entità presunta in uomini-giorno');
  push('i', true, mi, 'cronoprogramma', { valore: ug > 0 ? `${Math.round(ug)} uomini-giorno` : null });

  // l) costi
  const ml = [];
  if (!costi.length) ml.push('voci dei costi della sicurezza');
  else if (!(riep && riep.totale > 0)) ml.push('quantità e prezzi dei costi');
  push('l', true, ml, 'costi', { valore: riep && riep.totale > 0 ? `${eur(riep.totale)} €` : null });

  // ── Riletto come un ispettore ──────────────────────────────────────────────
  const oss = [];
  const costoTesti = costi.map(c => `${c.descrizione}`.toLowerCase()).join(' | ');
  for (const d of decisioni) {
    if (d.soluzione === 'misure' && /mantovana/i.test(d.testo) && !/mantovana/.test(costoTesti)) {
      oss.push({ livello: 'warn', testo: 'La mantovana parasassi è prevista per un\'interferenza ma non è nei costi della sicurezza.', passo: 'costi', azione: { tipo: 'aggiungi_costo', key: 'mantovana' } });
      break;
    }
  }
  if (decisioni.some(d => d.soluzione === 'misure' && /transenn|interdett/i.test(d.testo)) && !/transenn|delimitazion/.test(costoTesti)) {
    oss.push({ livello: 'warn', testo: 'Le delimitazioni previste per le interferenze non sono nei costi della sicurezza.', passo: 'costi', azione: { tipo: 'aggiungi_costo', key: 'transenne_interferenze' } });
  }
  const apprestamentiLav = new Set();
  for (const l of lavorazioni) for (const m of (l.misure || [])) if (m.approvata) {
    if (/linea vita/i.test(m.testo)) apprestamentiLav.add('linea vita');
    if (/parapett/i.test(m.testo)) apprestamentiLav.add('parapett');
  }
  for (const a of apprestamentiLav) if (!costoTesti.includes(a)) oss.push({ livello: 'warn', testo: `Le misure approvate prevedono ${a === 'parapett' ? 'parapetti provvisori' : 'una linea vita provvisoria'}, ma la voce non è nei costi.`, passo: 'costi', azione: { tipo: 'aggiungi_costo', key: a === 'parapett' ? 'parapetti' : 'linea_vita' } });

  if (p.end_date) {
    const oltre = lavorazioni.filter(l => l.end_date && l.end_date > p.end_date);
    if (oltre.length) oss.push({ livello: 'warn', testo: `${oltre.length === 1 ? `"${oltre[0].nome}" finisce` : `${oltre.length} lavorazioni finiscono`} dopo la fine lavori del ${fmt(p.end_date)}.`, passo: 'cronoprogramma' });
    else if (lavorazioni.length) {
      const ultima = lavorazioni.filter(l => l.end_date).sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
      if (ultima) oss.push({ livello: 'ok', testo: `"${ultima.nome}" finisce il ${fmt(ultima.end_date)}, entro la fine lavori del ${fmt(p.end_date)}.` });
    }
  }
  if (p.start_date) {
    const prima = lavorazioni.filter(l => l.start_date && l.start_date < p.start_date);
    if (prima.length) oss.push({ livello: 'warn', testo: `${prima.length === 1 ? `"${prima[0].nome}" inizia` : `${prima.length} lavorazioni iniziano`} prima dell'inizio lavori.`, passo: 'cronoprogramma' });
  }
  if (riep) {
    if (riep.indicativi > 0) oss.push({ livello: 'warn', testo: `${riep.indicativi === 1 ? '1 voce di costo ha' : `${riep.indicativi} voci di costo hanno`} ancora il prezzo indicativo di Palladia: confermalo o usa il tuo prezzario.`, passo: 'costi' });
    if (riep.daMisurare > 0) oss.push({ livello: 'warn', testo: `${riep.daMisurare === 1 ? '1 voce di costo è' : `${riep.daMisurare} voci di costo sono`} senza quantità.`, passo: 'costi' });
  }
  const proposteNonLette = lavorazioni.reduce((n, l) => n + (l.misure || []).filter(m => !m.approvata).length, 0);
  if (proposteNonLette === 0 && lavorazioni.length) oss.push({ livello: 'ok', testo: 'Tutte le misure delle lavorazioni sono approvate: nel PDF va solo quello che hai approvato.' });
  else if (proposteNonLette > 0) oss.push({ livello: 'info', testo: `${proposteNonLette} misure proposte non approvate: restano fuori dal PDF.`, passo: 'lavorazioni' });
  if (lavorazioni.length && lavorazioni.every(l => (l.misure || []).some(m => m.approvata))) oss.push({ livello: 'ok', testo: 'Ogni lavorazione ha rischi e misure approvati.' });
  const daSopralluogo = (ctx.da_sopralluogo || []).filter(d => !d.verificato);
  if (daSopralluogo.length) oss.push({ livello: 'info', testo: `${daSopralluogo.length} ${daSopralluogo.length === 1 ? 'cosa da verificare' : 'cose da verificare'} al primo sopralluogo (${daSopralluogo.map(d => d.titolo.toLowerCase()).join(', ')}).`, passo: 'opera' });
  const affidataria = imprese.find(i => i.ruolo === 'affidataria');
  if (!p.layout_path) oss.push({ livello: 'info', testo: 'Nessun layout di cantiere allegato: è consigliato (Allegato XV, 2.1.4).', passo: 'organizzazione' });
  if (imprese.length && !affidataria) oss.push({ livello: 'info', testo: 'Nessuna impresa indicata come affidataria.', passo: 'imprese' });

  const completi = items.filter(i => i.ok).length;
  return {
    contenuti: items,
    completi,
    totale: items.length,
    osservazioni: oss,
    puoFirmare: true, // si può firmare anche con punti aperti: restano nella revisione
    aperti: items.filter(i => !i.ok).map(i => ({ key: i.key, titolo: i.titolo, mancanze: i.mancanze })),
  };
}

module.exports = { controlla };
