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
    if (!c.corretto) continue;
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
      if (c.tipo === 'giustificare' || c.tipo === 'ingiustificata' || c.anomalia) cls += ' gi';
      if (c.tipo === 'prima' || c.tipo === 'carta') cls += ' pr';
      if (c.corretto && c.tipo === 'lavoro') cls += ' cor';
      const txt = esc(cellCode(c)).replace(/ ?\+([\d,]+)/, '<sup>+$1</sup>');
      return `<td class="d ${cls.trim()}">${txt}</td>`;
    }).join('');
    const cant = cantieriDi(data, l);
    return `<tr><td class="n">${esc(l.nome)}</td>${celle}`
      + `<td class="s first">${oreTot(l.tot.ordinarieMin)}</td><td class="s">${oreTot(l.tot.straordMin)}</td>`
      + `<td class="cant">${cant.length ? cant.map(c => `<div><span>${esc(c.nome)}</span><b>${ore(c.min)}</b></div>`).join('') : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  const tot = `<tr class="tot"><td class="n">Totale</td>${data.days.map(() => '<td class="d"></td>').join('')}<td class="s first">${oreTot(sum('ordinarieMin'))}</td><td class="s">${oreTot(sum('straordMin'))}</td><td></td></tr>`;

  const corr = correzioniRighe(data);
  const aggiunte = oreAggiunteRighe(data);
  const verifica = daVerificare(data);
  const assenze = data.assenze.map((a) => {
    const n = data.lavoratori.find(l => l.id === a.worker_id)?.nome || '';
    const per = a.date_from === a.date_to ? dataIt(a.date_from) : `${dataIt(a.date_from)}–${dataIt(a.date_to)}`;
    const oreAbs = a.ora_dalle && a.ora_alle ? ` ${a.ora_dalle.slice(0, 5)}–${a.ora_alle.slice(0, 5)}` : '';
    const tipo = { ferie: 'ferie', permesso: 'permesso', malattia: 'malattia', infortunio: 'infortunio', maltempo: 'maltempo', ingiustificata: 'assenza ingiustificata', sospensione: 'sospensione', altro: 'altra assenza' }[a.tipo] || a.tipo;
    return `<li><b>${esc(n)}</b> · ${per}${oreAbs} · ${tipo}${a.protocollo ? ` · prot. ${esc(a.protocollo)}` : ''}</li>`;
  }).join('');
  const blocco = (titolo, corpo) => `<div class="blk"><h2>${titolo}</h2>${corpo}</div>`;

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
  .mese col.n { width: 36mm; } .mese col.s { width: 12mm; } .mese col.cant { width: 41mm; }
  .mese th, .mese td { border-bottom: 0.4pt solid #E2DCD2; text-align: center; padding: 0; font-size: 7.2pt; height: 6.6mm; }
  .mese th { font-weight: 700; color: #6E675E; font-size: 6.6pt; height: 8mm; line-height: 1.1; }
  .mese th span { display: block; font-weight: 400; font-size: 5.6pt; }
  .mese td.n { text-align: left; padding: 0 4pt; font-weight: 700; font-size: 7.6pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mese td.d sup { display: block; font-size: 5.4pt; line-height: 1; color: #22384F; font-weight: 700; }
  .mese .we { background: #F3F1EC; color: #9A9184; }
  .mese td.ass { color: #1F5FA8; font-weight: 700; }
  .mese td.gi { background: #FBE3E0; color: #9A2219; font-weight: 700; }
  .mese td.pr { color: #B3ADA3; }
  .mese td.cor { color: #1F5FA8; font-weight: 700; text-decoration: underline; }
  .mese th.s, .mese td.s { text-align: right; padding-right: 4pt; font-weight: 700; }
  .mese .first { border-left: 1pt solid #1A1714; }
  .mese th.cant, .mese td.cant { text-align: left; padding: 2pt 0 2pt 6pt; border-left: 0.6pt solid #CFC8BC; }
  .mese td.cant div { display: flex; justify-content: space-between; gap: 6pt; font-size: 6.8pt; line-height: 1.3; color: #3D3832; }
  .mese td.cant span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mese td.cant b { flex-shrink: 0; }
  .mese tr.tot td { font-weight: 700; border-top: 1.4pt solid #1A1714; border-bottom: 0; }
  .key { display: flex; flex-wrap: wrap; gap: 2pt 10pt; font-size: 6.8pt; color: #4D4740; margin: 6pt 0 8pt; }
  .key b { color: #1A1714; }
  .duo { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18pt; align-items: start; }
  .blk { break-inside: avoid; page-break-inside: avoid; margin-bottom: 7pt; }
  h2 { font-size: 8.4pt; margin: 0 0 3pt; }
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
    <colgroup><col class="n">${data.days.map(() => '<col class="d">').join('')}<col class="s"><col class="s"><col class="cant"></colgroup>
    <thead><tr><th style="text-align:left;padding-left:4pt">Lavoratore</th>${dayHead}<th class="s first">Ore</th><th class="s">Straord.</th><th class="cant">Cantieri</th></tr></thead>
    <tbody>${righe}${tot}</tbody>
  </table>
  <div class="key"><span><b>8</b> ore lavorate</span><span><b>+1</b> straordinario</span><span><b>F</b> ferie</span><span><b>P</b> permesso</span><span><b>M</b> malattia</span><span><b>I</b> infortunio</span><span><b>T</b> maltempo</span><span><b>AI</b> ingiustificata</span><span><b>S</b> sospensione</span><span><b>FS</b> festività</span><span><b>C</b> foglio di carta</span><span><b>?</b> da giustificare</span><span><b style="color:#1F5FA8;text-decoration:underline">8</b> corretto dall'ufficio</span><span><b style="background:#F3F1EC;padding:0 3pt">&nbsp;</b> sabato, domenica e festivi</span></div>
  <div class="duo">
    <div>
      ${corr.length ? blocco("Correzioni dell'ufficio", `<ul>${corr.map(k => `<li><b>${esc(k.nome)}</b> · ${dataIt(k.data)} · ${esc(k.testo)}${k.nota ? ` · «${esc(k.nota)}»` : ''}</li>`).join('')}</ul>`) : ''}
      ${aggiunte.length ? blocco("Straordinario aggiunto dall'ufficio", `<ul>${aggiunte.map(a => `<li><b>${esc(a.nome)}</b> · ${dataIt(a.data)} · ${oreTot(a.min)} h${a.note ? ` · ${esc(a.note)}` : ''}</li>`).join('')}</ul>`) : ''}
      ${assenze ? blocco('Assenze', `<ul>${assenze}</ul>`) : ''}
    </div>
    <div>${blocco('Da verificare', verifica.length ? `<ul>${verifica.map(v => `<li><b>${esc(v.nome)}</b>: ${v.righe.map(esc).join('; ')}</li>`).join('')}</ul>` : '<ul><li>Niente da verificare.</li></ul>')}</div>
  </div>
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
  const h = (min) => Math.round((min / 60) * 100) / 100;
  const headStyle = (row) => { row.font = { bold: true }; row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE9' } }; c.border = { bottom: { style: 'thin', color: { argb: 'FF1A1714' } } }; c.alignment = { vertical: 'middle', wrapText: true }; }); };
  const titolo = (ws, t) => { ws.addRow([t]).font = { bold: true, size: 13 }; ws.addRow([`${nome}${data.azienda?.piva ? ` — P.IVA ${data.azienda.piva}` : ''}`]); ws.addRow([regoleTesto(data)]).font = { italic: true, size: 9, color: { argb: 'FF6E675E' } }; ws.addRow([]); };

  // 0. F-435: «Ore del mese», la stessa tabella del PDF e di Palladia —
  // lavoratore, i giorni, ore, straordinario e i cantieri con le ore accanto.
  const s0 = wb.addWorksheet('Ore del mese', { views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }] });
  titolo(s0, `Ore di ${meseLabel(data.month).toLowerCase()}`);
  const nG = data.days.length;
  const h0 = s0.addRow(['Lavoratore', ...data.days.map(d => `${d.day}\n${DOW[d.dow]}`), 'Ore', 'Straord.', 'Cantieri']);
  h0.height = 30;
  h0.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22384F' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  for (const l of data.lavoratori) {
    const cant = cantieriDi(data, l).map(c => `${c.nome} ${String(h(c.min)).replace('.', ',')} h`);
    const r = s0.addRow([l.nome, ...l.cells.map(cellCode), h(l.tot.ordinarieMin), h(l.tot.straordMin), cant.join('\n')]);
    r.getCell(1).font = { bold: true };
    r.height = Math.max(18, 15 * Math.max(1, cant.length));
    l.cells.forEach((c, i) => {
      const d = data.days[i];
      const cell = r.getCell(i + 2);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      const gi = c.tipo === 'giustificare' || c.tipo === 'ingiustificata' || c.anomalia;
      const fill = gi ? 'FFFBE3E0' : (d.weekend || d.festivo) ? 'FFF3F1EC' : null;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      if (gi) cell.font = { bold: true, color: { argb: 'FF9A2219' } };
      else if (c.corretto && c.tipo === 'lavoro') cell.font = { bold: true, underline: true, color: { argb: 'FF1F5FA8' } };
      else if (['ferie', 'malattia', 'infortunio', 'permesso', 'maltempo', 'altro', 'sospensione'].includes(c.tipo)) cell.font = { bold: true, color: { argb: 'FF1F5FA8' } };
    });
    r.getCell(nG + 2).font = { bold: true };
    r.getCell(nG + 4).alignment = { wrapText: true, vertical: 'top' };
  }
  const t0 = s0.addRow(['Totale', ...data.days.map(() => ''), h(data.lavoratori.reduce((s, l) => s + l.tot.ordinarieMin, 0)), h(data.lavoratori.reduce((s, l) => s + l.tot.straordMin, 0)), '']);
  t0.font = { bold: true };
  t0.eachCell({ includeEmpty: true }, (c) => { c.border = { top: { style: 'medium', color: { argb: 'FF1A1714' } } }; });
  s0.getColumn(1).width = 26;
  for (let i = 2; i <= nG + 1; i++) s0.getColumn(i).width = 5.5;
  s0.getColumn(nG + 2).width = 9; s0.getColumn(nG + 3).width = 9; s0.getColumn(nG + 4).width = 34;
  s0.getColumn(nG + 2).numFmt = '0.##'; s0.getColumn(nG + 3).numFmt = '0.##';
  s0.addRow([]);
  s0.addRow(['Legenda: 8 ore lavorate · +1 straordinario · F ferie · P permesso · M malattia · I infortunio · T maltempo · AI ingiustificata · S sospensione · FS festività · C foglio di carta · ? da giustificare · blu sottolineato = corretto dall\'ufficio']).font = { size: 9, color: { argb: 'FF4D4740' } };
  s0.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '5:5', margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  s0.headerFooter = { oddFooter: `&L${nome.replace(/&/g, '&&')} — Ore di ${meseLabel(data.month)}&RPagina &P di &N` };

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

module.exports = { generateFoglioHtml, generateFoglioXlsx, foglioPdfOpts, cantieriDi, cellCode, meseLabel, movimenti, orePerCantiere, daVerificare, oreAggiunteRighe, correzioniRighe, CAUSALI };
