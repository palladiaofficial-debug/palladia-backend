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
const gg = (n) => (n > 0 ? String(n) : '—');
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
  ALT: 'Altra assenza',
};
const CODICE_CELLA = { ferie: 'F', malattia: 'M', infortunio: 'I', permesso: 'P', maltempo: 'T', ingiustificata: 'AI', altro: 'A', giustificare: '?', prima: '—', carta: 'C', festivo: 'FS' };
const LEGENDA = [
  ['8', 'ore ordinarie lavorate (in centesimi: 7,5 = 7 ore e 30)'],
  ['+1', 'ore straordinarie del giorno'],
  ['F', 'ferie'], ['P', 'permesso'], ['M', 'malattia'], ['I', 'infortunio'], ['T', 'maltempo (pioggia o caldo)'],
  ['AI', 'assenza ingiustificata'], ['A', 'altra assenza'], ['FS', 'festività'],
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

function generateFoglioHtml(data, companyName) {
  const nome = companyName || data.azienda?.nome || '';
  const piva = data.azienda?.piva ? ` · P.IVA ${esc(data.azienda.piva)}` : '';
  const sum = (k) => data.lavoratori.reduce((s, l) => s + (l.tot[k] || 0), 0);
  const altroGG = (t) => (t.infortunioGiorni || 0) + (t.ingiustificataGiorni || 0) + (t.altroGiorni || 0);

  const dayHead = data.days.map(d => `<th class="d ${d.weekend || d.festivo ? 'we' : ''}">${d.day}<br><span>${DOW[d.dow]}</span></th>`).join('');
  const rows = data.lavoratori.map((l) => {
    const t = l.tot;
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
    const orario = l.orario ? `<span class="or">orario ${esc(l.orario)}</span>` : '';
    return `<tr><td class="n"><b>${esc(l.nome)}</b><span>${esc(l.cf)}</span>${orario}</td>${celle}`
      + `<td class="s first">${oreTot(t.ordinarieMin)}</td><td class="s">${oreTot(t.straordMin)}</td><td class="s">${gg(t.ferieGiorni)}</td>`
      + `<td class="s">${oreTot(t.permessoMin)}</td><td class="s">${t.malattiaGiorni ? gg(t.malattiaGiorni) + ' gg' : oreTot(t.malattiaMin)}</td>`
      + `<td class="s">${oreTot(t.maltempoMin)}</td><td class="s">${gg(altroGG(t))}</td></tr>`;
  }).join('');
  const totRow = `<tr class="tot"><td class="n"><b>Totale</b></td>${data.days.map(() => '<td class="d"></td>').join('')}`
    + `<td class="s first">${oreTot(sum('ordinarieMin'))}</td><td class="s">${oreTot(sum('straordMin'))}</td><td class="s">${gg(sum('ferieGiorni'))}</td>`
    + `<td class="s">${oreTot(sum('permessoMin'))}</td><td class="s">${gg(sum('malattiaGiorni'))}</td><td class="s">${oreTot(sum('maltempoMin'))}</td>`
    + `<td class="s">${gg(data.lavoratori.reduce((s, l) => s + altroGG(l.tot), 0))}</td></tr>`;

  const cantieri = orePerCantiere(data);
  const assenze = data.assenze.map((a) => {
    const n = data.lavoratori.find(l => l.id === a.worker_id)?.nome || '';
    const per = a.date_from === a.date_to ? dataIt(a.date_from) : `${dataIt(a.date_from)} – ${dataIt(a.date_to)}`;
    const oreAbs = a.ora_dalle && a.ora_alle ? ` dalle ${a.ora_dalle.slice(0, 5)} alle ${a.ora_alle.slice(0, 5)}` : '';
    const tipo = { ferie: 'Ferie', permesso: 'Permesso', malattia: 'Malattia', infortunio: 'Infortunio', maltempo: 'Maltempo', ingiustificata: 'Assenza ingiustificata', altro: 'Altra assenza' }[a.tipo] || a.tipo;
    return `<tr><td>${esc(n)}</td><td>${tipo}</td><td>${per}${oreAbs}</td><td>${a.protocollo ? esc(a.protocollo) : ''}</td><td>${a.note ? esc(a.note) : ''}</td></tr>`;
  }).join('');
  const verifica = daVerificare(data);

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 10mm 8mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1A1714; font-size: 8pt; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12pt; border-bottom: 1.2pt solid #1A1714; padding-bottom: 5pt; margin-bottom: 4pt; }
  h1 { font-size: 15pt; margin: 0; letter-spacing: -0.2pt; }
  .az { font-size: 9pt; color: #4D4740; margin-top: 2pt; }
  .meta { text-align: right; font-size: 7pt; color: #6E675E; line-height: 1.4; }
  .rules { font-size: 6.8pt; color: #4D4740; margin: 0 0 6pt; }
  table { border-collapse: collapse; width: 100%; }
  .cal { table-layout: fixed; font-variant-numeric: tabular-nums; }
  .cal th, .cal td { border: 0.35pt solid #D9D3C9; text-align: center; padding: 1.6pt 0; font-size: 6.6pt; height: 17pt; }
  .cal th { font-weight: 700; background: #F5F2ED; height: 18pt; }
  .cal th.d span { font-weight: 400; color: #6E675E; }
  .cal col.n { width: 30mm; } .cal col.d { width: 5.15mm; } .cal col.s { width: 10.6mm; }
  .cal td.n { text-align: left; padding: 1.5pt 3pt; line-height: 1.15; }
  .cal td.n b { display: block; font-size: 7pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cal td.n span { display: block; font-size: 5.6pt; color: #6E675E; letter-spacing: .1pt; }
  .cal td.n .or { color: #2E4A7A; }
  .cal td.d sup { display: block; font-size: 5.2pt; line-height: 1; color: #223049; font-weight: 700; vertical-align: baseline; }
  .cal .we { background: #F1EEE9; color: #9A9184; }
  .cal td.rit { background: #FBF0D2; }
  .cal td.usc { background: #F8E4E1; }
  .cal td.ass { background: #E3EDF6; color: #1F4E80; font-weight: 700; }
  .cal td.gi { background: #A8453B; color: #fff; font-weight: 700; }
  .cal td.pr { color: #B3ADA3; }
  .cal th.s, .cal td.s { text-align: right; padding-right: 3pt; font-size: 7pt; }
  .cal th.s { font-size: 6pt; line-height: 1.1; white-space: normal; }
  .cal .first { border-left: 1.2pt solid #1A1714; }
  .cal tr.tot td { font-weight: 700; background: #F5F2ED; border-top: 1pt solid #1A1714; }
  .key { display: flex; flex-wrap: wrap; gap: 2pt 9pt; font-size: 6.4pt; color: #4D4740; margin-top: 4pt; }
  .key b { color: #1A1714; } .key i { display: inline-block; width: 7pt; height: 7pt; vertical-align: -1pt; margin-right: 2pt; border: 0.35pt solid #D9D3C9; }
  .p2 { page-break-before: always; display: grid; grid-template-columns: 1fr 1fr; gap: 10pt 14pt; align-items: start; }
  h2 { font-size: 9.5pt; margin: 0 0 4pt; }
  .t2 th, .t2 td { border-bottom: 0.35pt solid #D9D3C9; padding: 2.5pt 4pt; text-align: left; font-size: 7pt; vertical-align: top; }
  .t2 th { font-size: 6.4pt; color: #6E675E; font-weight: 700; text-transform: uppercase; letter-spacing: .3pt; }
  .t2 td.r, .t2 th.r { text-align: right; font-variant-numeric: tabular-nums; }
  .ver p { margin: 0 0 4pt; font-size: 7pt; line-height: 1.35; } .ver b { display: block; }
  .leg td { padding: 1.5pt 4pt; font-size: 6.8pt; } .leg td:first-child { font-weight: 700; width: 22pt; text-align: center; }
  .note { font-size: 6.4pt; color: #6E675E; margin-top: 6pt; line-height: 1.4; }
  .full { grid-column: 1 / -1; }
  </style></head><body>
  <div class="head">
    <div><h1>Presenze per le buste paga — ${esc(meseLabel(data.month))}</h1><div class="az">${esc(nome)}${piva}</div></div>
    <div class="meta">${data.lavoratori.length} lavoratori · ${data.giorniLavorativi} giorni lavorativi<br>Dal ${dataIt(data.from)} al ${dataIt(data.to)}</div>
  </div>
  <p class="rules">${esc(regoleTesto(data))}.</p>
  <table class="cal">
    <colgroup><col class="n">${data.days.map(() => '<col class="d">').join('')}${'<col class="s">'.repeat(7)}</colgroup>
    <thead><tr><th style="text-align:left;padding-left:3pt">Lavoratore</th>${dayHead}<th class="s first">Ore<br>ordinarie</th><th class="s">Ore<br>straord.</th><th class="s">Ferie<br>gg</th><th class="s">Permessi<br>ore</th><th class="s">Malattia</th><th class="s">Maltempo<br>ore</th><th class="s">Altre<br>assenze gg</th></tr></thead>
    <tbody>${rows}${totRow}</tbody>
  </table>
  <div class="key">${LEGENDA.slice(0, 9).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}<span><i style="background:#FBF0D2"></i>entrata dopo l'orario</span><span><i style="background:#F8E4E1"></i>uscita prima dell'orario senza motivo</span><span><i style="background:#A8453B"></i>da giustificare</span></div>

  <div class="p2">
    <div>
      <h2>Ore per cantiere</h2>
      ${cantieri.length ? `<table class="t2"><thead><tr><th>Lavoratore</th><th>Codice fiscale</th><th>Cantiere</th><th class="r">Ordinarie</th><th class="r">Straord.</th></tr></thead><tbody>${cantieri.map(c => `<tr><td>${esc(c.nome)}</td><td>${esc(c.cf)}</td><td>${esc(c.cantiere)}</td><td class="r">${oreTot(c.ord)}</td><td class="r">${oreTot(c.str)}</td></tr>`).join('')}</tbody></table>` : '<p class="note">Nessuna ora lavorata nel mese.</p>'}
    </div>
    <div>
      <h2>Assenze registrate</h2>
      ${assenze ? `<table class="t2"><thead><tr><th>Lavoratore</th><th>Causale</th><th>Periodo</th><th>Protocollo certificato</th><th>Note</th></tr></thead><tbody>${assenze}</tbody></table>` : '<p class="note">Nessuna assenza registrata nel mese.</p>'}
      <h2 style="margin-top:10pt">Da verificare</h2>
      <div class="ver">${verifica.length ? verifica.map(v => `<p><b>${esc(v.nome)}</b>${v.righe.map(esc).join('<br>')}</p>`).join('') : '<p>Nessuna voce da verificare.</p>'}</div>
      <h2 style="margin-top:10pt">Legenda delle causali</h2>
      <table class="leg"><tbody>${LEGENDA.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
    </div>
    <p class="note full">Ore ricavate dalle timbrature registrate in Palladia e contate con le regole indicate in testa al foglio; le timbrature originali sono conservate senza modifiche. Ore in centesimi (7,5 = 7 ore e 30 minuti). Lo stesso mese, con una riga per lavoratore, giorno e causale, è nel file Excel allegato (foglio “Movimenti”).</p>
  </div>
  </body></html>`;
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

  // 1. Riepilogo
  const s1 = wb.addWorksheet('Riepilogo', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
  titolo(s1, `Presenze per le buste paga — ${meseLabel(data.month)}`);
  const cols1 = ['Lavoratore', 'Codice fiscale', 'Giorni lavorati', 'Ore ordinarie', 'Ore straordinarie', 'di cui festive', 'Ferie (gg)', 'Permessi (ore)', 'Malattia (gg)', 'Malattia (ore)', 'Infortunio (gg)', 'Infortunio (ore)', 'Maltempo (ore)', 'Assenze ingiustificate (gg)', 'Altre assenze (gg)', 'Ritardi (n)', 'Ritardi (min)', 'Uscite anticipate (n)', 'Giorni da giustificare', 'Ore lavorabili', 'Ore non coperte'];
  headStyle(s1.addRow(cols1));
  for (const l of data.lavoratori) {
    const t = l.tot;
    s1.addRow([l.nome, l.cf, t.giorniLavorati, h(t.ordinarieMin), h(t.straordMin), h(t.straordFestivoMin), t.ferieGiorni, h(t.permessoMin), t.malattiaGiorni, h(t.malattiaMin), t.infortunioGiorni, h(t.infortunioMin), h(t.maltempoMin), t.ingiustificataGiorni, t.altroGiorni, t.ritardi, t.ritardoMin, t.uscitePrima, t.daGiustificare, h(t.oreLavorabiliMin), h(t.oreScoperteMin)]);
  }
  const tr = s1.addRow(['Totale', '', ...cols1.slice(2).map((_, i) => ({ formula: `SUM(${String.fromCharCode(67 + i)}6:${String.fromCharCode(67 + i)}${5 + data.lavoratori.length})` }))]);
  tr.font = { bold: true };
  s1.columns.forEach((c, i) => { c.width = i === 0 ? 26 : i === 1 ? 19 : 12; if (i >= 2) c.numFmt = '0.##'; });

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

module.exports = { generateFoglioHtml, generateFoglioXlsx, cellCode, meseLabel, movimenti, orePerCantiere, daVerificare, CAUSALI };
