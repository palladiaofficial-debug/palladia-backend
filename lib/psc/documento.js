'use strict';
/**
 * lib/psc/documento.js — F-270. I documenti del coordinatore in HTML per
 * Puppeteer (pdf-renderer: @page 26/24 mm, header/footer nativi):
 *  - PSC completo (copertina con indice e pagine, 12 sezioni, firme);
 *  - Fascicolo dell'opera, bozza (Allegato XVI);
 *  - Dati per la notifica preliminare (art. 99, Allegato XII);
 *  - Verbale di sopralluogo o riunione.
 * Lo stesso HTML del PSC, con un involucro per Word, diventa il file .doc.
 *
 * Nel PSC entra SOLO ciò che il coordinatore ha approvato: misure con
 * approvata=true, voci di organizzazione attive, rischi del contesto accesi.
 */
const { ORGANIZZAZIONE, CATEGORIE_COSTI } = require('./catalog');
const { riepilogo } = require('./costi');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const d = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '—');
const dLong = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
// Sempre col punto delle migliaia (1.200,00): Intl it-IT non raggruppa i numeri di 4 cifre.
const eur = (n) => { const v = Number(n) || 0; const [i, d] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`; };
const num = (n) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: 3 });

const SEZIONI = [
  ['1', 'Identificazione e descrizione dell\'opera'],
  ['2', 'Soggetti con compiti di sicurezza'],
  ['3', 'Area di cantiere, contesto e rischi esterni'],
  ['4', 'Organizzazione del cantiere'],
  ['5', 'Lavorazioni: rischi e misure di prevenzione'],
  ['6', 'Interferenze e prescrizioni operative'],
  ['7', 'Uso comune di apprestamenti, attrezzature e servizi'],
  ['8', 'Cooperazione, coordinamento e informazione'],
  ['9', 'Cronoprogramma dei lavori'],
  ['10', 'Costi della sicurezza'],
  ['11', 'Gestione delle emergenze'],
  ['12', 'Procedure complementari e di dettaglio'],
];

function css() {
  return `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
@page { size: A4; margin: 26mm 0 24mm 0; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; overflow-wrap: break-word; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif; font-size: 9.6pt; line-height: 1.55; color: #1A1714; background: #FFFFFF; }
.doc { width: 100%; padding: 0 16mm; }
h1, h2, h3 { break-after: avoid-page; page-break-after: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
.cover { height: 247mm !important; overflow: hidden !important; display: flex; flex-direction: column; gap: 5mm; break-after: page; page-break-after: always; }
.eyebrow { font-size: 7.6pt; font-weight: 800; letter-spacing: 1.2pt; color: #7A736A; text-transform: uppercase; }
.cover h1 { font-size: 24pt; font-weight: 800; letter-spacing: -0.4pt; line-height: 1.12; }
.cover .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; padding-bottom: 4mm; border-bottom: 1.6pt solid #22384F; }
.rev { text-align: right; }
.rev b { display: block; font-size: 16pt; color: #22384F; }
.kv { display: grid; grid-template-columns: 44mm 1fr; gap: 1.2mm 5mm; font-size: 9pt; }
.kv .k { color: #7A736A; font-weight: 600; }
.kv .v { font-weight: 700; }
.box { background: #F6F4F0; border-radius: 2mm; padding: 3mm 4mm; }
.idx { display: flex; gap: 3mm; font-size: 9pt; padding: 1.1mm 0; border-bottom: 0.5pt dotted #D9D3C9; }
.idx b { width: 8mm; color: #22384F; }
.idx em { margin-left: auto; font-style: normal; font-weight: 700; }
.cover .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; font-size: 8pt; color: #7A736A; padding-top: 3mm; border-top: 0.5pt solid #ECE7DF; }
h2.sec { font-size: 14pt; font-weight: 800; margin: 7mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1pt solid #22384F; color: #1A1714; }
h2.sec .n { color: #22384F; margin-right: 2mm; }
h2.sec.first { margin-top: 0; }
h2.sec.newpage { break-before: page; page-break-before: always; margin-top: 0; }
h3 { font-size: 10.6pt; font-weight: 800; margin: 4.5mm 0 1.8mm; }
p { margin: 0 0 2mm; }
.muted { color: #7A736A; }
.small { font-size: 8.2pt; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 1.5mm 0 3mm; font-size: 8.6pt; }
th { text-align: left; background: #EEF2F6; color: #22384F; font-weight: 800; padding: 1.6mm 2mm; font-size: 8pt; }
td { padding: 1.6mm 2mm; border-bottom: 0.5pt solid #ECE7DF; vertical-align: top; }
td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
tr.tot td { font-weight: 800; border-top: 1pt solid #1A1714; border-bottom: 0; }
ul.m { margin: 0 0 2mm 4.5mm; }
ul.m li { margin: 0 0 1mm; }
.lv { display: inline-block; padding: 0.3mm 2mm; border-radius: 4mm; font-size: 7.6pt; font-weight: 800; }
.lv.molto-alto, .lv.alto { background: #FBF0EE; color: #A8453B; }
.lv.medio { background: #FDF1E7; color: #B25A14; }
.lv.basso { background: #F0F4F0; color: #4A7358; }
.lav { break-inside: auto; margin-bottom: 4mm; }
.lav-head { display: flex; justify-content: space-between; gap: 4mm; background: #F6F4F0; padding: 2mm 3mm; border-radius: 1.5mm; break-after: avoid-page; }
.lav-head b { font-size: 10.4pt; }
.gantt td { padding: 1mm 0.6mm; border-bottom: 0.5pt solid #F1ECE5; }
.gantt td.l { padding: 1mm 2mm; font-size: 8pt; }
.gantt .bar { height: 3.2mm; border-radius: 0.8mm; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-top: 8mm; break-inside: avoid; }
.sign .line { border-bottom: 0.6pt solid #9C948A; height: 14mm; margin-top: 2mm; }
.layout-img { max-width: 100%; max-height: 200mm; display: block; margin: 2mm 0; border: 0.5pt solid #ECE7DF; }
.photo { width: 52mm; height: 39mm; object-fit: cover; border-radius: 1mm; border: 0.5pt solid #ECE7DF; }
`;
}

function wrap(body, title) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css()}</style></head><body><div class="doc">${body}</div></body></html>`;
}

const ok = (v) => v && v.approvata !== false && v.approvato !== false;

// Indirizzo + comune, senza ripetere il comune se è già scritto nell'indirizzo
const luogo = (address, comune) => (address && comune && address.toLowerCase().includes(comune.toLowerCase()) ? address : [address, comune].filter(Boolean).join(', '));

const PALETTE = ['#22384F', '#B7832F', '#3E7C78', '#7A4F6E', '#9A8F80', '#4A7358', '#A8453B', '#5B6B8C'];

function sogg(p) {
  const s = p.soggetti || {};
  const row = (k, o) => (o && (o.nome || o.ragione_sociale) ? `<tr><td style="width:62mm" class="muted">${esc(k)}</td><td><b>${esc(o.nome || o.ragione_sociale)}</b>${o.qualifica ? `, ${esc(o.qualifica)}` : ''}${[o.indirizzo, o.telefono, o.email, o.pec].filter(Boolean).length ? `<br><span class="small muted">${esc([o.indirizzo, o.telefono, o.email, o.pec].filter(Boolean).join(' · '))}</span>` : ''}</td></tr>` : '');
  return [
    row('Committente', s.committente), row('Responsabile dei lavori', s.responsabile_lavori),
    row('Progettista', s.progettista), row('Direttore dei lavori', s.direttore_lavori),
    row('Coordinatore per la progettazione (CSP)', s.csp), row('Coordinatore per l\'esecuzione (CSE)', s.cse),
  ].join('');
}

/**
 * @param {object} snap { project, lavorazioni, imprese, costi, decisioni, revisioni, layoutDataUri, pagine }
 */
function pscBody(snap, { pagine = {}, perWord = false } = {}) {
  const p = snap.project;
  const lav = [...(snap.lavorazioni || [])].sort((a, b) => (a.start_date || '9').localeCompare(b.start_date || '9') || a.ordine - b.ordine);
  const imprese = snap.imprese || [];
  const impById = new Map(imprese.map(i => [i.id, i]));
  const lavById = new Map(lav.map(l => [l.id, l]));
  const color = new Map(imprese.map((i, k) => [i.id, i.color || PALETTE[k % PALETTE.length]]));
  const ug = lav.reduce((s, l) => s + (Number(l.uomini_giorno) || 0), 0);
  const riep = riepilogo(snap.costi || [], imprese);
  const rev = p.revision || 0;
  const cse = (p.soggetti && p.soggetti.cse && p.soggetti.cse.nome) || '';

  // ── Copertina ──
  const revRows = (snap.revisioni || []).map(r => `<tr><td style="width:14mm">${r.revision}</td><td style="width:26mm">${d(r.created_at)}</td><td>${esc(r.motivo)}</td></tr>`).join('');
  const idx = SEZIONI.map(([n, t]) => `<div class="idx"><b>${n}</b>${esc(t)}<em>${pagine[n] || ''}</em></div>`).join('');
  let out = `<section class="cover">
  <div class="top"><div><div class="eyebrow">D.Lgs. 81/2008 · art. 100 e Allegato XV</div><h1>Piano di Sicurezza<br>e Coordinamento</h1></div>
  <div class="rev"><b>Rev. ${rev}</b><span class="muted">${dLong(p.signed_at || new Date().toISOString())}</span></div></div>
  <div><div class="eyebrow">Opera</div><div style="font-size:15pt;font-weight:800;margin-top:1mm">${esc(p.title)}</div>
  <div class="muted">${esc(luogo(p.address, p.comune))}${p.start_date ? ` · lavori dal ${dLong(p.start_date)} al ${dLong(p.end_date)}` : ''}</div></div>
  <div class="kv">
   <span class="k">Committente</span><span class="v">${esc((p.soggetti && p.soggetti.committente && p.soggetti.committente.nome) || '—')}</span>
   <span class="k">Responsabile dei lavori</span><span class="v">${esc((p.soggetti && p.soggetti.responsabile_lavori && p.soggetti.responsabile_lavori.nome) || '—')}</span>
   <span class="k">CSP</span><span class="v">${esc((p.soggetti && p.soggetti.csp && p.soggetti.csp.nome) || '—')}</span>
   <span class="k">CSE</span><span class="v">${esc(cse || '—')}</span>
   ${p.importo_lavori ? `<span class="k">Importo lavori</span><span class="v">${eur(p.importo_lavori)} €</span>` : ''}
   <span class="k">Costi della sicurezza</span><span class="v">${eur(riep.totale)} € (non soggetti a ribasso)</span>
   <span class="k">Entità presunta</span><span class="v">${Math.round(ug)} uomini-giorno · ${imprese.length || '—'} imprese</span>
  </div>
  ${revRows ? `<div><div class="eyebrow" style="margin-bottom:1mm">Revisioni</div><table><thead><tr><th style="width:14mm">Rev.</th><th style="width:26mm">Data</th><th>Motivo</th></tr></thead><tbody>${revRows}</tbody></table></div>` : ''}
  <div><div class="eyebrow" style="margin-bottom:1mm">Indice</div>${idx}</div>
  <div class="foot"><span>Firma del coordinatore per la sicurezza<br><span style="display:inline-block;width:62mm;border-bottom:0.6pt solid #9C948A;height:9mm"></span></span><span style="text-align:right">${esc(cse)}<br>Redatto con Palladia</span></div>
</section>`;

  // ── 1 Opera ──
  const durata = p.start_date && p.end_date ? Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1 : null;
  out += `<h2 class="sec first"><span class="n">1</span>Identificazione e descrizione dell'opera</h2>
  <table><tbody>
   <tr><td style="width:52mm" class="muted">Opera</td><td><b>${esc(p.title)}</b></td></tr>
   <tr><td class="muted">Indirizzo del cantiere</td><td>${esc((luogo(p.address, p.comune) + (p.provincia ? ` (${p.provincia})` : '')) || '—')}</td></tr>
   ${p.tipo_opera ? `<tr><td class="muted">Tipo di opera</td><td>${esc(p.tipo_opera)}</td></tr>` : ''}
   <tr><td class="muted">Inizio e fine lavori</td><td>${d(p.start_date)} – ${d(p.end_date)}${durata ? ` (${durata} giorni naturali)` : ''}</td></tr>
   ${p.importo_lavori ? `<tr><td class="muted">Importo presunto dei lavori</td><td>${eur(p.importo_lavori)} €</td></tr>` : ''}
   <tr><td class="muted">Entità presunta del cantiere</td><td>${Math.round(ug)} uomini-giorno</td></tr>
  </tbody></table>
  ${p.descrizione ? `<h3>Descrizione sintetica dell'opera</h3><p>${nl(p.descrizione)}</p>` : ''}
  ${p.testi && p.testi.descrizione_contesto ? `<h3>Contesto in cui è collocata l'area di cantiere</h3><p>${nl(p.testi.descrizione_contesto)}</p>` : ''}`;

  // ── 2 Soggetti ──
  out += `<h2 class="sec"><span class="n">2</span>Soggetti con compiti di sicurezza</h2>
  <table><tbody>${sogg(p)}</tbody></table>
  ${imprese.length ? `<h3>Imprese e lavoratori autonomi</h3><table><thead><tr><th>Ragione sociale</th><th style="width:30mm">Ruolo</th><th>Lavorazioni affidate</th></tr></thead><tbody>${imprese.map(i => `<tr><td><b>${esc(i.ragione_sociale)}</b>${i.piva ? `<br><span class="small muted">P.IVA ${esc(i.piva)}</span>` : ''}</td><td>${{ affidataria: 'Affidataria', esecutrice: 'Esecutrice', autonomo: 'Lavoratore autonomo' }[i.ruolo] || ''}</td><td>${esc(lav.filter(l => l.impresa_id === i.id).map(l => l.nome).join(', ') || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Le imprese esecutrici saranno indicate nelle revisioni successive, prima del loro ingresso in cantiere.</p>'}`;

  // ── 3 Area ──
  const ctx = p.contesto || {};
  const attivi = (ctx.trovati || []).filter(t => t.attivo !== false);
  const domande = ctx.domande || {};
  const extra = [];
  if (domande.edificio_in_uso === true) extra.push({ titolo: 'Edificio in uso durante i lavori', misure: (ctx.misure_custom && ctx.misure_custom.edificio_in_uso) || require('./catalog').CONTESTO.edificio_in_uso.misure });
  out += `<h2 class="sec"><span class="n">3</span>Area di cantiere, contesto e rischi esterni</h2>
  ${attivi.length || extra.length ? `<table><thead><tr><th style="width:58mm">Elemento</th><th>Rischio e misure</th></tr></thead><tbody>${[...extra.map(e => `<tr><td><b>${esc(e.titolo)}</b></td><td>${nl(e.misure)}</td></tr>`), ...attivi.map(t => `<tr><td><b>${esc(t.titolo)}</b><br><span class="small muted">${esc(t.dettaglio || '')}${t.fonte ? ` · fonte ${esc(t.fonte)}` : ''}</span></td><td>${nl(t.misure_testo || t.misure)}</td></tr>`)].join('')}</tbody></table>` : '<p>Non sono stati individuati elementi esterni che generano rischi particolari per il cantiere o trasmessi dal cantiere all\'esterno.</p>'}
  ${(ctx.da_sopralluogo || []).length ? `<h3>Da verificare al primo sopralluogo</h3><ul class="m">${ctx.da_sopralluogo.map(x => `<li>${esc(x.titolo)}${x.verificato ? ' — verificato' : ''}${x.esito ? `: ${esc(x.esito)}` : ''}</li>`).join('')}</ul>` : ''}
  ${ctx.note ? `<p>${nl(ctx.note)}</p>` : ''}`;

  // ── 4 Organizzazione ──
  const org = p.organizzazione || {};
  const orgRows = ORGANIZZAZIONE.map(o => ({ o, v: org[o.key] })).filter(x => x.v && x.v.attivo !== false && x.v.testo && ok(x.v));
  const orgExtra = Object.entries(org).filter(([k, v]) => !ORGANIZZAZIONE.some(o => o.key === k) && v && v.attivo !== false && v.testo && ok(v));
  out += `<h2 class="sec"><span class="n">4</span>Organizzazione del cantiere</h2>
  ${orgRows.map(({ o, v }) => `<h3>${esc(o.titolo)}</h3><p>${nl(v.testo)}</p>`).join('')}
  ${orgExtra.map(([, v]) => `<h3>${esc(v.titolo || 'Altro')}</h3><p>${nl(v.testo)}</p>`).join('')}
  ${snap.layoutDataUri ? `<h3>Layout di cantiere</h3><img class="layout-img" src="${snap.layoutDataUri}" alt="Layout di cantiere">` : p.layout_name ? `<h3>Layout di cantiere</h3><p>Allegato: ${esc(p.layout_name)}</p>` : ''}`;

  // ── 5 Lavorazioni ──
  out += `<h2 class="sec newpage"><span class="n">5</span>Lavorazioni: rischi e misure di prevenzione</h2>
  <p class="small muted">Valutazione dei rischi: R = P × D (probabilità × danno, da 1 a 4). Livello: basso 1–3, medio 4–7, alto 8–11, molto alto 12–16.</p>`;
  for (const l of lav) {
    const imp = l.impresa_id ? impById.get(l.impresa_id) : null;
    const misure = (l.misure || []).filter(m => m.approvata);
    out += `<div class="lav"><div class="lav-head"><b>${esc(l.nome)}</b><span class="small muted">${l.start_date ? `${d(l.start_date)} – ${d(l.end_date)}` : ''}${imp ? ` · ${esc(imp.ragione_sociale)}` : ''}${l.area ? ` · ${esc(l.area)}` : ''}</span></div>
    ${l.descrizione ? `<p style="margin-top:2mm">${nl(l.descrizione)}</p>` : ''}
    ${(l.fasi || []).length ? `<p class="small"><b>Fasi:</b> ${esc(l.fasi.join('; '))}.</p>` : ''}
    ${(l.rischi || []).length ? `<table><thead><tr><th>Rischio</th><th class="r" style="width:9mm">P</th><th class="r" style="width:9mm">D</th><th class="r" style="width:9mm">R</th><th style="width:24mm">Livello</th></tr></thead><tbody>${l.rischi.map(r => `<tr><td>${esc(r.testo)}</td><td class="r">${r.p ?? ''}</td><td class="r">${r.d ?? ''}</td><td class="r"><b>${r.r ?? ''}</b></td><td><span class="lv ${esc(String(r.livello || '').toLowerCase().replace(/\s+/g, '-'))}">${esc(r.livello || '')}</span></td></tr>`).join('')}</tbody></table>` : ''}
    ${misure.length ? `<p style="margin-bottom:1mm"><b>Misure di prevenzione e protezione</b></p><ul class="m">${misure.map(m => `<li>${nl(m.testo)}</li>`).join('')}</ul>` : ''}
    ${(l.dpi || []).length ? `<p class="small"><b>DPI:</b> ${esc(l.dpi.join('; '))}.</p>` : ''}
    ${(l.apprestamenti || []).length ? `<p class="small"><b>Apprestamenti e attrezzature:</b> ${esc(l.apprestamenti.map(a => (a.verifica ? `${a.nome} (${a.verifica})` : a.nome)).join('; '))}.</p>` : ''}
    </div>`;
  }

  // ── 6 Interferenze ──
  const dec = snap.decisioni || [];
  const SOL = { temporale: 'Sfasamento temporale', spaziale: 'Sfasamento spaziale', misure: 'Misure di coordinamento' };
  out += `<h2 class="sec"><span class="n">6</span>Interferenze e prescrizioni operative</h2>
  ${dec.length ? `<table><thead><tr><th style="width:50mm">Lavorazioni</th><th style="width:40mm">Rischio</th><th>Prescrizione</th></tr></thead><tbody>${dec.map(x => {
    const a = lavById.get(x.lav_a), b = lavById.get(x.lav_b);
    return `<tr><td><b>${esc(a ? a.nome : '')}</b><br>× <b>${esc(b ? b.nome : '')}</b></td><td>${esc(x.rischio || '')}</td><td><b>${SOL[x.soluzione]}.</b> ${nl(x.testo)}</td></tr>`;
  }).join('')}</tbody></table>` : '<p>Dal cronoprogramma non risultano lavorazioni di imprese diverse sovrapposte nello stesso tempo e nella stessa area. Ogni variazione del cronoprogramma che crei una sovrapposizione va comunicata al CSE prima dell\'esecuzione.</p>'}`;

  // ── 7 Uso comune ──
  const uso = (p.uso_comune || []).filter(u => u.testo && ok(u));
  out += `<h2 class="sec"><span class="n">7</span>Uso comune di apprestamenti, attrezzature e servizi</h2>
  ${uso.length ? uso.map(u => `<h3>${esc(u.titolo)}</h3><p>${nl(u.testo)}${u.impresa_id && impById.get(u.impresa_id) ? ` <span class="muted">Responsabile: ${esc(impById.get(u.impresa_id).ragione_sociale)}.</span>` : ''}</p>`).join('') : '<p>—</p>'}`;

  // ── 8 Coordinamento ──
  const coord = ok(p.coordinamento || {}) ? (p.coordinamento || {}) : {};
  out += `<h2 class="sec"><span class="n">8</span>Cooperazione, coordinamento e informazione</h2>
  ${coord.riunioni ? `<h3>Riunioni di coordinamento</h3><p>${nl(coord.riunioni)}</p>` : ''}
  ${coord.informazione ? `<h3>Reciproca informazione</h3><p>${nl(coord.informazione)}</p>` : ''}
  ${p.testi && p.testi.orari ? `<h3>Orari di lavoro</h3><p>${nl(p.testi.orari)}</p>` : ''}`;

  // ── 9 Cronoprogramma ──
  out += `<h2 class="sec newpage"><span class="n">9</span>Cronoprogramma dei lavori</h2>${gantt(lav, impById, color, p)}
  <p class="small">Entità presunta del cantiere: <b>${Math.round(ug)} uomini-giorno</b>${lav.some(l => l.uomini_giorno) ? ' (somma delle stime per lavorazione)' : ''}.</p>`;

  // ── 10 Costi ──
  const costi = [...(snap.costi || [])].sort((a, b) => a.categoria.localeCompare(b.categoria) || a.ordine - b.ordine);
  out += `<h2 class="sec newpage"><span class="n">10</span>Costi della sicurezza</h2>
  <p class="small muted">Stima analitica per voci singole (Allegato XV, punto 4). I costi della sicurezza non sono soggetti a ribasso d'asta.</p>`;
  for (const [cat, titolo] of Object.entries(CATEGORIE_COSTI)) {
    const rows = costi.filter(c => c.categoria === cat);
    if (!rows.length) continue;
    const tot = rows.reduce((s, c) => s + (Number(c.quantita) || 0) * (Number(c.prezzo) || 0), 0);
    out += `<h3>${cat}) ${esc(titolo)}</h3><table><thead><tr><th style="width:18mm">Codice</th><th>Descrizione</th><th style="width:17mm">U.M.</th><th class="r" style="width:16mm">Q.tà</th><th class="r" style="width:19mm">Prezzo €</th><th class="r" style="width:22mm">Importo €</th></tr></thead><tbody>
    ${rows.map(c => `<tr><td class="small">${esc(c.codice || '')}</td><td>${esc(c.descrizione)}${c.impresa_id && impById.get(c.impresa_id) ? `<br><span class="small muted">${esc(impById.get(c.impresa_id).ragione_sociale)}</span>` : ''}</td><td>${esc(c.um || '')}</td><td class="r">${num(c.quantita)}</td><td class="r">${eur(c.prezzo)}</td><td class="r">${eur((Number(c.quantita) || 0) * (Number(c.prezzo) || 0))}</td></tr>`).join('')}
    <tr class="tot"><td></td><td colspan="4">Totale ${cat})</td><td class="r">${eur(tot)}</td></tr></tbody></table>`;
  }
  out += `<table><tbody><tr class="tot"><td>Totale costi della sicurezza (non soggetti a ribasso)</td><td class="r" style="width:40mm">${eur(riep.totale)} €</td></tr></tbody></table>
  ${riep.perImpresa.some(x => x.importo > 0) ? `<h3>Ripartizione per impresa</h3><table><tbody>${riep.perImpresa.filter(x => x.importo > 0).map(x => `<tr><td>${esc(x.ragione_sociale)}</td><td class="r" style="width:40mm">${eur(x.importo)} €</td></tr>`).join('')}${riep.daRipartire > 0 ? `<tr><td class="muted">Da ripartire</td><td class="r">${eur(riep.daRipartire)} €</td></tr>` : ''}</tbody></table>` : ''}`;

  // ── 11 Emergenze ──
  const emAll = p.emergenze || {};
  const em = ok(emAll) ? emAll : { pronto_soccorso: emAll.pronto_soccorso, numeri: emAll.numeri, punto_raccolta: emAll.punto_raccolta };
  const ps = em.pronto_soccorso || {};
  out += `<h2 class="sec"><span class="n">11</span>Gestione delle emergenze</h2>
  ${em.gestione ? `<h3>Organizzazione</h3><p>${nl(em.gestione)}</p>` : ''}
  ${em.procedura ? `<h3>Procedura in caso di infortunio o incendio</h3><p>${nl(em.procedura)}</p>` : ''}
  ${em.punto_raccolta ? `<h3>Punto di raccolta</h3><p>${nl(em.punto_raccolta)}</p>` : ''}
  <h3>Numeri utili</h3><table><tbody>
   <tr><td style="width:70mm">Numero unico di emergenza (ambulanza, Vigili del Fuoco, Carabinieri, Polizia)</td><td><b>112</b></td></tr>
   ${ps.nome ? `<tr><td>Pronto soccorso più vicino</td><td><b>${esc(ps.nome)}</b>${ps.indirizzo ? `, ${esc(ps.indirizzo)}` : ''}${ps.distanza_km ? ` · circa ${String(ps.distanza_km).replace('.', ',')} km, ${ps.minuti} minuti` : ''}</td></tr>` : ''}
   ${(em.numeri || []).filter(n => n.nome && n.numero).map(n => `<tr><td>${esc(n.nome)}</td><td><b>${esc(n.numero)}</b></td></tr>`).join('')}
   ${cse && p.soggetti.cse.telefono ? `<tr><td>Coordinatore per l'esecuzione</td><td><b>${esc(p.soggetti.cse.telefono)}</b> (${esc(cse)})</td></tr>` : ''}
  </tbody></table>`;

  // ── 12 Procedure ──
  const proc = (p.procedure || []).filter(x => x.testo);
  out += `<h2 class="sec"><span class="n">12</span>Procedure complementari e di dettaglio</h2>
  ${proc.length ? proc.map(x => `<h3>${esc(x.titolo || 'Procedura')}</h3><p>${nl(x.testo)}</p>`).join('') : '<p>Le imprese esecutrici riportano nel proprio POS le procedure complementari e di dettaglio relative alle proprie lavorazioni, coerenti con le misure di questo piano.</p>'}`;

  // ── Firme ──
  out += `<div class="sign"><div><b>Il coordinatore per la sicurezza</b><br><span class="muted">${esc(cse)}</span><div class="line"></div><span class="small muted">Luogo e data ____________________</span></div>
  <div><b>Per presa visione e accettazione</b><br><span class="muted">Il committente / responsabile dei lavori</span><div class="line"></div></div></div>
  ${imprese.length ? `<h3 style="margin-top:6mm">Accettazione delle imprese (art. 100, c. 5)</h3><table><thead><tr><th>Impresa</th><th style="width:60mm">Datore di lavoro (firma)</th><th style="width:28mm">Data</th></tr></thead><tbody>${imprese.map(i => `<tr><td>${esc(i.ragione_sociale)}</td><td style="height:11mm"></td><td></td></tr>`).join('')}</tbody></table>` : ''}`;

  if (perWord) out = out.replace(/class="cover"/, 'class="cover" style="height:auto"');
  return out;
}

function gantt(lav, impById, color, p) {
  const dated = lav.filter(l => l.start_date && l.end_date);
  if (!dated.length) return '<p class="muted">Cronoprogramma da completare.</p>';
  const start = [p.start_date, ...dated.map(l => l.start_date)].filter(Boolean).sort()[0];
  const end = [p.end_date, ...dated.map(l => l.end_date)].filter(Boolean).sort().reverse()[0];
  // settimane dal lunedì della prima data
  const s0 = new Date(`${start}T12:00:00Z`);
  s0.setUTCDate(s0.getUTCDate() - ((s0.getUTCDay() + 6) % 7));
  const weeks = [];
  for (let t = s0.getTime(); t <= Date.parse(`${end}T12:00:00Z`); t += 7 * 86400000) weeks.push(new Date(t).toISOString().slice(0, 10));
  const W = weeks.length;
  const head = weeks.map((w, i) => `<th style="padding:1mm 0;font-size:6.6pt;text-align:center">${i === 0 || w.slice(8) <= '07' ? new Date(`${w}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : Number(w.slice(8))}</th>`).join('');
  const rows = dated.map(l => {
    const c = l.impresa_id ? color.get(l.impresa_id) : '#9C948A';
    const cells = weeks.map((w) => {
      const wEnd = new Date(Date.parse(`${w}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
      const on = l.start_date <= wEnd && l.end_date >= w;
      return `<td>${on ? `<div class="bar" style="background:${c}"></div>` : ''}</td>`;
    }).join('');
    const imp = l.impresa_id ? impById.get(l.impresa_id) : null;
    return `<tr><td class="l"><b>${esc(l.nome)}</b><br><span class="muted" style="font-size:7pt">${imp ? esc(imp.ragione_sociale) : ''} ${d(l.start_date)}–${d(l.end_date)}</span></td>${cells}</tr>`;
  }).join('');
  const colW = Math.max(3, Math.floor((178 - 60) / W * 10) / 10);
  return `<table class="gantt"><colgroup><col style="width:60mm">${weeks.map(() => `<col style="width:${colW}mm">`).join('')}</colgroup><thead><tr><th>Lavorazione</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function pscHtml(snap, opts = {}) {
  return wrap(pscBody(snap, opts), `PSC ${snap.project.title}`);
}

/** Word: lo stesso contenuto in un involucro che Word apre come documento. */
function pscWord(snap) {
  const body = pscBody(snap, { perWord: true });
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>PSC ${esc(snap.project.title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page Section1 { size: 21cm 29.7cm; margin: 2.2cm 1.8cm 2cm 1.8cm; } div.Section1 { page: Section1; }
body { font-family: Arial, sans-serif; font-size: 10pt; } h1 { font-size: 20pt; } h2 { font-size: 14pt; color: #22384F; border-bottom: 1pt solid #22384F; } h3 { font-size: 11pt; }
table { border-collapse: collapse; width: 100%; } th { background: #EEF2F6; text-align: left; } td, th { border: 0.5pt solid #D9D3C9; padding: 3pt 5pt; vertical-align: top; }
.muted { color: #7A736A; } .small { font-size: 8.5pt; } .eyebrow { font-size: 8pt; font-weight: bold; color: #7A736A; } .idx em { float: right; }
.gantt .bar { background: #22384F; height: 6pt; }
</style></head><body><div class="Section1">${body}</div></body></html>`;
}

// ── Fascicolo dell'opera (Allegato XVI), bozza ────────────────────────────────
const MANUTENZIONI = [
  { re: /copertur|tetto|manto|lattoner|gronda/i, opera: 'Copertura', intervento: 'Pulizia di gronde e pluviali, controllo e sostituzione di elementi del manto', rischi: 'Caduta dall\'alto, scivolamento, caduta di materiali', misure: 'Dispositivi di ancoraggio permanenti (UNI EN 795) o linea vita sulla copertura; accesso sicuro alla copertura (botola o scala fissa); parapetti o ganci per i lavori sul bordo', },
  { re: /facciat|intonac|cappott|tinteggi|ponteg/i, opera: 'Facciate', intervento: 'Pulizia, ripristino di intonaci e tinteggiature, controllo degli elementi aggettanti', rischi: 'Caduta dall\'alto, caduta di materiali su terzi', misure: 'Ponteggio o piattaforma elevabile; ancoraggi in facciata per il futuro montaggio di ponteggi; delimitazione delle aree sottostanti' },
  { re: /elettric/i, opera: 'Impianto elettrico', intervento: 'Verifiche periodiche, sostituzione di componenti', rischi: 'Elettrocuzione', misure: 'Quadri accessibili e sezionabili, schemi aggiornati, lavori solo da personale PES/PAV' },
  { re: /idraul|idric|termic|riscald|gas/i, opera: 'Impianti idrici, termici e gas', intervento: 'Manutenzione ordinaria e straordinaria', rischi: 'Ustioni, fughe di gas, lavoro in spazi ristretti', misure: 'Valvole di intercettazione accessibili e segnalate, locali tecnici areati, documentazione degli impianti' },
  { re: /serrament|infiss|vetr/i, opera: 'Serramenti', intervento: 'Pulizia dei vetri, regolazione e sostituzione di ferramenta', rischi: 'Caduta dall\'alto per serramenti ai piani alti, tagli', misure: 'Serramenti apribili verso l\'interno o pulibili dall\'interno; ancoraggi dove necessario' },
  { re: /ascensor/i, opera: 'Ascensore', intervento: 'Manutenzione periodica', rischi: 'Caduta nel vano, schiacciamento', misure: 'Accesso al vano solo da ditta abilitata; locale macchine protetto' },
];

function fascicoloHtml(snap) {
  const p = snap.project;
  const lav = snap.lavorazioni || [];
  const testo = lav.map(l => `${l.nome} ${l.scheda_id || ''}`).join(' | ');
  const schede = MANUTENZIONI.filter(m => m.re.test(testo));
  const body = `<h2 class="sec first">Fascicolo con le caratteristiche dell'opera</h2>
  <p class="eyebrow">D.Lgs. 81/2008 · art. 91 c.1 b e Allegato XVI · BOZZA da completare a fine lavori</p>
  <h3>Capitolo I — Descrizione sintetica dell'opera e soggetti</h3>
  <table><tbody>
   <tr><td style="width:52mm" class="muted">Opera</td><td><b>${esc(p.title)}</b></td></tr>
   <tr><td class="muted">Indirizzo</td><td>${esc(luogo(p.address, p.comune))}</td></tr>
   <tr><td class="muted">Durata effettiva dei lavori</td><td>${d(p.start_date)} – ${d(p.end_date)} (da aggiornare a fine lavori)</td></tr>
   ${sogg(p)}
  </tbody></table>
  ${p.descrizione ? `<p>${nl(p.descrizione)}</p>` : ''}
  <h3>Capitolo II — Misure preventive e protettive per i lavori successivi sull'opera</h3>
  <p class="small muted">Schede proposte dalle lavorazioni del PSC: vanno confermate con quanto effettivamente realizzato (dispositivi installati, accessi, documentazione).</p>
  ${schede.length ? `<table><thead><tr><th style="width:28mm">Parte dell'opera</th><th style="width:40mm">Intervento</th><th style="width:36mm">Rischi</th><th>Misure in dotazione dell'opera / ausiliarie</th></tr></thead><tbody>${schede.map(s => `<tr><td><b>${esc(s.opera)}</b></td><td>${esc(s.intervento)}</td><td>${esc(s.rischi)}</td><td>${esc(s.misure)}</td></tr>`).join('')}</tbody></table>` : '<p>—</p>'}
  <h3>Capitolo III — Riferimenti alla documentazione di supporto</h3>
  <table><thead><tr><th>Documento</th><th style="width:44mm">Redatto da</th><th style="width:30mm">Data</th><th style="width:36mm">Collocazione</th></tr></thead><tbody>
   ${['Elaborati architettonici as built', 'Elaborati strutturali e relazione di calcolo', 'Dichiarazioni di conformità degli impianti (D.M. 37/2008)', 'Certificazioni dei dispositivi di ancoraggio e delle linee vita', 'Manuali d\'uso e manutenzione dei componenti installati'].map(t => `<tr><td>${esc(t)}</td><td></td><td></td><td></td></tr>`).join('')}
  </tbody></table>`;
  return wrap(body, `Fascicolo ${p.title}`);
}

// ── Notifica preliminare (art. 99, Allegato XII) ─────────────────────────────
function maxLavoratori(lav) {
  const days = new Map();
  for (const l of lav) {
    if (!l.start_date || !l.end_date) continue;
    for (let t = Date.parse(`${l.start_date}T12:00:00Z`); t <= Date.parse(`${l.end_date}T12:00:00Z`); t += 86400000) {
      const k = new Date(t).toISOString().slice(0, 10);
      days.set(k, (days.get(k) || 0) + (Number(l.addetti) || 0));
    }
  }
  return days.size ? Math.max(...days.values()) : null;
}

function notificaDati(snap) {
  const p = snap.project;
  const s = p.soggetti || {};
  const lav = snap.lavorazioni || [];
  const imprese = snap.imprese || [];
  const durata = p.start_date && p.end_date ? Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1 : null;
  const nome = (o) => (o && o.nome ? `${o.nome}${o.indirizzo ? `, ${o.indirizzo}` : ''}` : '');
  return [
    ['1', 'Data della comunicazione', ''],
    ['2', 'Indirizzo del cantiere', luogo(p.address, p.comune) + (p.provincia && p.provincia.length <= 3 ? ` (${p.provincia})` : '')],
    ['3', 'Committente', nome(s.committente)],
    ['4', 'Natura dell\'opera', p.tipo_opera || p.descrizione || ''],
    ['5', 'Responsabile dei lavori', nome(s.responsabile_lavori)],
    ['6', 'Coordinatore per la progettazione', nome(s.csp)],
    ['7', 'Coordinatore per l\'esecuzione', nome(s.cse)],
    ['8', 'Data presunta d\'inizio dei lavori', p.start_date ? d(p.start_date) : ''],
    ['9', 'Durata presunta dei lavori', durata ? `${durata} giorni naturali` : ''],
    ['10', 'Numero massimo presunto dei lavoratori in cantiere', String(maxLavoratori(lav) || '')],
    ['11', 'Numero previsto di imprese e lavoratori autonomi', imprese.length ? String(imprese.length) : ''],
    ['12', 'Imprese già selezionate', imprese.map(i => `${i.ragione_sociale}${i.piva ? ` (P.IVA ${i.piva})` : ''}`).join('; ')],
    ['13', 'Ammontare complessivo presunto dei lavori', p.importo_lavori ? `${eur(p.importo_lavori)} €` : ''],
  ];
}

function notificaHtml(snap) {
  const rows = notificaDati(snap);
  const body = `<h2 class="sec first">Dati per la notifica preliminare</h2>
  <p class="eyebrow">D.Lgs. 81/2008 · art. 99 e Allegato XII</p>
  <p class="small muted">La notifica è a cura del committente o del responsabile dei lavori, prima dell'inizio dei lavori, all'ASL e alla Direzione territoriale del lavoro competenti (in molte regioni con il servizio online). Questi sono i dati già presenti nel PSC.</p>
  <table><tbody>${rows.map(([n, k, v]) => `<tr><td style="width:8mm"><b>${n}</b></td><td style="width:70mm" class="muted">${esc(k)}</td><td><b>${esc(v || '—')}</b></td></tr>`).join('')}</tbody></table>`;
  return wrap(body, `Notifica preliminare ${snap.project.title}`);
}

// ── Verbale ───────────────────────────────────────────────────────────────────
function verbaleHtml({ project, verbale, nc = [], imprese = [], photos = {}, signatureDataUri = null, presenze = null }) {
  const impById = new Map(imprese.map(i => [i.id, i]));
  const ESITO = { ok: 'Regolare', no: 'Non conforme', na: 'Non applicabile' };
  const tipo = verbale.tipo === 'riunione' ? 'Verbale di riunione di coordinamento' : 'Verbale di sopralluogo';
  const when = new Date(verbale.data).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  const body = `<h2 class="sec first">${tipo} n. ${verbale.numero}</h2>
  <table><tbody>
   <tr><td style="width:48mm" class="muted">Cantiere</td><td><b>${esc(project.title)}</b>, ${esc(luogo(project.address, project.comune))}</td></tr>
   <tr><td class="muted">Data e ora</td><td>${esc(when)}</td></tr>
   <tr><td class="muted">Coordinatore</td><td>${esc((project.soggetti && project.soggetti.cse && project.soggetti.cse.nome) || verbale.signed_name || '')}</td></tr>
   ${presenze ? `<tr><td class="muted">In cantiere (dalle timbrature)</td><td>${presenze.totale} persone${presenze.perImpresa && presenze.perImpresa.length ? ` · ${esc(presenze.perImpresa.map(x => `${x.ragione_sociale} ${x.n}`).join(', '))}` : ''}</td></tr>` : ''}
  </tbody></table>
  ${(verbale.presenti || []).filter(x => x.presente !== false && (x.nome || x.ruolo)).length ? `<h3>Presenti</h3><table><thead><tr><th>Nome</th><th>Impresa / ruolo</th></tr></thead><tbody>${verbale.presenti.filter(x => x.presente !== false && (x.nome || x.ruolo)).map(x => `<tr><td>${esc(x.nome)}</td><td>${esc(x.ruolo || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${(verbale.checklist || []).length ? `<h3>Controlli</h3><table><thead><tr><th>Voce</th><th style="width:34mm">Esito</th><th>Note</th></tr></thead><tbody>${verbale.checklist.map(c => `<tr><td>${esc(c.titolo)}</td><td><b>${ESITO[c.esito] || '—'}</b></td><td>${esc(c.nota || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${nc.length ? `<h3>Non conformità</h3>${nc.map((n, i) => `<div style="break-inside:avoid;margin-bottom:3mm;padding:2.5mm 3mm;border:0.6pt solid ${n.sospensione ? '#A8453B' : '#ECE7DF'};border-radius:1.5mm">
    <b>${i + 1}. ${esc(n.descrizione)}</b><br><span class="small">Impresa: <b>${esc(n.impresa_id && impById.get(n.impresa_id) ? impById.get(n.impresa_id).ragione_sociale : '—')}</b> · gravità ${esc(n.gravita)}${n.scadenza ? ` · da risolvere entro il ${d(n.scadenza)}` : ' · da risolvere subito'}</span>
    ${n.sospensione ? '<br><b style="color:#A8453B">Sospensione della lavorazione interessata fino alla risoluzione (art. 92, c. 1 f).</b>' : ''}
    ${(n.photo_paths || []).map(pth => photos[pth] ? `<img class="photo" src="${photos[pth]}" style="margin-top:2mm;display:inline-block">` : '').join(' ')}
  </div>`).join('')}` : ''}
  ${verbale.osservazioni ? `<h3>Osservazioni e disposizioni</h3><p>${nl(verbale.osservazioni)}</p>` : ''}
  <div class="sign"><div><b>Il coordinatore per l'esecuzione</b><br>${signatureDataUri ? `<img src="${signatureDataUri}" style="height:20mm;margin-top:2mm">` : '<div class="line"></div>'}<span class="small">${esc(verbale.signed_name || '')}${verbale.signed_at ? ` · firmato il ${esc(new Date(verbale.signed_at).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}</span></div>
  <div><b>Per presa visione</b><br><span class="muted small">Imprese presenti</span><div class="line"></div></div></div>`;
  return wrap(body, `${tipo} ${verbale.numero}`);
}

module.exports = { luogo, pscHtml, pscWord, pscBody, fascicoloHtml, notificaHtml, notificaDati, verbaleHtml, maxLavoratori, SEZIONI, PALETTE };
