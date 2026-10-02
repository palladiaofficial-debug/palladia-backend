'use strict';
/**
 * lib/posSezione5.js — F-261 (AUDIT.md del frontend), passo 4.
 *
 * Sezione 5 del POS ("Lavorazioni, rischi e misure") composta dalle schede
 * lavorazione (lib/lavorazioniSchede.js) invece che scritta dall'AI a ogni
 * POS. Stesso formato markdown che pos-html-generator.js sa già rendere
 * (### per lavorazione, tabelle con P/D/R/Livello, elenchi): il PDF non cambia
 * aspetto, cambia solo che il contenuto è sempre lo stesso per la stessa
 * lavorazione, e che non serve una chiamata AI.
 *
 * Se il POS non porta `selectedSchede` (vecchio generatore /pos/nuovo, Ladia)
 * restituisce null e il chiamante usa il percorso AI di prima.
 */
const S = require('./lavorazioniSchede');

// Una cella di tabella markdown non può contenere "|" né andare a capo.
const cell = (t) => String(t).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();

function schedaMarkdown(s) {
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
  return {
    markdown: schede.map(schedaMarkdown).join('\n\n---\n\n'),
    schede: schede.map(s => s.id),
    sconosciute,
  };
}

module.exports = { composeSezione5, schedaMarkdown };
