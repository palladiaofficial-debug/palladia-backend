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
const LEGENDA = [
  ['8', 'ore ordinarie lavorate (in centesimi: 7,5 = 7 ore e 30)'],
  ['+1', 'ore straordinarie del giorno'],
  ['F', 'ferie'], ['P', 'permesso'], ['M', 'malattia'], ['I', 'infortunio'], ['T', 'maltempo (pioggia o caldo)'],
  ['AI', 'assenza ingiustificata'], ['S', 'sospensione disciplinare'], ['A', 'altra assenza'], ['FS', 'festività'],
  ['?', 'giorno senza timbrature né assenza: da giustificare'],
  ['C', 'ore registrate su foglio cartaceo, fuori da Palladia'],
  ['—', 'non ancora in forza'],
];

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
  return `Orario ${g.inizio}–${g.fine}, pausa ${g.pausaDa}–${g.pausaA} non retribuita · ore contate dall'inizio dell'orario (gli ingressi anticipati non sono straordinario) · tolleranza ${g.tolleranza} min · straordinario oltre le ${g.fine} da ${g.straordSoglia} min, a blocchi di ${g.straordBlocco} min`;
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

/** Ore con l'unità, per il riepilogo: 8280 → "138 h", 450 → "7,5 h". */
const oreH = (min) => (min > 0 ? `${ore(min)} h` : '—');
const nomeCantiere = (k) => (k === '—' ? 'senza cantiere' : k);

/** Cantieri di un lavoratore con le ore (ordinarie + straordinarie), dal più lavorato. */
function cantieriDi(data, l) {
  return orePerCantiere({ ...data, lavoratori: [l] })
    .map(c => ({ nome: nomeCantiere(c.cantiere), min: c.ord + c.str }))
    .filter(c => c.min > 0)
    .sort((a, b) => b.min - a.min || a.nome.localeCompare(b.nome, 'it'));
}

/** Assenze del mese di un lavoratore: ["Ferie 2 gg", "Permesso 4 h"]. */
function assenzeTesto(t) {
  const p = [];
  if (t.ferieGiorni) p.push(`Ferie ${t.ferieGiorni} gg`);
  if (t.permessoMin) p.push(`Permesso ${oreH(t.permessoMin)}`);
  if (t.malattiaGiorni) p.push(`Malattia ${t.malattiaGiorni} gg`);
  else if (t.malattiaMin) p.push(`Malattia ${oreH(t.malattiaMin)}`);
  if (t.infortunioGiorni) p.push(`Infortunio ${t.infortunioGiorni} gg`);
  if (t.maltempoMin) p.push(`Maltempo ${oreH(t.maltempoMin)}`);
  if (t.ingiustificataGiorni) p.push(`Ingiustificata ${t.ingiustificataGiorni} gg`);
  if (t.sospensioneGiorni) p.push(`Sospensione ${t.sospensioneGiorni} gg`);
  if (t.altroGiorni) p.push(`Altra assenza ${t.altroGiorni} gg`);
  return p;
}

/** Cosa guardare prima delle buste, in breve (il dettaglio è nella sezione «Da verificare»). */
function verificaBreve(t) {
  const p = [];
  if (t.daGiustificare) p.push(`${t.daGiustificare} ${t.daGiustificare === 1 ? 'giorno' : 'giorni'} da giustificare`);
  if (t.anomalie) p.push(`${t.anomalie} ${t.anomalie === 1 ? 'timbratura incompleta' : 'timbrature incomplete'}`);
  return p;
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

function generateFoglioHtml(data, companyName) {
  const nome = companyName || data.azienda?.nome || '';
  const piva = data.azienda?.piva ? ` · P.IVA ${esc(data.azienda.piva)}` : '';
  const sum = (k) => data.lavoratori.reduce((s, l) => s + (l.tot[k] || 0), 0);
  const mese = meseLabel(data.month);
  const meseMin = mese.charAt(0).toLowerCase() + mese.slice(1);

  // ── Pagina 1: riepilogo, una riga per lavoratore, i cantieri a destra ──
  const riepRows = data.lavoratori.map((l) => {
    const t = l.tot;
    const ass = assenzeTesto(t);
    const ver = verificaBreve(t);
    const cant = cantieriDi(data, l);
    return '<tr>'
      + `<td class="lav"><b>${esc(l.nome)}</b><span>${esc(l.cf)}${l.orario ? ` · orario ${esc(l.orario)}` : ''}</span></td>`
      + `<td class="num">${t.giorniLavorati || '—'}</td>`
      + `<td class="num strong">${oreTot(t.ordinarieMin)}</td>`
      + `<td class="num">${oreTot(t.straordMin)}${t.straordFestivoMin ? `<small>di cui festive ${ore(t.straordFestivoMin)}</small>` : ''}</td>`
      + `<td class="txt">${ass.length ? ass.map(esc).join('<br>') : '<span class="muted">—</span>'}</td>`
      + `<td class="txt">${ver.length ? `<span class="warn">${ver.map(esc).join('<br>')}</span>` : '<span class="muted">—</span>'}</td>`
      + `<td class="cant">${cant.length ? cant.map(c => `<div class="c"><span>${esc(c.nome)}</span><b>${oreH(c.min)}</b></div>`).join('') : '<span class="muted">—</span>'}</td>`
      + '</tr>';
  }).join('');
  const riepTot = `<tr class="tot"><td class="lav"><b>Totale</b></td><td class="num">${sum('giorniLavorati')}</td>`
    + `<td class="num strong">${oreTot(sum('ordinarieMin'))}</td><td class="num">${oreTot(sum('straordMin'))}</td><td></td><td></td><td></td></tr>`;

  // ── Calendario giorno per giorno ──
  const dayHead = data.days.map(d => `<th class="d ${d.weekend || d.festivo ? 'we' : ''}">${d.day}<br><span>${DOW[d.dow]}</span></th>`).join('');
  const calRows = data.lavoratori.map((l) => {
    const celle = l.cells.map((c, i) => {
      const d = data.days[i];
      let cls = (d.weekend || d.festivo) ? 'we' : '';
      if (c.tipo === 'lavoro' && c.ritardo) cls += ' rit';
      if (c.tipo === 'lavoro' && (c.uscitoPrima || (c.mezzaGiornata && !c.motivo))) cls += ' usc';
      if (['ferie', 'malattia', 'infortunio', 'permesso', 'maltempo', 'altro'].includes(c.tipo) || c.maltempoMin || c.permessoMin || c.malattiaMin || c.infortunioMin) cls += ' ass';
      if (c.tipo === 'giustificare' || c.tipo === 'ingiustificata' || c.anomalia) cls += ' gi';
      if (c.tipo === 'prima' || c.tipo === 'carta') cls += ' pr';
      // Straordinario su una seconda riga piccola: "6,97 +1" non sta in una casella
      const txt = esc(cellCode(c)).replace(/ ?\+([\d,]+)/, '<sup>+$1</sup>');
      return `<td class="d ${cls.trim()}">${txt}</td>`;
    }).join('');
    return `<tr><td class="n">${esc(l.nome)}</td>${celle}<td class="s first">${oreTot(l.tot.ordinarieMin)}</td><td class="s">${oreTot(l.tot.straordMin)}</td></tr>`;
  }).join('');
  const calTot = `<tr class="tot"><td class="n">Totale</td>${data.days.map(() => '<td class="d"></td>').join('')}<td class="s first">${oreTot(sum('ordinarieMin'))}</td><td class="s">${oreTot(sum('straordMin'))}</td></tr>`;

  const assenze = data.assenze.map((a) => {
    const n = data.lavoratori.find(l => l.id === a.worker_id)?.nome || '';
    const per = a.date_from === a.date_to ? dataIt(a.date_from) : `${dataIt(a.date_from)} – ${dataIt(a.date_to)}`;
    const oreAbs = a.ora_dalle && a.ora_alle ? ` dalle ${a.ora_dalle.slice(0, 5)} alle ${a.ora_alle.slice(0, 5)}` : '';
    const tipo = { ferie: 'Ferie', permesso: 'Permesso', malattia: 'Malattia', infortunio: 'Infortunio', maltempo: 'Maltempo', ingiustificata: 'Assenza ingiustificata', sospensione: 'Sospensione disciplinare', altro: 'Altra assenza' }[a.tipo] || a.tipo;
    return `<tr><td>${esc(n)}</td><td>${tipo}</td><td>${per}${oreAbs}</td><td>${a.protocollo ? esc(a.protocollo) : ''}</td><td>${a.note ? esc(a.note) : ''}</td></tr>`;
  }).join('');
  const verifica = daVerificare(data);
  const aggiunte = oreAggiunteRighe(data);
  const notaAggiunte = aggiunte.length ? " Lo straordinario aggiunto dall'ufficio (elencato sopra) è sommato a quello timbrato." : '';

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
  h2 { font-size: 11pt; margin: 0 0 5pt; color: #1A1714; break-after: avoid; page-break-after: avoid; }
  h2 small { font-size: 8pt; font-weight: 400; color: #6E675E; margin-left: 6pt; }
  .muted { color: #A39B90; }
  .warn { color: #A8453B; font-weight: 700; }

  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16pt; padding-bottom: 5pt; border-bottom: 1.4pt solid #1A1714; }
  h1 { font-size: 16pt; margin: 0; letter-spacing: -0.3pt; line-height: 1.1; }
  .az { font-size: 9pt; color: #4D4740; margin-top: 3pt; }
  .kpi { display: flex; gap: 6pt; }
  .kpi div { border: 0.6pt solid #D9D3C9; border-radius: 4pt; padding: 3pt 9pt; min-width: 62pt; text-align: right; }
  .kpi span { display: block; font-size: 6.6pt; color: #6E675E; text-transform: uppercase; letter-spacing: .3pt; }
  .kpi b { font-size: 12pt; font-variant-numeric: tabular-nums; }
  .rules { font-size: 6.6pt; color: #4D4740; margin: 4pt 0 7pt; line-height: 1.35; }

  .riep { table-layout: fixed; font-variant-numeric: tabular-nums; }
  .riep col.lav { width: 48mm; } .riep col.num { width: 16mm; } .riep col.txt { width: 34mm; } .riep col.ver { width: 44mm; }
  .riep th { font-size: 6.6pt; font-weight: 700; color: #fff; background: #22384F; text-transform: uppercase; letter-spacing: .3pt; padding: 4pt 5pt; text-align: left; vertical-align: bottom; }
  .riep th.num { text-align: right; }
  .riep td { border-bottom: 0.5pt solid #E2DCD2; padding: 2.2pt 5pt; vertical-align: top; font-size: 7.6pt; line-height: 1.25; }
  .riep tbody tr:nth-child(even) td { background: #FAF8F4; }
  .riep td.lav b { display: block; font-size: 8.3pt; }
  .riep td.lav span { display: block; font-size: 6.4pt; color: #6E675E; letter-spacing: .2pt; }
  .riep td.num { text-align: right; }
  .riep td.num small { display: block; font-size: 6.4pt; color: #6E675E; }
  .riep td.strong { font-weight: 700; font-size: 8.4pt; }
  .riep td.cant { border-left: 1.2pt solid #22384F; padding-left: 7pt; }
  .riep .c { display: flex; justify-content: space-between; gap: 8pt; padding: 0; }
  .riep .c + .c { border-top: 0.4pt dotted #CFC8BC; }
  .riep .c span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .riep .c b { flex-shrink: 0; font-weight: 700; }
  .riep tr.tot td { background: #F1EEE9 !important; font-weight: 700; border-top: 1.2pt solid #1A1714; border-bottom: 0; }

  .giorni { break-before: page; page-break-before: always; }
  .key { display: flex; flex-wrap: wrap; gap: 2pt 10pt; font-size: 6.8pt; color: #4D4740; margin: 0 0 6pt; }
  .key b { color: #1A1714; } .key i { display: inline-block; width: 7pt; height: 7pt; vertical-align: -1pt; margin-right: 2pt; border: 0.4pt solid #CFC8BC; }
  .cal { table-layout: fixed; font-variant-numeric: tabular-nums; }
  .cal col.n { width: 40mm; } .cal col.s { width: 15mm; }
  .cal th, .cal td { border: 0.4pt solid #D9D3C9; text-align: center; padding: 0; font-size: 7.4pt; height: 7mm; }
  .cal th { font-weight: 700; background: #22384F; color: #fff; height: 8mm; font-size: 7pt; line-height: 1.15; border-color: #22384F; }
  .cal th.d span { font-weight: 400; color: #C9D3DF; font-size: 6pt; }
  .cal th.we { background: #3B5068; }
  .cal td.n { text-align: left; padding: 0 4pt; font-weight: 700; font-size: 7.6pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cal td.d sup { display: block; font-size: 5.6pt; line-height: 1; color: #22384F; font-weight: 700; vertical-align: baseline; }
  .cal .we { background: #F1EEE9; color: #9A9184; }
  .cal td.rit { background: #FBF0D2; }
  .cal td.usc { background: #F8E4E1; }
  .cal td.ass { background: #E3EDF6; color: #1F4E80; font-weight: 700; }
  .cal td.gi { background: #A8453B; color: #fff; font-weight: 700; }
  .cal td.pr { color: #B3ADA3; }
  .cal th.s, .cal td.s { text-align: right; padding-right: 4pt; font-weight: 700; }
  .cal th.s { font-size: 6.4pt; }
  .cal .first { border-left: 1.2pt solid #1A1714; }
  .cal tr.tot td { font-weight: 700; background: #F1EEE9; border-top: 1.2pt solid #1A1714; }

  .det { break-before: page; page-break-before: always; }
  .duo { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18pt; align-items: start; }
  .blk { break-inside: avoid; page-break-inside: avoid; margin-bottom: 9pt; }
  .t2 th, .t2 td { border-bottom: 0.4pt solid #E2DCD2; padding: 2.4pt 4pt; text-align: left; font-size: 7.4pt; vertical-align: top; }
  .t2 th { font-size: 6.4pt; color: #fff; background: #22384F; font-weight: 700; text-transform: uppercase; letter-spacing: .3pt; }
  .t2 td.r, .t2 th.r { text-align: right; font-variant-numeric: tabular-nums; }
  .ver { columns: 2; column-gap: 18pt; }
  .ver p { margin: 0 0 4pt; font-size: 7pt; line-height: 1.32; break-inside: avoid; } .ver b { display: block; }
  .leg { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5pt 14pt; font-size: 7.2pt; }
  .leg div { display: grid; grid-template-columns: 16pt 1fr; align-items: baseline; } .leg b { text-align: center; }
  .note { font-size: 6.8pt; color: #6E675E; line-height: 1.45; border-top: 0.5pt solid #D9D3C9; padding-top: 5pt; margin-top: 6pt; }
  </style></head><body><div class="doc">

  <div class="top">
    <div><h1>Presenze di ${esc(meseMin)}</h1><div class="az">${esc(nome)}${piva} · dal ${dataIt(data.from)} al ${dataIt(data.to)}</div></div>
    <div class="kpi">
      <div><span>Lavoratori</span><b>${data.lavoratori.length}</b></div>
      <div><span>Giorni lavorativi</span><b>${data.giorniLavorativi}</b></div>
      <div><span>Ore ordinarie</span><b>${oreTot(sum('ordinarieMin'))}</b></div>
      <div><span>Straordinario</span><b>${oreTot(sum('straordMin'))}</b></div>
    </div>
  </div>
  <p class="rules">${esc(regoleTesto(data))}. Ore in centesimi (7,5 = 7 ore e 30).</p>

  <h2>Riepilogo del mese</h2>
  <table class="riep">
    <colgroup><col class="lav"><col class="num"><col class="num"><col class="num"><col class="txt"><col class="ver"><col></colgroup>
    <thead><tr><th>Lavoratore</th><th class="num">Giorni</th><th class="num">Ore ord.</th><th class="num">Straord.</th><th>Assenze</th><th>Da verificare</th><th>Cantieri e ore</th></tr></thead>
    <tbody>${riepRows}${riepTot}</tbody>
  </table>

  <section class="giorni">
    <h2>Giorno per giorno <small>${esc(mese)}</small></h2>
    <div class="key">${LEGENDA.slice(0, 9).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}<span><i style="background:#FBF0D2"></i>entrata dopo l'orario</span><span><i style="background:#F8E4E1"></i>uscita prima senza motivo</span><span><i style="background:#A8453B"></i>da giustificare</span></div>
    <table class="cal">
      <colgroup><col class="n">${data.days.map(() => '<col class="d">').join('')}<col class="s"><col class="s"></colgroup>
      <thead><tr><th style="text-align:left;padding-left:4pt">Lavoratore</th>${dayHead}<th class="s first">Ore ord.</th><th class="s">Straord.</th></tr></thead>
      <tbody>${calRows}${calTot}</tbody>
    </table>
  </section>

  <section class="det">
    <div class="duo">
      <div>
        <div class="blk"><h2>Assenze registrate</h2>
        ${assenze ? `<table class="t2"><thead><tr><th>Lavoratore</th><th>Causale</th><th>Periodo</th><th>Protocollo</th><th>Note</th></tr></thead><tbody>${assenze}</tbody></table>` : '<p class="muted">Nessuna assenza registrata nel mese.</p>'}</div>
        ${aggiunte.length ? `<div class="blk"><h2>Straordinario aggiunto dall'ufficio</h2><table class="t2"><thead><tr><th>Lavoratore</th><th>Giorno</th><th class="r">Ore</th><th>Motivo</th></tr></thead><tbody>${aggiunte.map(a => `<tr><td>${esc(a.nome)}</td><td>${dataIt(a.data)}</td><td class="r">${oreTot(a.min)}</td><td>${esc([a.note, a.cantiere].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
      <div class="blk"><h2>Legenda delle causali</h2>
      <div class="leg">${LEGENDA.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div></div>
    </div>
    <h2>Da verificare</h2>
    <div class="ver">${verifica.length ? verifica.map(v => `<p><b>${esc(v.nome)}</b>${v.righe.map(esc).join('<br>')}</p>`).join('') : '<p>Nessuna voce da verificare.</p>'}</div>
    <p class="note">Ore ricavate dalle timbrature registrate in Palladia e contate con le regole indicate in testa al foglio; le timbrature originali sono conservate senza modifiche.${notaAggiunte} Lo stesso mese, con una riga per lavoratore, giorno e causale, è nel file Excel allegato (foglio “Movimenti”).</p>
  </section>
  </div></body></html>`;
}

async function generateFoglioXlsx(data, companyName) {
  const ExcelJS = require('exceljs');
  const nome = companyName || data.azienda?.nome || '';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();
  const h = (min) => Math.round((min / 60) * 100) / 100;
  const headStyle = (row) => { row.font = { bold: true }; row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE9' } }; c.border = { bottom: { style: 'thin', color: { argb: 'FF1A1714' } } }; c.alignment = { vertical: 'middle', wrapText: true }; }); };
  const titolo = (ws, t) => { ws.addRow([t]).font = { bold: true, size: 13 }; ws.addRow([`${nome}${data.azienda?.piva ? ` — P.IVA ${data.azienda.piva}` : ''}`]); ws.addRow([regoleTesto(data)]).font = { italic: true, size: 9, color: { argb: 'FF6E675E' } }; ws.addRow([]); };

  // 1. Riepilogo — F-433: i cantieri con le ore subito dopo le ore, intestazione blu, stampa su una pagina in larghezza
  const s1 = wb.addWorksheet('Riepilogo', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
  titolo(s1, `Presenze per le buste paga — ${meseLabel(data.month)}`);
  const cols1 = ['Lavoratore', 'Codice fiscale', 'Giorni lavorati', 'Ore ordinarie', 'Ore straordinarie', 'di cui festive', 'Cantieri', 'Ferie (gg)', 'Permessi (ore)', 'Malattia (gg)', 'Malattia (ore)', 'Infortunio (gg)', 'Infortunio (ore)', 'Maltempo (ore)', 'Assenze ingiustificate (gg)', 'Altre assenze (gg)', 'Ritardi (n)', 'Ritardi (min)', 'Uscite anticipate (n)', 'Giorni da giustificare', 'Ore lavorabili', 'Ore non coperte', 'Sospensioni (gg)'];
  const CANT = cols1.indexOf('Cantieri') + 1;
  const hr = s1.addRow(cols1);
  hr.height = 30;
  hr.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22384F' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  const primaRiga = s1.rowCount + 1;
  data.lavoratori.forEach((l, i) => {
    const t = l.tot;
    const cant = cantieriDi(data, l).map(c => `${c.nome} · ${String(h(c.min)).replace('.', ',')} h`);
    const r = s1.addRow([l.nome, l.cf, t.giorniLavorati, h(t.ordinarieMin), h(t.straordMin), h(t.straordFestivoMin), cant.join('\n'), t.ferieGiorni, h(t.permessoMin), t.malattiaGiorni, h(t.malattiaMin), t.infortunioGiorni, h(t.infortunioMin), h(t.maltempoMin), t.ingiustificataGiorni, t.altroGiorni, t.ritardi, t.ritardoMin, t.uscitePrima, t.daGiustificare, h(t.oreLavorabiliMin), h(t.oreScoperteMin), t.sospensioneGiorni || 0]);
    r.alignment = { vertical: 'top' };
    r.getCell(1).font = { bold: true };
    r.getCell(CANT).alignment = { vertical: 'top', wrapText: true };
    r.height = Math.max(18, 15 * Math.max(1, cant.length));
    if (i % 2) r.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF8F4' } }; });
  });
  const ultimaRiga = s1.rowCount;
  const lettera = (n) => { let x = ''; while (n > 0) { const m = (n - 1) % 26; x = String.fromCharCode(65 + m) + x; n = Math.floor((n - 1) / 26); } return x; };
  const tr = s1.addRow(cols1.map((c, i) => {
    if (i === 0) return 'Totale';
    if (i === 1 || i + 1 === CANT) return '';
    const L = lettera(i + 1);
    return { formula: `SUM(${L}${primaRiga}:${L}${ultimaRiga})` };
  }));
  tr.font = { bold: true };
  tr.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE9' } }; c.border = { top: { style: 'medium', color: { argb: 'FF1A1714' } } }; });
  s1.columns.forEach((c, i) => {
    c.width = i === 0 ? 26 : i === 1 ? 19 : i + 1 === CANT ? 38 : 12;
    if (i >= 2 && i + 1 !== CANT) c.numFmt = '0.##';
  });
  s1.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${primaRiga - 1}:${primaRiga - 1}`, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  s1.headerFooter = { oddFooter: `&L${nome.replace(/&/g, '&&')} — Presenze ${meseLabel(data.month)}&RPagina &P di &N` };

  // 2. Calendario
  const s2 = wb.addWorksheet('Calendario', { views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }] });
  titolo(s2, `Calendario presenze — ${meseLabel(data.month)}`);
  headStyle(s2.addRow(['Lavoratore', ...data.days.map(d => `${d.day} ${DOW[d.dow]}`)]));
  for (const l of data.lavoratori) {
    const r = s2.addRow([l.nome, ...l.cells.map(cellCode)]);
    l.cells.forEach((c, i) => {
      const d = data.days[i];
      const cell = r.getCell(i + 2);
      cell.alignment = { horizontal: 'center' };
      const fill = c.tipo === 'giustificare' || c.tipo === 'ingiustificata' ? 'FFA8453B' : (d.weekend || d.festivo) ? 'FFF1EEE9' : c.tipo === 'lavoro' && c.ritardo ? 'FFFBF0D2' : c.tipo === 'lavoro' && c.uscitoPrima ? 'FFF8E4E1' : null;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      if (c.tipo === 'giustificare' || c.tipo === 'ingiustificata') cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    });
  }
  s2.getColumn(1).width = 26;
  s2.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  for (let i = 2; i <= data.days.length + 1; i++) s2.getColumn(i).width = 6.5;
  s2.addRow([]);
  for (const [k, v] of LEGENDA) s2.addRow([k, v]);

  // 3. Movimenti — una riga per lavoratore, giorno e causale
  const s3 = wb.addWorksheet('Movimenti', { views: [{ state: 'frozen', ySplit: 1 }] });
  headStyle(s3.addRow(['Codice fiscale', 'Lavoratore', 'Data', 'Codice causale', 'Causale', 'Ore', 'Cantiere']));
  for (const m of movimenti(data)) {
    const [y, mo, d] = m.data.split('-').map(Number);
    s3.addRow([m.cf, m.nome, new Date(Date.UTC(y, mo - 1, d)), m.causale, CAUSALI[m.causale], h(m.min), m.cantiere]);
  }
  s3.getColumn(3).numFmt = 'dd/mm/yyyy';
  s3.getColumn(6).numFmt = '0.##';
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

module.exports = { generateFoglioHtml, generateFoglioXlsx, foglioPdfOpts, cantieriDi, cellCode, meseLabel, movimenti, orePerCantiere, daVerificare, oreAggiunteRighe, CAUSALI };
