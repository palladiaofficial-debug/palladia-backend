'use strict';
// ── Foglio presenze per il consulente del lavoro (F-265, F-335) ─────────────
// PDF (HTML → Puppeteer) ed Excel dallo stesso riepilogo di lib/oreMese.js.
//
// Pensato per qualunque impresa e qualunque consulente:
//   - calendario giorno per giorno con causali inequivocabili e legenda
//     (come il calendario presenze del Libro unico del lavoro);
//   - riassunto di ogni lavoratore a destra;
//   - ore per cantiere (denuncia mensile Cassa Edile, congruità);
//   - nell'Excel un foglio "Movimenti": una riga per lavoratore, giorno e
//     causale, con il codice fiscale — leggibile e importabile da qualunque
//     programma paghe;
//   - in testa le regole con cui le ore sono state contate (orario, pausa,
//     straordinario): il consulente sa sempre da dove vengono i numeri.

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const DOW = ['do', 'lu', 'ma', 'me', 'gi', 've', 'sa'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ore in decimali all'italiana, al centesimo: 450 → "7,5", 467 → "7,78". */
function ore(min) {
  if (!min) return '';
  return String(Math.round((min / 60) * 100) / 100).replace('.', ',');
}
const oreTot = (min) => (min > 0 ? ore(min) : '—');
const dataIt = (d) => d.split('-').reverse().join('/');

function meseLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MESI[m - 1].charAt(0).toUpperCase()}${MESI[m - 1].slice(1)} ${y}`;
}

// Causali: codice breve nel calendario, codice e descrizione nei movimenti
const CAUSALI = {
  ORD: 'Ore ordinarie',
  STR: 'Ore straordinarie',
  STF: 'Ore straordinarie in giorno festivo o di riposo',
  FER: 'Ferie',
  PER: 'Permesso',
  MAL: 'Malattia',
  INF: 'Infortunio',
  CIG: 'Maltempo (intemperie, pioggia o caldo)',
  ING: 'Assenza ingiustificata',
  SOS: 'Sospensione disciplinare',
  ALT: 'Altra assenza',
};
const CODICE_CELLA = { ferie: 'F', malattia: 'M', infortunio: 'I', permesso: 'P', maltempo: 'T', ingiustificata: 'AI', sospensione: 'S', altro: 'A', giustificare: '?', prima: '—', carta: 'C', festivo: 'FS' };
/** Testo della cella del calendario (PDF e foglio "Calendario" dell'Excel). */
function cellCode(c) {
  if (c.tipo === 'lavoro') {
    let s = ore(c.ore) || '0';
    if (c.straord) s += ` +${ore(c.straord)}`;
    if (c.maltempoMin) s += ' T';
    if (c.permessoMin) s += ' P';
    if (c.malattiaMin) s += ' M';
    if (c.infortunioMin) s += ' I';
    return s;
  }
  if (c.tipo === 'weekend') return c.straord ? `+${ore(c.straord)}` : '';
  return CODICE_CELLA[c.tipo] || '';
}

/**
 * F-476: la casella del PDF in due parti. Sopra il numero (tutti della stessa
 * grandezza), sotto, piccolo, lo straordinario e le sigle (T, P, M, I). Prima
 * tutto su una riga: «6,17 P» andava a capo e le righe avevano altezze diverse.
 */
function cellParts(c) {
  const code = cellCode(c);
  if (c.tipo === 'lavoro') {
    const [main, ...extra] = code.split(' ');
    return { main, sub: extra.join(' ') };
  }
  if (c.tipo === 'weekend') return { main: '', sub: code };
  return { main: code, sub: '' };
}

// F-479: sigle delle giornate intere nella riga «Ordinarie» dell'Excel (CONTA.SE le conta)
const SIGLA_XLSX = { ferie: 'F', malattia: 'M', infortunio: 'I', permesso: 'P', maltempo: 'T', ingiustificata: 'AI', sospensione: 'S', altro: 'A', giustificare: '?', carta: 'C' };

const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
/**
 * F-479: cosa è successo nei giorni non normali, in parole, per il consulente:
 * permessi (con l'ora), pioggia (con l'uscita e le ore), partito prima su
 * richiesta, pausa pranzo saltata. Una riga per lavoratore e giorno.
 */
function noteGiorni(data) {
  const out = [];
  const ass = new Map((data.assenze || []).map(a => [a.id, a]));
  for (const l of data.lavoratori) for (const c of l.cells) {
    const p = [];
    const a = c.assenzaId ? ass.get(c.assenzaId) : null;
    if (c.inizioAnticipato) p.push(`partito prima su richiesta: entrato alle ${c.primaEntrata}, ore contate dall'entrata`);
    if (c.pausaSaltata && (c.tipo === 'lavoro')) p.push('pausa pranzo saltata (lavorata)');
    if (c.tipo === 'lavoro' && c.permessoMin) p.push(`permesso ${a?.ora_dalle && a?.ora_alle ? `${hhmm(a.ora_dalle)}–${hhmm(a.ora_alle)}, ` : ''}${ore(c.permessoMin)} h`);
    if (c.tipo === 'permesso') p.push(`permesso tutto il giorno${a?.ora_dalle && a?.ora_alle ? ` ${hhmm(a.ora_dalle)}–${hhmm(a.ora_alle)}` : ''}, ${ore(c.permessoMin || data.regole.oreGiornoMin)} h`);
    if (c.tipo === 'lavoro' && c.maltempoMin) p.push(`${c.uscitoPer === 'caldo' ? 'caldo' : 'pioggia'}: ${c.ultimaUscita ? `uscito alle ${c.ultimaUscita}, ` : ''}${ore(c.maltempoMin)} h di ${c.uscitoPer === 'caldo' ? 'caldo' : 'pioggia'}`);
    if (c.tipo === 'maltempo') p.push(`pioggia tutto il giorno, ${ore(c.maltempoMin || data.regole.oreGiornoMin)} h`);
    if (c.tipo === 'lavoro' && (c.malattiaMin || c.infortunioMin)) p.push(`${c.malattiaMin ? 'malattia' : 'infortunio'}: uscito alle ${c.ultimaUscita}, ${ore(c.malattiaMin || c.infortunioMin)} h`);
    if (p.length) out.push({ cf: l.cf, nome: l.nome, data: c.date, testo: p.join(' · ') });
  }
  return out;
}

/**
 * F-479: le assenze per lavoratore, con i giorni consecutivi uniti (sabati,
 * domeniche e festivi in mezzo non spezzano): «01/10–26/10 malattia (18 giorni
 * lavorativi)» invece di 18 righe uguali. Permessi a ore e protocolli diversi
 * restano righe loro.
 */
function assenzeRaggruppate(data) {
  const lavorativo = new Set(data.days.filter(d => !d.weekend && !d.festivo).map(d => d.date));
  const nomeDi = new Map(data.lavoratori.map(l => [l.id, l.nome]));
  const giornoDopo = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  // il primo giorno lavorativo dopo d (dentro il mese), o il giorno dopo se si esce dal mese
  const prossimoLavorativo = (d) => { let x = giornoDopo(d); while (x <= data.to && !lavorativo.has(x)) x = giornoDopo(x); return x; };
  const contaGiorni = (a, b) => [...lavorativo].filter(x => x >= a && x <= b).length;
  const righe = (data.assenze || []).map(a => ({ nome: nomeDi.get(a.worker_id) || '', tipo: a.tipo, dal: a.date_from < data.from ? data.from : a.date_from, al: a.date_to > data.to ? data.to : a.date_to, dalle: hhmm(a.ora_dalle), alle: hhmm(a.ora_alle), protocollo: a.protocollo || '' }))
    .sort((x, y) => x.nome.localeCompare(y.nome, 'it') || x.dal.localeCompare(y.dal));
  const out = [];
  for (const r of righe) {
    const p = out[out.length - 1];
    if (p && p.nome === r.nome && p.tipo === r.tipo && !p.dalle && !r.dalle && p.protocollo === r.protocollo && r.dal <= prossimoLavorativo(p.al)) {
      if (r.al > p.al) p.al = r.al;
    } else out.push({ ...r });
  }
  for (const r of out) r.giorni = contaGiorni(r.dal, r.al);
  return out;
}

/** F-432: ore in più segnate dall'ufficio, una riga per voce (contate nello straordinario). */
function oreAggiunteRighe(data) {
  const out = [];
  for (const l of data.lavoratori) for (const c of l.cells) {
    if (!c.aggiunteMin) continue;
    for (const a of c.aggiunte || []) out.push({ cf: l.cf, nome: l.nome, data: c.date, min: a.minuti, note: a.note || '', cantiere: (a.siteId && data.cantieri?.[a.siteId]) || '' });
  }
  return out;
}

/** Righe di movimento (lavoratore, giorno, causale, ore) — la base dell'Excel. */
function movimenti(data) {
  const out = [];
  const contratto = data.regole.oreGiornoMin;
  for (const l of data.lavoratori) {
    for (const c of l.cells) {
      const push = (causale, min, cantiere = '') => { if (min > 0) out.push({ cf: l.cf, nome: l.nome, data: c.date, causale, min, cantiere }); };
      if (c.tipo === 'lavoro' || (c.tipo === 'weekend' && c.straord)) {
        const siti = Object.entries(c.perCantiere || {});
        // Ordinarie e straordinario per cantiere (la stessa ripartizione del conteggio)
        let ordRest = c.ore, strRest = c.straord;
        siti.forEach(([sid, min], i) => {
          const nome = data.cantieri?.[sid] || '';
          const ultima = i === siti.length - 1;
          const o = ultima ? ordRest : Math.min(ordRest, min);
          const s = ultima ? strRest : Math.max(0, Math.min(strRest, min - o));
          push('ORD', o, nome); push(c.festivo ? 'STF' : 'STR', s, nome);
          ordRest -= o; strRest -= s;
        });
        if (!siti.length) { push('ORD', c.ore); push(c.festivo ? 'STF' : 'STR', c.straord); }
        push('CIG', c.maltempoMin); push('PER', c.permessoMin); push('MAL', c.malattiaMin); push('INF', c.infortunioMin);
      } else if (c.tipo === 'permesso') push('PER', c.permessoMin || contratto);
      else if (c.tipo === 'maltempo') push('CIG', c.maltempoMin || contratto);
      else if (c.tipo === 'ferie') push('FER', contratto);
      else if (c.tipo === 'malattia') push('MAL', contratto);
      else if (c.tipo === 'infortunio') push('INF', contratto);
      else if (c.tipo === 'ingiustificata') push('ING', contratto);
      else if (c.tipo === 'sospensione') push('SOS', contratto);
      else if (c.tipo === 'altro') push('ALT', contratto);
    }
  }
  return out;
}

/** Ore per lavoratore e cantiere (Cassa Edile). */
function orePerCantiere(data) {
  const righe = [];
  for (const l of data.lavoratori) {
    const per = {};
    for (const m of movimenti({ ...data, lavoratori: [l] })) {
      if (m.causale !== 'ORD' && m.causale !== 'STR' && m.causale !== 'STF') continue;
      const k = m.cantiere || '—';
      per[k] = per[k] || { ord: 0, str: 0 };
      if (m.causale === 'ORD') per[k].ord += m.min; else per[k].str += m.min;
    }
    for (const [cantiere, v] of Object.entries(per).sort((a, b) => a[0].localeCompare(b[0], 'it'))) righe.push({ cf: l.cf, nome: l.nome, cantiere, ...v });
  }
  return righe;
}

/** Cose che il consulente deve sapere prima di fare le buste paga. */
function daVerificare(data) {
  const out = [];
  for (const l of data.lavoratori) {
    const r = [];
    const giorni = (f) => l.cells.filter(f).map(c => Number(c.date.slice(8)));
    const lista = (xs) => xs.join(', ');
    const rit = l.cells.filter(c => c.tipo === 'lavoro' && c.ritardo);
    if (rit.length) r.push(`ritardi: ${rit.map(c => `${Number(c.date.slice(8))} (${c.primaEntrata}, ${c.ritardo} min)`).join(', ')}`);
    const usc = l.cells.filter(c => c.tipo === 'lavoro' && c.uscitoPrima);
    if (usc.length) r.push(`uscite prima dell'orario senza motivo: ${usc.map(c => `${Number(c.date.slice(8))} (${c.ultimaUscita})`).join(', ')}`);
    const mezze = giorni(c => c.tipo === 'lavoro' && c.mezzaGiornata && !c.motivo);
    if (mezze.length) r.push(`entrato dopo la pausa: ${lista(mezze)}`);
    const giust = giorni(c => c.tipo === 'giustificare');
    if (giust.length) r.push(`giorni senza timbrature né assenza: ${lista(giust)}`);
    const inc = giorni(c => c.anomalia);
    if (inc.length) r.push(`timbratura incompleta (entrata o uscita mancante): ${lista(inc)}`);
    const carta = giorni(c => c.tipo === 'carta');
    if (carta.length) r.push(`ore su foglio cartaceo: ${lista(carta)}`);
    if (r.length) out.push({ nome: l.nome, righe: r });
  }
  return out;
}

function regoleTesto(data) {
  const g = data.regole;
  return `Orario ${g.inizio}–${g.fine}, pausa ${g.pausaDa}–${g.pausaA} non retribuita · ore contate dall'inizio dell'orario (gli ingressi anticipati non sono straordinario, salvo i giorni «partito prima su richiesta», contati dall'entrata e indicati nelle note) · tolleranza ${g.tolleranza} min · straordinario oltre le ${g.fine} da ${g.straordSoglia} min, a blocchi di ${g.straordBlocco} min`;
}

// F-433: Inter (fonts/ del repo) dentro il PDF, come dati: niente rete e stesso
// risultato in locale e su Railway, dove Helvetica non c'è. Plus Jakarta Sans da
// Google Fonts nel PDF perdeva la «i» del peso normale («Ora rio»).
let _fontCss = null;
function fontFaceInter() {
  if (_fontCss !== null) return _fontCss;
  try {
    const fs = require('fs'), path = require('path');
    const regular = fs.readFileSync(path.join(__dirname, '..', 'fonts', 'Inter-Regular.ttf')).toString('base64');
    const bold = fs.readFileSync(path.join(__dirname, '..', 'fonts', 'Inter-Bold.ttf')).toString('base64');
    _fontCss = `@font-face { font-family: "Inter PDF"; font-weight: 400; src: url(data:font/ttf;base64,${regular}) format("truetype"); }
  @font-face { font-family: "Inter PDF"; font-weight: 700; src: url(data:font/ttf;base64,${bold}) format("truetype"); }`;
  } catch { _fontCss = ''; }
  return _fontCss;
}

const nomeCantiere = (k) => (k === '—' ? 'senza cantiere' : k);

/** Cantieri di un lavoratore con le ore (ordinarie + straordinarie), dal più lavorato. */
function cantieriDi(data, l) {
  return orePerCantiere({ ...data, lavoratori: [l] })
    .map(c => ({ nome: nomeCantiere(c.cantiere), min: c.ord + c.str }))
    .filter(c => c.min > 0)
    .sort((a, b) => b.min - a.min || a.nome.localeCompare(b.nome, 'it'));
}

/**
 * F-433: opzioni del PDF del foglio (route e invio al commercialista usano le
 * stesse). Orizzontale, intestazione con l'impresa e il mese, piè di pagina del
 * foglio presenze — non quello del POS. I margini 26/24 mm del renderer sono
 * gli stessi di @page nel CSS del foglio: mai cambiarne uno senza l'altro.
 */
function foglioPdfOpts(data, companyName) {
  return {
    landscape: true,
    docTitle: `Presenze · ${meseLabel(data.month)}`,
    headerLeft: companyName || data.azienda?.nome || 'Palladia',
    footerLeft: 'Foglio presenze per le buste paga · Palladia',
    footerRight: `Creato il ${new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}`,
  };
}

/** F-435: correzioni dell'orario fatte dall'ufficio, una riga per giorno corretto. */
function correzioniRighe(data) {
  const out = [];
  for (const l of data.lavoratori) for (const c of l.cells) {
    if (!c.corretto || c.corretto.nonConta) continue;
    const k = c.corretto, p = k.prima || {};
    const parte = (lab, prima, dopo) => (!prima ? `${lab} ${dopo} (mancava)` : prima.slice(0, 5) !== dopo ? `${lab} ${prima.slice(0, 5)} → ${dopo}` : `${lab} ${dopo}`);
    out.push({ cf: l.cf, nome: l.nome, data: c.date, testo: `${parte('entrata', p.entrata, k.entrata)} · ${parte('uscita', p.uscita, k.uscita)}`, nota: k.nota || '', da: k.da || '', cantiere: (k.siteId && data.cantieri?.[k.siteId]) || '' });
  }
  return out;
}

/**
 * F-435: il foglio è UNA tabella, come quella di Palladia: lavoratore, i giorni,
 * ore, straordinario e i cantieri con le ore accanto. Sotto: legenda,
 * correzioni dell'ufficio, straordinario aggiunto, assenze e da verificare.
 * Con molti lavoratori la tabella continua sulle pagine dopo, intestazione ripetuta.
 */
function generateFoglioHtml(data, companyName) {
  const nome = companyName || data.azienda?.nome || '';
  const piva = data.azienda?.piva ? ` · P.IVA ${esc(data.azienda.piva)}` : '';
  const sum = (k) => data.lavoratori.reduce((s, l) => s + (l.tot[k] || 0), 0);
  const mese = meseLabel(data.month);
  const meseMin = mese.charAt(0).toLowerCase() + mese.slice(1);

  const dayHead = data.days.map(d => `<th class="d ${d.weekend || d.festivo ? 'we' : ''}">${d.day}<span>${DOW[d.dow]}</span></th>`).join('');
  const righe = data.lavoratori.map((l) => {
    const celle = l.cells.map((c, i) => {
      const d = data.days[i];
      let cls = (d.weekend || d.festivo) ? 'we' : '';
      if (['ferie', 'malattia', 'infortunio', 'permesso', 'maltempo', 'altro', 'sospensione'].includes(c.tipo)) cls += ' ass';
      // F-476: una giornata ancora aperta (oggi, senza tipo) non è un'anomalia da colorare
      if (c.tipo === 'giustificare' || c.tipo === 'ingiustificata' || (c.anomalia && c.tipo)) cls += ' gi';
      if (c.tipo === 'prima' || c.tipo === 'carta') cls += ' pr';
      if (c.corretto && c.tipo === 'lavoro' && !c.corretto.nonConta) cls += ' cor';
      const { main, sub } = cellParts(c);
      return `<td class="d ${cls.trim()}">${main ? `<b>${esc(main)}</b>` : ''}${sub ? `<i>${esc(sub)}</i>` : ''}</td>`;
    }).join('');
    return `<tr><td class="n">${esc(l.nome)}${l.cf ? `<small>${esc(l.cf)}</small>` : ''}</td>${celle}`
      + `<td class="s first">${oreTot(l.tot.ordinarieMin)}</td><td class="s">${oreTot(l.tot.straordMin)}</td></tr>`;
  }).join('');
  const tot = `<tr class="tot"><td class="n">Totale</td>${data.days.map(() => '<td class="d"></td>').join('')}<td class="s first">${oreTot(sum('ordinarieMin'))}</td><td class="s">${oreTot(sum('straordMin'))}</td></tr>`;
  // F-476: i cantieri in una tabella loro, sotto. Nella riga del mese toglievano
  // ai 31 giorni lo spazio per i numeri (5,3 mm a casella: «6,97 7,02» si toccavano).
  const perCantiere = data.lavoratori.map(l => ({ l, cant: cantieriDi(data, l) })).filter(x => x.cant.length);
  const tabCantieri = perCantiere.length ? `<table class="lista" data-sez="cantieri"><colgroup><col style="width:46mm"><col><col style="width:16mm"></colgroup>
    <thead><tr><th>Lavoratore</th><th>Cantiere</th><th class="r">Ore</th></tr></thead><tbody>${perCantiere.map(({ l, cant }) => cant.map((c, i) => `<tr class="${i === 0 ? 'primo' : ''}"><td class="b">${i === 0 ? esc(l.nome) : ''}</td><td>${esc(c.nome)}</td><td class="r">${ore(c.min)}</td></tr>`).join('')).join('')}</tbody></table>` : '';

  const corr = correzioniRighe(data);
  const aggiunte = oreAggiunteRighe(data);
  const verifica = daVerificare(data);
  const assenze = assenzeRaggruppate(data).map((a, i, arr) => {
    const nuovo = i === 0 || arr[i - 1].nome !== a.nome;
    const per = a.dal === a.al ? dataIt(a.dal) : `${dataIt(a.dal)}–${dataIt(a.al)}`;
    const oreAbs = a.dalle && a.alle ? ` ${a.dalle}–${a.alle}` : '';
    const tipo = { ferie: 'ferie', permesso: 'permesso', malattia: 'malattia', infortunio: 'infortunio', maltempo: 'pioggia', ingiustificata: 'assenza ingiustificata', sospensione: 'sospensione', altro: 'altra assenza' }[a.tipo] || a.tipo;
    const quanti = a.giorni > 1 ? ` (${a.giorni} giorni lavorativi)` : '';
    return `<tr class="${nuovo ? 'primo' : ''}"><td class="b${nuovo ? '' : ' rip'}">${esc(a.nome)}</td><td>${per}${oreAbs}</td><td>${tipo}${quanti}${a.protocollo ? ` · prot. ${esc(a.protocollo)}` : ''}</td></tr>`;
  }).join('');
  // F-479: il riepilogo del mese per lavoratore — tutto quello che serve per la busta paga
  const gg = (n) => (n ? String(n) : '—');
  const ripRighe = data.lavoratori.map((l) => {
    const t = l.tot;
    const altre = (t.ingiustificataGiorni || 0) + (t.sospensioneGiorni || 0) + (t.altroGiorni || 0);
    return `<tr class="primo"><td class="b">${esc(l.nome)}</td><td class="r">${gg(t.giorniLavorati)}</td><td class="r">${oreTot(t.ordinarieMin)}</td><td class="r">${oreTot(t.straordMin)}</td><td class="r">${oreTot(t.straordFestivoMin)}</td><td class="r">${oreTot(t.maltempoMin)}</td><td class="r">${oreTot(t.permessoMin)}</td><td class="r">${gg(t.ferieGiorni)}</td><td class="r">${gg(t.malattiaGiorni)}</td><td class="r">${gg(t.infortunioGiorni)}</td><td class="r">${gg(altre)}</td><td class="r">${gg(t.daGiustificare)}</td></tr>`;
  }).join('');
  const ripTot = (k) => oreTot(sum(k));
  const tabRiepilogo = `<table class="lista rip" data-sez="riepilogo"><colgroup><col style="width:46mm"><col span="11"></colgroup>
    <thead><tr><th>Lavoratore</th><th class="r">Giorni<br>lavorati</th><th class="r">Ore<br>ordinarie</th><th class="r">Ore<br>straordinarie</th><th class="r">di cui<br>festive</th><th class="r">Pioggia<br>(ore)</th><th class="r">Permessi<br>(ore)</th><th class="r">Ferie<br>(giorni)</th><th class="r">Malattia<br>(giorni)</th><th class="r">Infortunio<br>(giorni)</th><th class="r">Altre assenze<br>(giorni)</th><th class="r">Da giustificare<br>(giorni)</th></tr></thead>
    <tbody>${ripRighe}<tr class="tot"><td class="b">Totale</td><td class="r">${gg(sum('giorniLavorati'))}</td><td class="r">${ripTot('ordinarieMin')}</td><td class="r">${ripTot('straordMin')}</td><td class="r">${ripTot('straordFestivoMin')}</td><td class="r">${ripTot('maltempoMin')}</td><td class="r">${ripTot('permessoMin')}</td><td class="r">${gg(sum('ferieGiorni'))}</td><td class="r">${gg(sum('malattiaGiorni'))}</td><td class="r">${gg(sum('infortunioGiorni'))}</td><td class="r">${gg(sum('ingiustificataGiorni') + sum('sospensioneGiorni') + sum('altroGiorni'))}</td><td class="r">${gg(sum('daGiustificare'))}</td></tr></tbody></table>`;
  const note = noteGiorni(data);
  const tabNote = note.length ? `<table class="lista" data-sez="note-giorni"><colgroup><col style="width:46mm"><col style="width:18mm"><col></colgroup>
    <thead><tr><th>Lavoratore</th><th>Giorno</th><th>Cosa</th></tr></thead><tbody>${note.map((n, i) => `<tr class="${i === 0 || note[i - 1].nome !== n.nome ? 'primo' : ''}"><td class="b${i === 0 || note[i - 1].nome !== n.nome ? '' : ' rip'}">${esc(n.nome)}</td><td>${dataIt(n.data)}</td><td>${esc(n.testo.charAt(0).toUpperCase() + n.testo.slice(1))}</td></tr>`).join('')}</tbody></table>` : '';
  // F-479: le tabelle lunghe (note, assenze, da verificare) continuano sulla pagina dopo invece di lasciarne mezza vuota
  const blocco = (titolo, corpo, lunga = false) => `<div class="blk${lunga ? ' lunga' : ''}"><h2>${titolo}</h2>${corpo}</div>`;

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
  ${fontFaceInter()}
  @page { size: A4 landscape; margin: 26mm 0 24mm 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body { font-family: 'Inter PDF', Arial, Helvetica, sans-serif; color: #1A1714; font-size: 8pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { padding: 0 16mm; }
  table { border-collapse: collapse; width: 100%; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .muted { color: #A39B90; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16pt; padding-bottom: 5pt; }
  h1 { font-size: 16pt; margin: 0; letter-spacing: -0.3pt; line-height: 1.1; }
  .az { font-size: 9pt; color: #4D4740; text-align: right; line-height: 1.4; }
  .rules { font-size: 6.6pt; color: #6E675E; margin: 0 0 6pt; line-height: 1.35; }
  .mese { table-layout: fixed; font-variant-numeric: tabular-nums; border-top: 1.4pt solid #1A1714; }
  .mese col.n { width: 36mm; } .mese col.s { width: 13.5mm; }
  .mese th, .mese td { border-bottom: 0.4pt solid #E2DCD2; text-align: center; padding: 0; height: 8.4mm; vertical-align: middle; }
  .mese th { font-weight: 700; color: #6E675E; font-size: 6.6pt; height: 8mm; line-height: 1.1; }
  .mese th span { display: block; font-weight: 400; font-size: 5.6pt; }
  .mese td.n { text-align: left; padding: 0 4pt; font-weight: 700; font-size: 7.6pt; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mese td.n small { display: block; font-size: 5.6pt; font-weight: 400; color: #6E675E; letter-spacing: .2pt; line-height: 1.1; }
  .mese td.d { line-height: 1; white-space: nowrap; }
  .mese td.d b { display: block; font-weight: inherit; font-size: 6.6pt; letter-spacing: -0.1pt; }
  .mese td.d i { display: block; font-style: normal; font-size: 5.2pt; line-height: 1.15; margin-top: 1pt; color: #22384F; font-weight: 700; }
  .mese .we { background: #F3F1EC; color: #9A9184; }
  .mese td.ass { color: #1F5FA8; font-weight: 700; }
  .mese td.gi { background: #FBE3E0; color: #9A2219; font-weight: 700; }
  .mese td.pr { color: #B3ADA3; }
  .mese td.cor b { color: #1F5FA8; font-weight: 700; text-decoration: underline; }
  .mese th.s, .mese td.s { text-align: right; padding: 0 5pt 0 6pt; font-weight: 700; font-size: 7.4pt; }
  .mese .first { border-left: 1pt solid #1A1714; }
  .mese tr.tot td { font-weight: 700; border-top: 1.4pt solid #1A1714; border-bottom: 0; }
  .lista { table-layout: fixed; font-variant-numeric: tabular-nums; }
  .lista th { text-align: left; font-size: 6.6pt; color: #6E675E; font-weight: 700; padding: 0 0 2pt; border-bottom: 0.8pt solid #1A1714; }
  .lista td { font-size: 7pt; line-height: 1.35; padding: 1.6pt 6pt 1.6pt 0; vertical-align: top; }
  .lista tr.primo td { border-top: 0.4pt solid #E2DCD2; }
  .lista tbody tr.primo:first-child td { border-top: 0; }
  .lista td.b { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lista td.b.rip { color: #B3ADA3; font-weight: 400; }
  .lista .r { text-align: right; padding-right: 0; font-weight: 700; }
  .lista.rip th { vertical-align: bottom; line-height: 1.15; }
  .lista.rip td.r, .lista.rip th.r { padding-right: 3pt; }
  .lista tr.tot td { font-weight: 700; border-top: 0.8pt solid #1A1714; }
  .key { display: flex; flex-wrap: wrap; gap: 2pt 8pt; font-size: 6.4pt; color: #4D4740; margin: 6pt 0 12pt; }
  .key span { white-space: nowrap; display: inline-flex; align-items: center; gap: 2pt; }
  .key b { color: #1A1714; }
  .key i.sw { display: inline-block; width: 7pt; height: 7pt; background: #F3F1EC; border: 0.4pt solid #D8D2C8; }
  .duo { display: grid; grid-template-columns: 1fr 1fr; gap: 0 22pt; align-items: start; }
  .blk { break-inside: avoid; page-break-inside: avoid; margin-bottom: 12pt; }
  .blk.lunga { break-inside: auto; page-break-inside: auto; }
  .blk h2 { break-after: avoid; page-break-after: avoid; }
  h2 { font-size: 8.6pt; margin: 0 0 4pt; }
  ul { margin: 0; padding: 0; list-style: none; } li { font-size: 7pt; line-height: 1.4; }
  .firma { display: flex; gap: 30pt; margin-top: 14pt; break-inside: avoid; }
  .firma div { width: 70mm; border-top: 0.6pt solid #8C857B; padding-top: 3pt; font-size: 6.8pt; color: #6E675E; }
  .note { font-size: 6.4pt; color: #6E675E; line-height: 1.45; margin-top: 8pt; }
  </style></head><body><div class="doc">
  <div class="top">
    <h1>Ore di ${esc(meseMin)}</h1>
    <div class="az"><b>${esc(nome)}</b>${piva}<br>${data.lavoratori.length} lavoratori · ${data.giorniLavorativi} giorni lavorativi</div>
  </div>
  <p class="rules">${esc(regoleTesto(data))}. Ore in centesimi (7,5 = 7 ore e 30).</p>
  <table class="mese">
    <colgroup><col class="n">${data.days.map(() => '<col class="d">').join('')}<col class="s"><col class="s"></colgroup>
    <thead><tr><th style="text-align:left;padding-left:4pt">Lavoratore</th>${dayHead}<th class="s first">Ore</th><th class="s">Straord.</th></tr></thead>
    <tbody>${righe}${tot}</tbody>
  </table>
  <div class="key"><span><b>8</b> ore lavorate</span><span><b>+1</b> straordinario</span><span><b>F</b> ferie</span><span><b>P</b> permesso</span><span><b>M</b> malattia</span><span><b>I</b> infortunio</span><span><b>T</b> pioggia</span><span><b>AI</b> ingiustificata</span><span><b>S</b> sospensione</span><span><b>FS</b> festività</span><span><b>C</b> foglio di carta</span><span><b>?</b> da giustificare</span><span><b style="color:#1F5FA8;text-decoration:underline">8</b> corretto dall'ufficio</span><span><i class="sw"></i>sabato, domenica e festivi</span></div>
  ${blocco('Riepilogo del mese', tabRiepilogo)}
  ${tabNote ? blocco('Note sui giorni: permessi, pioggia, partenze anticipate, pause saltate', tabNote, true) : ''}
  <div class="duo">
    <div>${tabCantieri ? blocco('Ore per cantiere', tabCantieri) : ''}</div>
    <div>
      ${corr.length ? blocco("Correzioni dell'ufficio", `<ul>${corr.map(k => `<li><b>${esc(k.nome)}</b> · ${dataIt(k.data)} · ${esc(k.testo)}${k.nota ? ` · «${esc(k.nota)}»` : ''}</li>`).join('')}</ul>`) : ''}
      ${aggiunte.length ? blocco("Straordinario aggiunto dall'ufficio", `<ul>${aggiunte.map(a => `<li><b>${esc(a.nome)}</b> · ${dataIt(a.data)} · ${oreTot(a.min)} h${a.note ? ` · ${esc(a.note)}` : ''}</li>`).join('')}</ul>`) : ''}
      ${assenze ? blocco('Assenze', `<table class="lista" data-sez="assenze"><colgroup><col style="width:46mm"><col style="width:44mm"><col></colgroup><thead><tr><th>Lavoratore</th><th>Quando</th><th>Cosa</th></tr></thead><tbody>${assenze}</tbody></table>`, true) : ''}
    </div>
  </div>
  ${blocco('Da verificare', verifica.length
    ? `<table class="lista" data-sez="verifica"><colgroup><col style="width:46mm"><col></colgroup><tbody>${verifica.map(v => v.righe.map((r, i) => `<tr class="${i === 0 ? 'primo' : ''}"><td class="b">${i === 0 ? esc(v.nome) : ''}</td><td>${esc(r.charAt(0).toUpperCase() + r.slice(1))}</td></tr>`).join('')).join('')}</tbody></table>`
    : '<ul data-sez="verifica"><li>Niente da verificare.</li></ul>', true)}
  <div class="firma"><div>Firma del datore di lavoro</div><div>Data</div></div>
  <p class="note">Ore ricavate dalle timbrature registrate in Palladia; le timbrature originali sono conservate senza modifiche, le correzioni dell'ufficio sono elencate qui sopra. Nel file Excel lo stesso mese con una riga per lavoratore, giorno e causale (foglio “Movimenti”).</p>
  </div></body></html>`;
}

async function generateFoglioXlsx(data, companyName) {
  const ExcelJS = require('exceljs');
  const nome = companyName || data.azienda?.nome || '';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true }; // F-479: le formule si ricalcolano all'apertura
  const h = (min) => Math.round((min / 60) * 100) / 100;
  const headStyle = (row) => { row.font = { bold: true }; row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE9' } }; c.border = { bottom: { style: 'thin', color: { argb: 'FF1A1714' } } }; c.alignment = { vertical: 'middle', wrapText: true }; }); };
  const FMT_ORE = '0.00;-0.00;"—"', FMT_NUM = '0;-0;"—"';
  const lettera = (n) => { let x = ''; while (n > 0) { const m = (n - 1) % 26; x = String.fromCharCode(65 + m) + x; n = Math.floor((n - 1) / 26); } return x; };
  const titolo = (ws, t) => { ws.addRow([t]).font = { bold: true, size: 13 }; ws.addRow([`${nome}${data.azienda?.piva ? ` — P.IVA ${data.azienda.piva}` : ''}`]); ws.addRow([regoleTesto(data)]).font = { italic: true, size: 9, color: { argb: 'FF6E675E' } }; ws.addRow([]); };

  // 0. F-479: «Ore del mese» con NUMERI e formule. Per ogni lavoratore una riga
  // per voce (Ordinarie, Straordinario, Pioggia, Permesso, e Malattia/infortunio
  // se nel mese ce n'è): cambi un numero e totali e Riepilogo si rifanno da soli.
  // Le assenze di giornata intera sono la sigla nella riga Ordinarie (F, M…):
  // SUM le salta, il Riepilogo le conta con CONTA.SE.
  const s0 = wb.addWorksheet('Ore del mese', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
  titolo(s0, `Ore di ${meseLabel(data.month).toLowerCase()}`);
  const nG = data.days.length;
  const C0 = 3; // prima colonna dei giorni
  const colTot = C0 + nG;
  const Ld = lettera(C0), Lu = lettera(C0 + nG - 1), Lt = lettera(colTot);
  const conMalattiaOre = data.lavoratori.some(l => l.cells.some(c => c.tipo === 'lavoro' && (c.malattiaMin || c.infortunioMin)));
  // F-479: valori esatti (minuti/60) con formato a due decimali: i totali coincidono col PDF al centesimo
  const hx = (min) => min / 60;
  const giornoIntero = hx(data.regole.oreGiornoMin);
  const VOCI = [
    { k: 'ord', label: 'Ordinarie', val: (c) => (c.tipo === 'lavoro' ? (hx(c.ore) || null) : (SIGLA_XLSX[c.tipo] || null)) },
    { k: 'str', label: 'Straordinario', val: (c) => (c.straord ? hx(c.straord) : null) },
    { k: 'pio', label: 'Pioggia', val: (c) => (c.maltempoMin ? hx(c.maltempoMin) : c.tipo === 'maltempo' ? giornoIntero : null) },
    { k: 'per', label: 'Permesso', val: (c) => (c.permessoMin ? hx(c.permessoMin) : c.tipo === 'permesso' ? giornoIntero : null) },
    ...(conMalattiaOre ? [{ k: 'mal', label: 'Malattia/infortunio (ore)', val: (c) => (c.tipo === 'lavoro' && (c.malattiaMin || c.infortunioMin) ? hx(c.malattiaMin + c.infortunioMin) : null) }] : []),
  ];
  const h0 = s0.addRow(['Lavoratore', 'Voce', ...data.days.map(d => `${d.day}\n${DOW[d.dow]}`), 'Totale']);
  h0.height = 30;
  h0.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22384F' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  const righeDi = new Map(); // id lavoratore → { ord: riga, str: riga, … }
  const totaleDi = new Map(); // `${id}:${voce}` → somma (risultato già calcolato della formula)
  data.lavoratori.forEach((l, li) => {
    const rr = {};
    VOCI.forEach((v, vi) => {
      const vals = l.cells.map(v.val);
      const r = s0.addRow([vi === 0 ? l.nome : '', v.label, ...vals]);
      rr[v.k] = r.number;
      const somma = vals.reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);
      totaleDi.set(`${l.id}:${v.k}`, somma);
      r.getCell(colTot).value = { formula: `SUM(${Ld}${r.number}:${Lu}${r.number})`, result: somma };
      r.getCell(colTot).font = { bold: true };
      r.getCell(1).font = { bold: true };
      r.getCell(2).font = { size: 9, color: { argb: 'FF6E675E' } };
      const banda = li % 2 ? 'FFFAF8F4' : null;
      l.cells.forEach((c, i) => {
        const d = data.days[i];
        const cell = r.getCell(C0 + i);
        cell.alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
        cell.numFmt = '0.00';
        const gi = vi === 0 && (c.tipo === 'giustificare' || c.tipo === 'ingiustificata' || (c.anomalia && c.tipo));
        const fill = gi ? 'FFFBE3E0' : (d.weekend || d.festivo) ? 'FFF3F1EC' : banda;
        if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        if (gi) cell.font = { bold: true, color: { argb: 'FF9A2219' } };
        else if (vi === 0 && c.corretto && c.tipo === 'lavoro' && !c.corretto.nonConta) cell.font = { bold: true, underline: true, color: { argb: 'FF1F5FA8' } };
        else if (vi === 0 && typeof cell.value === 'string') cell.font = { bold: true, color: { argb: 'FF1F5FA8' } };
        else if (vi > 0) cell.font = { color: { argb: 'FF22384F' } };
      });
      if (banda) [1, 2, colTot].forEach(n => { r.getCell(n).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: banda } }; });
      // linea tra un lavoratore e l'altro
      if (vi === 0) for (let n = 1; n <= colTot; n++) r.getCell(n).border = { top: { style: 'thin', color: { argb: 'FFB9B2A7' } } };
    });
    righeDi.set(l.id, rr);
  });
  // Totali di ogni voce su tutti i lavoratori
  s0.addRow([]);
  VOCI.forEach((v, vi) => {
    const refs = data.lavoratori.map(l => `${Lt}${righeDi.get(l.id)[v.k]}`);
    const result = data.lavoratori.reduce((s, l) => s + totaleDi.get(`${l.id}:${v.k}`), 0);
    const r = s0.addRow([vi === 0 ? 'Totale' : '', v.label]);
    r.getCell(colTot).value = refs.length ? { formula: `SUMIF($B$6:$B$${r.number - 2},"${v.label}",${Lt}$6:${Lt}$${r.number - 2})`, result } : 0;
    r.font = { bold: true };
    if (vi === 0) for (let n = 1; n <= colTot; n++) r.getCell(n).border = { top: { style: 'medium', color: { argb: 'FF1A1714' } } };
  });
  s0.getColumn(1).width = 24; s0.getColumn(2).width = 14;
  for (let i = C0; i < colTot; i++) s0.getColumn(i).width = 6;
  s0.getColumn(colTot).width = 9;
  for (let n = 6; n <= s0.rowCount; n++) { const c = s0.getRow(n).getCell(colTot); if (c.value != null && c.value !== '') c.numFmt = FMT_ORE; }
  s0.addRow([]);
  s0.addRow(['Ore in centesimi (7,5 = 7 ore e 30). Riga Ordinarie: F ferie · M malattia · I infortunio · P permesso tutto il giorno · T pioggia tutto il giorno · AI ingiustificata · S sospensione · A altra assenza · ? da giustificare · C foglio di carta. Blu sottolineato = corretto dall\'ufficio. Cambiando un numero, totali e Riepilogo si aggiornano da soli.']).font = { size: 9, color: { argb: 'FF4D4740' } };
  s0.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '5:5', margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  s0.headerFooter = { oddFooter: `&L${nome.replace(/&/g, '&&')} — Ore di ${meseLabel(data.month)}&RPagina &P di &N` };

  // 1. Riepilogo — F-479: le colonne che vengono dal foglio «Ore del mese» sono formule
  const s1 = wb.addWorksheet('Riepilogo', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
  titolo(s1, `Presenze per le buste paga — ${meseLabel(data.month)}`);
  const OM = "'Ore del mese'!";
  const rng = (r) => `${OM}$${Ld}$${r}:$${Lu}$${r}`;
  const conta = (l, sig) => l.cells.filter(c => SIGLA_XLSX[c.tipo] === sig).length;
  const tot = (l, k) => totaleDi.get(`${l.id}:${k}`) || 0;
  const COLS = [
    ['Lavoratore', (l) => l.nome],
    ['Codice fiscale', (l) => l.cf],
    ['Giorni lavorati', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},">0")+COUNTIFS(${rng(r.ord)},"",${rng(r.str)},">0")`, result: l.tot.giorniLavorati })],
    ['Ore ordinarie', (l, r) => ({ formula: `${OM}${Lt}${r.ord}`, result: tot(l, 'ord') })],
    ['Ore straord.', (l, r) => ({ formula: `${OM}${Lt}${r.str}`, result: tot(l, 'str') })],
    ['di cui festive', (l) => h(l.tot.straordFestivoMin)],
    ['Pioggia (ore)', (l, r) => ({ formula: `${OM}${Lt}${r.pio}`, result: tot(l, 'pio') })],
    ['Permessi (ore)', (l, r) => ({ formula: `${OM}${Lt}${r.per}`, result: tot(l, 'per') })],
    ['Ferie (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"F")`, result: conta(l, 'F') })],
    ['Malattia (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"M")`, result: conta(l, 'M') })],
    ['Mal. o infort. (ore)', (l, r) => (r.mal ? { formula: `${OM}${Lt}${r.mal}`, result: tot(l, 'mal') } : 0)],
    ['Infortunio (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"I")`, result: conta(l, 'I') })],
    ['Ingiustif. (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"AI")`, result: conta(l, 'AI') })],
    ['Sospensioni (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"S")`, result: conta(l, 'S') })],
    ['Altre assenze (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"A")`, result: conta(l, 'A') })],
    // F-480: in CONTA.SE «?» è un jolly (qualsiasi lettera): «~?» è il punto di domanda vero
    ['Da giustificare (gg)', (l, r) => ({ formula: `COUNTIF(${rng(r.ord)},"~?")`, result: conta(l, '?') })],
    ['Ritardi (n)', (l) => l.tot.ritardi],
    ['Ritardi (min)', (l) => l.tot.ritardoMin],
    ['Uscite prima (n)', (l) => l.tot.uscitePrima],
    ['Cantieri', (l) => cantieriDi(data, l).map(c => `${c.nome} · ${String(h(c.min)).replace('.', ',')} h`).join('\n')],
  ];
  const CANT = COLS.length;
  const hr = s1.addRow(COLS.map(c => c[0]));
  hr.height = 46;
  hr.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22384F' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  const primaRiga = s1.rowCount + 1;
  data.lavoratori.forEach((l, i) => {
    const rr = righeDi.get(l.id);
    const r = s1.addRow(COLS.map(([, f]) => f(l, rr)));
    r.alignment = { vertical: 'top' };
    r.getCell(1).font = { bold: true };
    r.getCell(CANT).alignment = { vertical: 'top', wrapText: true, indent: 1 };
    r.height = Math.max(18, 15 * Math.max(1, String(r.getCell(CANT).value || '').split('\n').length));
    if (i % 2) r.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF8F4' } }; });
  });
  const ultimaRiga = s1.rowCount;
  const valoreDi = (v) => (typeof v === 'number' ? v : (v && typeof v.result === 'number' ? v.result : 0));
  const tr = s1.addRow(COLS.map((c, i) => {
    if (i === 0) return 'Totale';
    if (i === 1 || i + 1 === CANT) return '';
    const L = lettera(i + 1);
    let result = 0;
    for (let k = primaRiga; k <= ultimaRiga; k++) result += valoreDi(s1.getRow(k).getCell(i + 1).value);
    return { formula: `SUM(${L}${primaRiga}:${L}${ultimaRiga})`, result };
  }));
  tr.font = { bold: true };
  tr.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE9' } }; c.border = { top: { style: 'medium', color: { argb: 'FF1A1714' } } }; });
  const COL_ORE = new Set(['Ore ordinarie', 'Ore straord.', 'di cui festive', 'Pioggia (ore)', 'Permessi (ore)', 'Mal. o infort. (ore)']);
  // F-480: lo zero si stampa «—», non «0,00» (prima il foglio era un muro di zeri)
  s1.columns.forEach((c, i) => { c.width = i === 0 ? 26 : i === 1 ? 19 : i + 1 === CANT ? 38 : 12; if (i >= 2 && i + 1 !== CANT) c.numFmt = COL_ORE.has(COLS[i]?.[0]) ? FMT_ORE : FMT_NUM; });
  s1.addRow([]);
  s1.addRow(['Giorni, ore, pioggia, permessi e giorni di assenza sono formule sul foglio «Ore del mese»: se cambi un numero lì, qui si aggiornano da soli. Ritardi e uscite sono come li ha contati Palladia.']).font = { size: 9, color: { argb: 'FF4D4740' } };
  s1.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${primaRiga - 1}:${primaRiga - 1}`, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  s1.headerFooter = { oddFooter: `&L${nome.replace(/&/g, '&&')} — Presenze ${meseLabel(data.month)}&RPagina &P di &N` };

  // 2. F-479: note sui giorni (permessi, pioggia, partito prima, pausa saltata)
  const ng = noteGiorni(data);
  if (ng.length) {
    const s2 = wb.addWorksheet('Note sui giorni');
    headStyle(s2.addRow(['Codice fiscale', 'Lavoratore', 'Giorno', 'Cosa']));
    for (const n of ng) { const [y, mo, d] = n.data.split('-').map(Number); s2.addRow([n.cf, n.nome, new Date(Date.UTC(y, mo - 1, d)), n.testo]); }
    s2.getColumn(3).numFmt = 'dd/mm/yyyy';
    [19, 26, 12, 80].forEach((w, i) => { s2.getColumn(i + 1).width = w; });
  }

  // 3. Movimenti — una riga per lavoratore, giorno e causale
  const s3 = wb.addWorksheet('Movimenti', { views: [{ state: 'frozen', ySplit: 1 }] });
  headStyle(s3.addRow(['Codice fiscale', 'Lavoratore', 'Data', 'Codice causale', 'Causale', 'Ore', 'Cantiere']));
  for (const m of movimenti(data)) {
    const [y, mo, d] = m.data.split('-').map(Number);
    s3.addRow([m.cf, m.nome, new Date(Date.UTC(y, mo - 1, d)), m.causale, CAUSALI[m.causale], h(m.min), m.cantiere]);
  }
  s3.getColumn(3).numFmt = 'dd/mm/yyyy';
  s3.getColumn(6).numFmt = 'General';
  [19, 26, 12, 10, 44, 8, 30].forEach((w, i) => { s3.getColumn(i + 1).width = w; });
  s3.autoFilter = { from: 'A1', to: 'G1' };

  // 4. Ore per cantiere (Cassa Edile)
  const s4 = wb.addWorksheet('Ore per cantiere');
  titolo(s4, `Ore per cantiere — ${meseLabel(data.month)}`);
  headStyle(s4.addRow(['Codice fiscale', 'Lavoratore', 'Cantiere', 'Ore ordinarie', 'Ore straordinarie']));
  for (const c of orePerCantiere(data)) s4.addRow([c.cf, c.nome, c.cantiere, h(c.ord), h(c.str)]);
  [19, 26, 34, 14, 16].forEach((w, i) => { s4.getColumn(i + 1).width = w; });

  // 5. Assenze
  const s5 = wb.addWorksheet('Assenze');
  headStyle(s5.addRow(['Codice fiscale', 'Lavoratore', 'Causale', 'Dal', 'Al', 'Dalle', 'Alle', 'Protocollo certificato', 'Note']));
  for (const a of data.assenze) {
    const l = data.lavoratori.find(x => x.id === a.worker_id);
    s5.addRow([l?.cf || '', l?.nome || '', a.tipo, a.date_from, a.date_to, a.ora_dalle?.slice(0, 5) || '', a.ora_alle?.slice(0, 5) || '', a.protocollo || '', a.note || '']);
  }
  s5.columns.forEach((c, i) => { c.width = i === 1 ? 26 : i === 8 ? 40 : 16; });

  // 5b. F-432: straordinario aggiunto dall'ufficio
  const agg = oreAggiunteRighe(data);
  if (agg.length) {
    const s5b = wb.addWorksheet('Straordinario aggiunto');
    headStyle(s5b.addRow(['Codice fiscale', 'Lavoratore', 'Giorno', 'Ore', 'Motivo', 'Cantiere']));
    for (const a of agg) s5b.addRow([a.cf, a.nome, a.data, h(a.min), a.note, a.cantiere]);
    [19, 26, 12, 8, 40, 30].forEach((w, i) => { s5b.getColumn(i + 1).width = w; });
  }

  // 5c. F-435: correzioni dell'orario fatte dall'ufficio
  const cor = correzioniRighe(data);
  if (cor.length) {
    const s5c = wb.addWorksheet('Correzioni');
    headStyle(s5c.addRow(['Codice fiscale', 'Lavoratore', 'Giorno', 'Correzione', 'Perché', 'Cantiere', 'Fatta da']));
    for (const c of cor) s5c.addRow([c.cf, c.nome, c.data, c.testo, c.nota, c.cantiere, c.da]);
    [19, 26, 12, 44, 36, 26, 28].forEach((w, i) => { s5c.getColumn(i + 1).width = w; });
  }

  // 6. Da verificare + legenda causali
  const s6 = wb.addWorksheet('Da verificare');
  headStyle(s6.addRow(['Lavoratore', 'Da verificare']));
  for (const v of daVerificare(data)) for (const r of v.righe) s6.addRow([v.nome, r]);
  s6.addRow([]);
  headStyle(s6.addRow(['Codice causale', 'Causale']));
  for (const [k, v] of Object.entries(CAUSALI)) s6.addRow([k, v]);
  s6.getColumn(1).width = 26; s6.getColumn(2).width = 110;

  return wb.xlsx.writeBuffer();
}

module.exports = { noteGiorni, generateFoglioHtml, generateFoglioXlsx, foglioPdfOpts, cantieriDi, cellCode, meseLabel, movimenti, orePerCantiere, daVerificare, oreAggiunteRighe, correzioniRighe, CAUSALI };
