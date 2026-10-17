'use strict';
// ── Palladia semplice: la home «Oggi» (F-364, AUDIT.md, 17/10) ────────────────
// Mockup approvato dal titolare: https://claude.ai/artifact/BABpBew9VmrM1SyacVt3CR
// In cima la cosa da fare, non i numeri. Tutto quello che chiede un'azione sta
// in UNA lista, raggruppata: su MSC Da fare aveva 54 voci (33 giornate di
// pioggia, 4 fatture scadute, 6 fine lavori…), qui diventano 7 righe, ognuna
// una frase con un tasto, in ordine di importanza. Sola lettura: ogni riga
// porta alla pagina dove l'azione esiste già.

const supabase = require('./supabase');
const { buildDaFare, romeDate } = require('./daFare');
const contiSub = require('./contiSub');
const daPagare = require('./daPagare');
const { nomeBreve } = daPagare;

// «7.724,47 €», «12.480 €»: in it-IT i numeri di 4 cifre non avrebbero il punto senza useGrouping 'always'
const euro = (n) => { const v = Math.round(Number(n || 0) * 100) / 100; return `${v.toLocaleString('it-IT', { useGrouping: 'always', minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} €`; };
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const giorno = (d) => { const [, m, g] = String(d).slice(0, 10).split('-').map(Number); return `${g} ${MESI[m - 1]}`; };
const plur = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;
// «del 15 settembre», ma «dell'11 settembre», «dell'1», «dell'8»
const delGiorno = (d) => { const g = giorno(d); return /^(1|8|11) /.test(g) ? `Dell'${g}` : `Del ${g}`; };
const prima = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "DURC — Rossi Srl" → { cosa: "DURC", chi: "Rossi Srl" } */
function parti(title) {
  const [cosa, ...resto] = String(title || '').split(' — ');
  return { cosa: cosa.trim(), chi: resto.join(' — ').trim() };
}
/** «Uno, Due e altri 3» */
function elenco(nomi, max = 2) {
  const u = [...new Set(nomi.filter(Boolean))];
  if (u.length <= max + 1) return u.length > 1 ? `${u.slice(0, -1).join(', ')} e ${u[u.length - 1]}` : (u[0] || '');
  return `${u.slice(0, max).join(', ')} e altri ${u.length - max}`;
}
/** la prima frase di un sottotitolo di Da fare, senza i dettagli dopo «·» */
const frase = (s) => String(s || '').split(' · ')[0].trim();

/**
 * Pura. Dalle voci di Da fare (+ conti dei sub da controllare + presenze di
 * oggi) alla home: { titolo, prima, poi, altre, cantiere, soldi }.
 */
function componi({ items = [], conti = [], presenze = null, vedeSoldi = false, oggi = null }) {
  const attive = items.filter(i => i.bucket === 'scaduto' || i.bucket === 'settimana');
  // Una richiesta d'aiuto o un infortunio vanno in cima solo se sono di oggi o di ieri:
  // su MSC c'era «ha bisogno di aiuto per timbrare» del 15 settembre, già letta.
  const ieri = oggi ? new Date(Date.parse(`${oggi}T12:00:00Z`) - 864e5).toISOString().slice(0, 10) : null;
  const subito = (i) => i.kind === 'avviso' && (i.type === 'punch_help_request' || i.type === 'worker_injury') && (!ieri || !i.date || i.date >= ieri);
  const righe = [];
  const add = (ordine, r) => righe.push({ ordine, ...r });

  // 1. Qualcuno è bloccato o si è fatto male: una riga per ciascuno
  for (const i of attive.filter(subito)) {
    const dove = /Cantiere:\s*([^.]+)/.exec(i.subtitle || '');
    add(1, {
      id: i.id, titolo: i.title,
      sotto: i.type === 'punch_help_request' ? `${dove ? `${dove[1].trim()}. ` : ''}Registra tu la sua timbratura` : frase(i.subtitle),
      tasto: i.type === 'punch_help_request' ? 'Aiutalo a timbrare' : 'Guarda', link: i.link || '/scadenze',
    });
  }

  // 2. Fatture scadute o sollecitate: una riga sola
  const pag = items.filter(i => i.kind === 'pagamento');
  const pagUrgenti = pag.filter(i => i.days < 0 || i.sollecitato);
  if (pagUrgenti.length) {
    const scadute = pagUrgenti.filter(i => i.days < 0);
    const soll = [...new Set(pagUrgenti.filter(i => i.sollecitato).map(i => i.chiave || i.title))].length;
    const fornitori = [...new Set(pagUrgenti.map(i => i.chiave || i.title))];
    const totale = pagUrgenti.reduce((s, i) => s + Number(i.importo || 0), 0);
    const nome = pagUrgenti[0].nome || pagUrgenti[0].title;
    const uno = fornitori.length === 1;
    const titolo = uno
      ? (pagUrgenti.length > 1 ? `${pagUrgenti.length} fatture di ${nome} da pagare` : scadute.length ? `La fattura di ${nome} è scaduta` : `${nome} ti ha sollecitato`)
      : scadute.length ? `${plur(scadute.length, 'fattura scaduta', 'fatture scadute')} da pagare` : `${soll} fornitori ti hanno sollecitato`;
    const sollTesto = !soll ? '' : uno ? '. Ti ha sollecitato' : soll === fornitori.length ? '. Tutti ti hanno sollecitato' : `. ${plur(soll, 'ti ha sollecitato', 'ti hanno sollecitato')}`;
    add(2, {
      id: 'pagamenti', titolo,
      sotto: `${euro(totale)}${uno && pagUrgenti.length === 1 ? '' : `, ${elenco(fornitori.map(k => (pagUrgenti.find(i => (i.chiave || i.title) === k) || {}).nome || k), 1)}`}${uno && pagUrgenti.length === 1 ? sollTesto : (soll ? sollTesto : '')}`,
      tasto: pagUrgenti.length === 1 ? 'Vedi la fattura' : 'Vedi le fatture', link: '/scadenze?type=pagare',
    });
  }

  // 3. Conti dei sub che aspettano l'ok: uno per uno (sono pochi, e il sub aspetta per fatturare)
  for (const c of conti) {
    add(3, {
      id: `conto:${c.id}`, titolo: `Il conto di ${c.impresa} aspetta il tuo ok`,
      sotto: `${prima(c.meseTesto)}${c.chiesto != null ? `, ${euro(c.chiesto)}` : ''}. Senza il tuo ok non può fare la fattura`,
      tasto: 'Guarda il conto', link: '/scadenze?type=conti',
    });
  }

  // 4. Documenti scaduti (le fine lavori a parte)
  const docScaduti = attive.filter(i => i.kind === 'scadenza' && i.bucket === 'scaduto' && i.type !== 'fine_cantiere');
  if (docScaduti.length === 1) {
    const d = docScaduti[0]; const p = parti(d.title);
    add(4, { id: d.id, titolo: p.chi ? `${p.cosa} di ${p.chi}` : p.cosa, sotto: `${prima(frase(d.subtitle))}. Carica quello nuovo`, tasto: 'Vedi il documento', link: d.link || '/scadenze' });
  } else if (docScaduti.length > 1) {
    add(4, { id: 'documenti-scaduti', titolo: `${docScaduti.length} documenti scaduti`, sotto: elenco(docScaduti.map(d => parti(d.title).cosa)), tasto: 'Vedi i documenti', link: '/scadenze' });
  }

  // 5. Timbrature da sistemare (uscite chiuse in automatico, uscite mancanti, offline…)
  const timb = attive.filter(i => i.kind === 'timbratura' || i.kind === 'uscita');
  const nomeTimb = (i) => (i.kind === 'uscita' ? parti(i.title).chi : String(i.title).split(' · ')[0]).trim();
  if (timb.length === 1) {
    const t = timb[0];
    add(5, {
      id: t.id,
      titolo: t.kind === 'uscita' || t.type === 'missing_exit' ? `${nomeTimb(t)} non ha timbrato l'uscita` : String(t.title).replace(' · ', ': '),
      sotto: t.kind === 'uscita' ? `${prima(frase(t.subtitle))}. Scrivi a che ora è uscito` : prima(String(t.subtitle || '').split('. ')[0]),
      tasto: 'Sistema', link: '/scadenze?type=presenze',
    });
  } else if (timb.length > 1) {
    const persone = [...new Set(timb.map(nomeTimb))];
    add(5, {
      id: 'timbrature', titolo: persone.length === 1 ? `${persone[0]}: ${timb.length} timbrature da sistemare` : `${timb.length} timbrature da sistemare`,
      sotto: persone.length === 1 ? 'Scrivi a che ora è entrato o uscito' : elenco(persone), tasto: 'Sistema le timbrature', link: '/scadenze?type=presenze',
    });
  }

  // 6. Giornate di pioggia da confermare
  const meteo = attive.filter(i => i.kind === 'meteo');
  if (meteo.length) {
    const cantieri = new Set(meteo.map(i => parti(i.title).chi));
    const dal = meteo.map(i => i.date).filter(Boolean).sort()[0];
    add(6, {
      id: 'pioggia', titolo: meteo.length === 1 ? `Giornata di pioggia da confermare` : `${meteo.length} giornate di pioggia da confermare`,
      sotto: meteo.length === 1 ? `${giorno(dal)}, ${[...cantieri][0]}` : `${cantieri.size === 1 ? [...cantieri][0] : `In ${cantieri.size} cantieri`}, dal ${giorno(dal)}`,
      tasto: meteo.length === 1 ? 'Conferma o scarta' : 'Conferma le giornate', link: '/persone?tab=ore',
    });
  }

  // 7. Cantieri con la data di fine passata
  const fine = attive.filter(i => i.type === 'fine_cantiere');
  if (fine.length === 1) {
    add(7, { id: fine[0].id, titolo: `${parti(fine[0].title).chi}: fine lavori passata`, sotto: 'Aggiorna la data o chiudi il cantiere', tasto: 'Apri il cantiere', link: fine[0].link || '/cantieri' });
  } else if (fine.length > 1) {
    add(7, { id: 'fine-lavori', titolo: `${fine.length} cantieri con la fine lavori passata`, sotto: 'Aggiorna la data o chiudi quelli finiti', tasto: 'Vedi i cantieri', link: '/cantieri' });
  }

  // 8. Documenti che scadono entro 7 giorni
  const presto = attive.filter(i => i.kind === 'scadenza' && i.bucket === 'settimana' && i.type !== 'fine_cantiere');
  if (presto.length === 1) {
    const d = presto[0]; const p = parti(d.title);
    add(8, { id: d.id, titolo: p.chi ? `${p.cosa} di ${p.chi}` : p.cosa, sotto: prima(frase(d.subtitle)), tasto: 'Vedi il documento', link: d.link || '/scadenze' });
  } else if (presto.length > 1) {
    add(8, { id: 'documenti-presto', titolo: `${presto.length} documenti scadono questa settimana`, sotto: elenco(presto.map(d => parti(d.title).cosa)), tasto: 'Vedi le scadenze', link: '/scadenze' });
  }

  // 9. Il resto di Da fare (avvisi, coordinatore…): una riga
  const fatti = new Set(['pagamento', 'meteo', 'timbratura', 'uscita', 'scadenza']);
  const resto = attive.filter(i => !fatti.has(i.kind) && !subito(i));
  const vecchio = (i) => i.kind === 'avviso' && i.date && ieri && i.date < ieri;
  if (resto.length === 1) add(9, { id: resto[0].id, titolo: resto[0].title, sotto: vecchio(resto[0]) ? `${delGiorno(resto[0].date)}: guarda se è ancora da fare` : prima(frase(resto[0].subtitle)), tasto: 'Apri', link: resto[0].link || '/scadenze' });
  else if (resto.length > 1) add(9, { id: 'avvisi', titolo: `${resto.length} avvisi da guardare`, sotto: elenco(resto.map(i => i.title), 1), tasto: 'Vedi gli avvisi', link: '/scadenze' });

  righe.sort((a, b) => a.ordine - b.ordine);
  const pulite = righe.map(({ ordine, ...r }) => r);

  // Soldi: quanto c'è da pagare entro 7 giorni (scadute comprese)
  const settimana = pag.filter(i => i.days <= 7);
  const somma = settimana.reduce((x, i) => x + Number(i.importo || 0), 0);
  const scaduteSett = settimana.filter(i => i.days < 0).length;
  const soldi = !vedeSoldi ? null : {
    totale: Math.round(somma * 100) / 100,
    totaleTesto: euro(somma),
    sotto: !settimana.length ? 'niente entro 7 giorni' : scaduteSett ? `di cui ${plur(scaduteSett, 'scaduta', 'scadute')}` : 'entro 7 giorni',
  };

  const n = pulite.length;
  return {
    // F-364 menu a 4 voci: il numerino su «Oggi» è questo, lo stesso della home (7, non 54)
    quante: n,
    righe: pulite, // tutte, per il riquadro di Ladia (F-366)
    titolo: n === 0 ? 'Tutto a posto' : `Oggi ${plur(n, 'cosa', 'cose')} da fare`,
    prima: pulite[0] || null,
    poi: pulite.slice(1, 4),
    altre: Math.max(0, n - 4),
    cantiere: presenze,
    soldi,
  };
}

/** Chi è dentro adesso: ultimo evento di oggi per persona (dipendenti e operai dei sub). */
async function presenzeOggi(companyId) {
  const oggi = romeDate();
  const da = new Date(Date.parse(`${oggi}T00:00:00Z`) - 2 * 3600e3).toISOString();
  const [logs, sub] = await Promise.all([
    supabase.from('presence_logs').select('worker_id, site_id, event_type, timestamp_server')
      .eq('company_id', companyId).gte('timestamp_server', da).order('timestamp_server', { ascending: false }).limit(5000),
    supabase.from('sub_presenze').select('sub_worker_id, site_id, event, at')
      .eq('company_id', companyId).gte('at', da).order('at', { ascending: false }).limit(5000),
  ]);
  if (logs.error) throw logs.error;
  const dentro = new Set(); const cantieri = new Set(); const visti = new Set();
  for (const l of logs.data || []) {
    if (romeDate(new Date(l.timestamp_server)) !== oggi || visti.has(`w${l.worker_id}`)) continue;
    visti.add(`w${l.worker_id}`);
    if (l.event_type === 'ENTRY') { dentro.add(`w${l.worker_id}`); cantieri.add(l.site_id); }
  }
  for (const l of (sub.error ? [] : sub.data || [])) {
    if (romeDate(new Date(l.at)) !== oggi || visti.has(`s${l.sub_worker_id}`)) continue;
    visti.add(`s${l.sub_worker_id}`);
    if (l.event === 'entrata') { dentro.add(`s${l.sub_worker_id}`); cantieri.add(l.site_id); }
  }
  return { dentro: dentro.size, cantieri: cantieri.size };
}

async function contiDaControllare(companyId, role) {
  if (!contiSub.puoVedere(role) || !(await contiSub.attivoPer(companyId))) return [];
  const { data, error } = await supabase.from('sub_conti').select('id, impresa_nome, mese, totale_scritto')
    .eq('company_id', companyId).eq('stato', 'da_controllare').order('mese', { ascending: true }).limit(20);
  if (error) throw error;
  return (data || []).map(c => {
    const [y, m] = String(c.mese).split('-').map(Number);
    return { id: c.id, impresa: nomeBreve(c.impresa_nome), meseTesto: `${MESI[m - 1]} ${y}`, chiesto: c.totale_scritto != null ? Number(c.totale_scritto) : null };
  });
}

async function costruisci(companyId, userId, role) {
  const [daFare, conti, presenze, vedeSoldi] = await Promise.all([
    buildDaFare(companyId, userId, { role }),
    contiDaControllare(companyId, role),
    presenzeOggi(companyId),
    role && daPagare.RUOLI.includes(role) ? daPagare.attivoPer(companyId) : false,
  ]);
  return { oggi: daFare.today, ...componi({ items: daFare.items, conti, presenze, vedeSoldi, oggi: daFare.today }) };
}

module.exports = { componi, costruisci, presenzeOggi };
