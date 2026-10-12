'use strict';
/**
 * lib/posSezione5.js — F-261 (AUDIT.md del frontend), passo 4; F-350.
 *
 * Sezione 5 del POS ("Lavorazioni, rischi e misure") composta dalle schede
 * lavorazione (lib/lavorazioniSchede.js) invece che scritta dall'AI a ogni
 * POS. Stesso formato markdown che pos-html-generator.js sa già rendere
 * (### per blocco, tabelle con R colorato, elenchi).
 *
 * F-350: le schede nel formato nuovo (s.v2) portano rumore, vibrazioni e
 * sostanze. In testa alla sezione: esposizione al rumore per gruppo omogeneo
 * (L_EX,8h dai dati CPT) e vibrazioni per attrezzo e per gruppo (A(8) da
 * ISPESL e CPT Torino), calcolate qui e salvate con il POS: un POS firmato
 * non cambia se la libreria cambia. Poi una scheda breve per lavorazione,
 * con ogni rischio accanto alle sue misure e il rischio residuo.
 *
 * Se il POS non porta `selectedSchede` (vecchio generatore /pos/nuovo, Ladia)
 * restituisce null e il chiamante usa il percorso AI di prima.
 */
const S = require('./lavorazioniSchede');
const F = require('./schedeFonti');
const { AGENTI, SEGNALI } = require('./schedeV2/cataloghi');

// Una cella di tabella markdown non può contenere "|" né andare a capo.
const cell = (t) => String(t).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
const n1 = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const n2 = (x) => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');
const durata = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`);

// ── Scheda nel formato di prima ─────────────────────────────────────────────
function schedaMarkdown(s) {
  if (s.v2) return schedaV2Markdown(s);
  const out = [];
  out.push(`### ${s.nome}`);
  out.push('');
  out.push(`**Descrizione tecnica:** ${s.descrizione}`);
  out.push('');
  out.push('**Fasi operative:**');
  for (const f of s.fasi) out.push(`- ${f}`);
  out.push('');
  out.push('**Rischi identificati e valutazione (matrice P x D):**');
  out.push('');
  out.push('| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |');
  out.push('|---------|---------|---------|---------|---------|');
  for (const r of S.rischiValutati(s)) out.push(`| ${cell(r.rischio)} | ${r.p} | ${r.d} | ${r.r} | ${r.livello} |`);
  out.push('');
  out.push('Legenda: P = probabilità (1 improbabile, 4 molto probabile); D = danno (1 lieve, 4 molto grave); R = P×D (1-3 basso, 4-7 medio, 8-11 alto, 12-16 molto alto).');
  out.push('');
  out.push('**Misure di prevenzione e protezione:**');
  for (const m of s.misure) out.push(`- ${m}`);
  out.push('');
  out.push('**DPI obbligatori:**');
  out.push('');
  out.push('| DPI | Norma |');
  out.push('|-----|-------|');
  for (const d of s.dpi) out.push(`| ${cell(S.DPI[d].nome)} | ${cell(S.DPI[d].norma)} |`);
  out.push('');
  out.push('**Attrezzature e verifiche:**');
  out.push('');
  out.push('| Attrezzatura | Verifica richiesta |');
  out.push('|--------------|--------------------|');
  for (const [nome, verifica] of s.attrezzature) out.push(`| ${cell(nome)} | ${cell(verifica)} |`);
  out.push('');
  out.push('**Formazione e abilitazioni richieste:**');
  for (const f of s.formazione) out.push(`- ${S.FORMAZIONE[f]}`);
  out.push('');
  out.push(`**Riferimenti normativi:** ${s.norme.join('; ')}.`);
  return out.join('\n');
}

// ── Scheda nel formato nuovo (F-350) ────────────────────────────────────────
const attivitaRumore = (nome) => {
  for (const g of F.RUMORE_GRUPPI) { const a = g.attivita.find(x => x[0] === nome); if (a) return { nome, laeq: a[1], picco: a[3] }; }
  return null;
};

function schedaV2Markdown(s) {
  const out = [];
  out.push(`### ${s.nome}`);
  out.push('');
  out.push(`**Descrizione:** ${s.descrizione}`);
  out.push('');
  out.push(`**Chi la svolge:** ${s.mansioni.join(' · ')}.`);
  out.push('');
  out.push(`**Fasi operative:** ${s.fasi.map((f, i) => `(${i + 1}) ${f}`).join(' ')}`);
  out.push('');
  out.push('**Valutazione dei rischi e misure:**');
  out.push('');
  out.push('| Rischio | P | D | R | Misure di prevenzione e protezione | R res. |');
  out.push('|---|---|---|---|---|---|');
  for (const v of s.valutazione) {
    out.push(`| ${cell(v.r)} | ${v.p} | ${v.d} | ${v.p * v.d} | ${cell(v.m.join(' · '))} | ${v.pr * v.dr} |`);
  }
  out.push('');
  out.push('P = probabilità, D = danno (da 1 a 4); R = P × D: 1–3 basso, 4–7 medio, 8–11 alto, 12–16 molto alto. R res. = rischio residuo, con le misure attuate.');
  out.push('');
  out.push(`**Attrezzature e verifiche:** ${s.attrezzature.map(([n, v]) => `**${n}**: ${v}`).join(' · ')}`);
  out.push('');
  const rum = (s.rumore?.attivita || []).map(attivitaRumore).filter(Boolean);
  const vib = (s.vibrazioni?.attrezzi || []).map(F.attrezzoVib).filter(Boolean);
  if (rum.length || vib.length) {
    const parti = [
      ...rum.map(a => `${a.nome}: LAeq ${n1(a.laeq)} dB(A)${a.picco ? `, picco ${n1(a.picco)} dB(C)` : ''}`),
      ...vib.map(a => `${a.nome}: a_hv ${n1(a.a)} m/s², uso effettivo massimo ${durata(F.minutiFino(5, a.a))} al giorno`),
    ];
    out.push(`**Rumore e vibrazioni:** ${parti.join(' · ')}. Esposizione dei lavoratori in 5.1 e 5.2.`);
    out.push('');
  }
  if (s.sostanze?.length) {
    out.push(`**Agenti chimici:** ${s.sostanze.map(id => AGENTI[id].nome).join(' · ')} (pericoli e cautele nella Sezione 10).`);
    out.push('');
  }
  if (s.mmc) { out.push(`**Movimentazione dei carichi:** ${s.mmc}`); out.push(''); }
  out.push(`**DPI:** ${s.dpi.map(d => `${S.DPI[d].nome} (${S.DPI[d].norma})`).join(' · ')}`);
  out.push('');
  out.push(`**Segnaletica:** ${s.segnaletica.map(c => `${c} ${SEGNALI[c][0]}`).join(' · ')}`);
  out.push('');
  out.push(`**Formazione e abilitazioni:** ${s.formazione.map(f => S.FORMAZIONE[f]).join(' · ')}`);
  out.push('');
  out.push('**Controlli del preposto:**');
  out.push(`- Prima di iniziare: ${s.checklist.prima.join('; ')}.`);
  out.push(`- Durante: ${s.checklist.durante.join('; ')}.`);
  out.push(`- A fine lavoro: ${s.checklist.dopo.join('; ')}.`);
  out.push('');
  out.push('**Emergenze specifiche:**');
  for (const e of s.emergenze) out.push(`- ${e}`);
  out.push('');
  out.push(`**Riferimenti normativi:** ${s.norme.join('; ')}.`);
  return out.join('\n');
}

// ── Esposizioni calcolate (F-350) ───────────────────────────────────────────
/**
 * Gruppi omogenei del rumore toccati dalle schede. Lo stesso mestiere in più
 * contesti (nuove costruzioni, ristrutturazioni, manutenzioni) → si tiene la
 * tabella con L_EX più alto: senza sapere il contesto, la scelta prudente.
 */
function gruppiRumore(schede) {
  const perNome = new Map();
  for (const s of schede) for (const id of s.rumore?.gruppi || []) {
    const g = F.gruppoRumore(id);
    if (!g) continue;
    const l = F.lex(g.attivita);
    const prima = perNome.get(g.nome);
    if (!prima || l > prima.lex) perNome.set(g.nome, { g, lex: l });
  }
  return [...perNome.values()].sort((a, b) => b.lex - a.lex);
}

function esposizioniMarkdown(schede) {
  const v2 = schede.filter(s => s.v2);
  if (!v2.length) return null;
  const out = [];
  const rum = gruppiRumore(v2);
  if (rum.length) {
    out.push('### 5.1 Esposizione al rumore per gruppo omogeneo');
    out.push('');
    out.push('Valutazione per gruppi omogenei con dati di letteratura (art. 190 c. 5-bis D.Lgs. 81/08): attività e percentuali di tempo della settimana di presumibile maggiore esposizione. LEX,8h = 10·log Σ (p/100)·10^(LAeq/10).');
    out.push('');
    out.push('| Gruppo omogeneo | Attività principali (% del tempo · LAeq dB(A)) | LEX,8h dB(A) | Fascia | Obblighi |');
    out.push('|---|---|---|---|---|');
    for (const { g, lex } of rum) {
      const princ = g.attivita.filter(a => a[2] > 0 && !/^Pause/.test(a[0])).sort((a, b) => b[2] - a[2]).slice(0, 4);
      const f = F.fasciaRumore(lex);
      out.push(`| ${cell(g.nome)} | ${cell(princ.map(a => `${a[0]} (${a[2]}% · ${n1(a[1])})`).join('; '))} | **${n1(lex)}** | ${f.fascia} | ${cell(f.breve)} |`);
    }
    out.push('');
    out.push(`Fonte: ${F.FONTI.rumore}. Obblighi: artt. 192–196 D.Lgs. 81/08. I valori si sostituiscono con quelli misurati dall'impresa quando disponibili; gli otoprotettori si scelgono con il metodo della UNI EN 458 per portare il livello all'orecchio tra 75 e 80 dB(A).`);
    out.push('');
  }
  const attrezzi = [...new Set(v2.flatMap(s => s.vibrazioni?.attrezzi || []))].map(F.attrezzoVib).filter(Boolean);
  if (attrezzi.length) {
    out.push('### 5.2 Vibrazioni mano-braccio');
    out.push('');
    out.push('Valore d\'azione giornaliero 2,5 m/s², valore limite 5 m/s² (art. 201). A(8) = √[Σ a_hv²·t / 8 h], con t = tempo di uso effettivo dell\'attrezzo.');
    out.push('');
    out.push('| Attrezzo | a_hv m/s² (media ± dev. std.) | Uso effettivo fino al valore d\'azione | Uso effettivo massimo al giorno |');
    out.push('|---|---|---|---|');
    for (const a of attrezzi) out.push(`| ${cell(a.nome)} | ${n1(a.a)} ± ${n1(a.sd)} | ${durata(F.minutiFino(2.5, a.a))} | **${durata(F.minutiFino(5, a.a))}** |`);
    out.push('');
    const gruppi = [...new Set(v2.flatMap(s => s.vibrazioni?.gruppi || []))].map(id => F.VIB_GRUPPI.find(x => x.id === id)).filter(Boolean);
    if (gruppi.length) {
      out.push('| Gruppo omogeneo | Contesto | Attrezzi e % del tempo di lavoro | A(8) m/s² | Esito |');
      out.push('|---|---|---|---|---|');
      const CONTESTO = { nuove: 'Nuove costruzioni', ristrutturazioni: 'Ristrutturazioni', manutenzioni: 'Manutenzioni', demolizioni: 'Demolizioni manuali', stradali: 'Lavori stradali', altro: 'Opere d\'arte' };
      for (const g of gruppi) for (const [ctx, usi] of Object.entries(g.uso)) {
        const conA = usi.map(([id, pct]) => ({ ...F.attrezzoVib(id), pct }));
        const v = F.a8(conA);
        const e = F.esitoVibrazioni(v);
        out.push(`| ${cell(g.nome)} | ${CONTESTO[ctx] || ctx} | ${cell(conA.map(x => `${x.nome} ${x.pct}%`).join('; '))} | **${n2(v)}** | ${e.esito} |`);
      }
      out.push('');
    }
    out.push(`Fonti: ${F.FONTI.vibAttrezzi}; ${F.FONTI.vibGruppi}. Con il valore dichiarato nel libretto dell'attrezzo dell'impresa (art. 202 c. 2) i tempi si ricalcolano. Oltre il valore d'azione: programma di riduzione, informazione e formazione (art. 203), sorveglianza sanitaria (art. 204). Oltre il limite: misure immediate per riportare l'esposizione sotto 5 m/s² (art. 203 c. 2).`);
    out.push('');
  }
  return out.length ? out.join('\n') : null;
}

/**
 * @param {unknown} selectedSchede  id delle schede scelte in /pos/crea
 * @returns {{ markdown: string, schede: string[], sconosciute: string[] } | null}
 */
function composeSezione5(selectedSchede) {
  if (!Array.isArray(selectedSchede) || selectedSchede.length === 0) return null;
  const visti = new Set();
  const schede = [];
  const sconosciute = [];
  for (const raw of selectedSchede) {
    const id = String(raw);
    if (visti.has(id)) continue;
    visti.add(id);
    const s = S.getScheda(id);
    if (s) schede.push(s); else sconosciute.push(id);
  }
  if (!schede.length) return null;
  const esposizioni = esposizioniMarkdown(schede);
  return {
    markdown: [esposizioni, ...schede.map(schedaMarkdown)].filter(Boolean).join('\n\n---\n\n'),
    schede: schede.map(s => s.id),
    sconosciute,
  };
}

module.exports = { composeSezione5, schedaMarkdown, esposizioniMarkdown, gruppiRumore };
