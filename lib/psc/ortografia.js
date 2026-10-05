'use strict';
/**
 * lib/psc/ortografia.js — F-297 (AUDIT.md del frontend). "Controlla
 * l'ortografia" del PSC: raccoglie i testi che finiscono nel documento, chiede
 * al modello SOLO gli errori certi (battitura, ortografia, accordi) e li
 * restituisce come sostituzioni puntuali "parola sbagliata → parola giusta",
 * che il coordinatore applica una per una o tutte insieme. Il modello non
 * riscrive mai una frase: ogni correzione si applica solo se il testo sbagliato
 * c'è davvero, esattamente, nel campo indicato.
 */

const MAX_CHARS = 60_000;

const set = (o, k, v) => ({ ...(o || {}), [k]: v });

/**
 * I testi del PSC con un riferimento stabile al campo da cui vengono.
 * @param {{project, lavorazioni, decisioni}} all
 * @returns {Array<{ref: string, dove: string, testo: string}>}
 */
function testiDa(all) {
  const p = all.project || {};
  const out = [];
  const add = (ref, dove, testo) => { if (typeof testo === 'string' && testo.trim().length >= 3) out.push({ ref, dove, testo }); };
  add('p:descrizione', 'Opera: descrizione', p.descrizione);
  add('p:tipo_opera', 'Opera: tipo di opera', p.tipo_opera);
  for (const [k, v] of Object.entries(p.testi || {})) add(`p:testi:${k}`, 'Testi del PSC', v);
  for (const [k, v] of Object.entries(p.organizzazione || {})) if (v && v.attivo !== false) add(`p:org:${k}`, `Organizzazione: ${v.titolo || k}`, v.testo);
  if (p.contesto) add('p:ctx:note', 'Area di cantiere: note', p.contesto.note);
  for (const k of ['riunioni', 'informazione']) add(`p:coord:${k}`, 'Coordinamento', (p.coordinamento || {})[k]);
  for (const k of ['procedura', 'gestione', 'punto_raccolta']) add(`p:emerg:${k}`, 'Emergenze', (p.emergenze || {})[k]);
  (p.uso_comune || []).forEach((u, i) => add(`p:uso:${i}`, `Uso comune: ${u.titolo || ''}`, u.testo));
  (p.procedure || []).forEach((x, i) => { add(`p:proc:${i}:titolo`, 'Procedure', x.titolo); add(`p:proc:${i}:testo`, `Procedura: ${x.titolo || ''}`, x.testo); });
  for (const l of all.lavorazioni || []) {
    add(`l:${l.id}:nome`, 'Lavorazione', l.nome);
    add(`l:${l.id}:descrizione`, `${l.nome}: descrizione`, l.descrizione);
    for (const m of l.misure || []) add(`l:${l.id}:m:${m.id}`, `${l.nome}: misura`, m.testo);
    for (const r of l.rischi || []) add(`l:${l.id}:r:${r.id}`, `${l.nome}: rischio`, r.testo);
    (l.fasi || []).forEach((f, i) => add(`l:${l.id}:f:${i}`, `${l.nome}: fase`, f));
  }
  for (const d of all.decisioni || []) add(`d:${d.id}`, 'Interferenza', d.testo);
  return out;
}

const TOOL = {
  name: 'correzioni',
  description: 'Gli errori certi di ortografia, battitura o accordo trovati nei testi.',
  input_schema: {
    type: 'object',
    properties: {
      correzioni: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'id del testo (t1, t2, …)' },
            sbagliato: { type: 'string', description: 'la parola o le poche parole sbagliate, copiate ESATTAMENTE come sono nel testo' },
            corretto: { type: 'string', description: 'la stessa porzione corretta' },
          },
          required: ['id', 'sbagliato', 'corretto'],
        },
      },
    },
    required: ['correzioni'],
  },
};

const SYSTEM = `Sei un correttore di bozze italiano per un Piano di Sicurezza e Coordinamento (cantieri edili).
Segnala SOLO errori certi: parole scritte male o con lettere invertite, accenti sbagliati (perchè → perché, pò → po'), apostrofi sbagliati (un'impianto → un impianto), doppie sbagliate, accordi evidenti di genere o numero.
NON segnalare: scelte di stile, punteggiatura facoltativa, maiuscole nei titoli, termini tecnici di cantiere (es. trabattello, sottoponte, mantovana, PiMUS, PLE, DPI, UNI EN 795), sigle, nomi propri, codici e riferimenti normativi, parole straniere d'uso.
"sbagliato" deve essere copiato carattere per carattere dal testo, il più corto possibile (la sola parola). Se non trovi errori certi, restituisci un elenco vuoto.`;

/**
 * Chiede le correzioni al modello. `chiama` è iniettabile (test): riceve
 * {system, content, tool} e restituisce {input}.
 */
async function controlla(testi, chiama) {
  const conId = testi.map((t, i) => ({ ...t, id: `t${i + 1}` }));
  const blocchi = [];
  let cur = [], n = 0;
  for (const t of conId) {
    if (n + t.testo.length > MAX_CHARS / 3 && cur.length) { blocchi.push(cur); cur = []; n = 0; }
    cur.push(t); n += t.testo.length;
    if (blocchi.length * (MAX_CHARS / 3) + n > MAX_CHARS) break;
  }
  if (cur.length) blocchi.push(cur);
  const byId = new Map(conId.map(t => [t.id, t]));
  const out = [];
  for (const b of blocchi) {
    const content = b.map(t => `[${t.id}] ${t.testo}`).join('\n\n');
    const r = await chiama({ system: SYSTEM, content, tool: TOOL });
    for (const c of (r && r.input && Array.isArray(r.input.correzioni) ? r.input.correzioni : [])) {
      const t = byId.get(String(c.id || ''));
      const sb = typeof c.sbagliato === 'string' ? c.sbagliato : '';
      const co = typeof c.corretto === 'string' ? c.corretto : '';
      // solo sostituzioni brevi, presenti davvero, e diverse
      if (!t || !sb || !co || sb === co || sb.length > 60 || co.length > 80 || !t.testo.includes(sb)) continue;
      const i = t.testo.indexOf(sb);
      const contesto = `${i > 40 ? '…' : ''}${t.testo.slice(Math.max(0, i - 40), i + sb.length + 40)}${i + sb.length + 40 < t.testo.length ? '…' : ''}`;
      if (out.some(x => x.ref === t.ref && x.sbagliato === sb)) continue;
      out.push({ ref: t.ref, dove: t.dove, sbagliato: sb, corretto: co, contesto });
    }
  }
  return out;
}

const sostituisci = (testo, sb, co) => (typeof testo === 'string' && testo.includes(sb) ? testo.replace(sb, co) : null);

/**
 * Applica le correzioni scelte. Restituisce le modifiche da salvare:
 * { project: {campo: valore}, lavorazioni: Map<id, patch>, decisioni: Map<id, testo>, applicate }
 */
function applica(all, correzioni) {
  const p = all.project || {};
  const patchP = {};
  const lavs = new Map();
  const dec = new Map();
  let applicate = 0;
  const lav = (id) => {
    if (!lavs.has(id)) { const l = (all.lavorazioni || []).find(x => x.id === id); if (!l) return null; lavs.set(id, { _l: l }); }
    return lavs.get(id);
  };
  const cur = (k) => (k in patchP ? patchP[k] : p[k]);
  for (const c of correzioni || []) {
    const parti = String(c.ref || '').split(':');
    const sb = String(c.sbagliato || ''), co = String(c.corretto || '');
    if (!sb || !co) continue;
    let ok = false;
    if (parti[0] === 'p') {
      const [, k, a, b] = parti;
      if (k === 'descrizione' || k === 'tipo_opera') { const v = sostituisci(cur(k), sb, co); if (v !== null) { patchP[k] = v; ok = true; } }
      else if (k === 'testi') { const o = cur('testi') || {}; const v = sostituisci(o[a], sb, co); if (v !== null) { patchP.testi = set(o, a, v); ok = true; } }
      else if (k === 'org') { const o = cur('organizzazione') || {}; const v = o[a] && sostituisci(o[a].testo, sb, co); if (v) { patchP.organizzazione = set(o, a, { ...o[a], testo: v }); ok = true; } }
      else if (k === 'ctx') { const o = cur('contesto') || {}; const v = sostituisci(o.note, sb, co); if (v !== null) { patchP.contesto = { ...o, note: v }; ok = true; } }
      else if (k === 'coord' || k === 'emerg') { const f = k === 'coord' ? 'coordinamento' : 'emergenze'; const o = cur(f) || {}; const v = sostituisci(o[a], sb, co); if (v !== null) { patchP[f] = set(o, a, v); ok = true; } }
      else if (k === 'uso') { const arr = [...(cur('uso_comune') || [])]; const i = Number(a); const v = arr[i] && sostituisci(arr[i].testo, sb, co); if (v) { arr[i] = { ...arr[i], testo: v }; patchP.uso_comune = arr; ok = true; } }
      else if (k === 'proc') { const arr = [...(cur('procedure') || [])]; const i = Number(a); const v = arr[i] && sostituisci(arr[i][b], sb, co); if (v) { arr[i] = { ...arr[i], [b]: v }; patchP.procedure = arr; ok = true; } }
    } else if (parti[0] === 'l') {
      const [, id, k, x] = parti;
      const L = lav(id);
      if (L) {
        const src = (f) => (f in L ? L[f] : L._l[f]);
        if (k === 'nome' || k === 'descrizione') { const v = sostituisci(src(k), sb, co); if (v !== null) { L[k] = v; ok = true; } }
        else if (k === 'm' || k === 'r') { const f = k === 'm' ? 'misure' : 'rischi'; const arr = (src(f) || []).map(e => (e.id === x && sostituisci(e.testo, sb, co) !== null ? (ok = true, { ...e, testo: sostituisci(e.testo, sb, co) }) : e)); if (ok) L[f] = arr; }
        else if (k === 'f') { const arr = [...(src('fasi') || [])]; const v = sostituisci(arr[Number(x)], sb, co); if (v !== null) { arr[Number(x)] = v; L.fasi = arr; ok = true; } }
      }
    } else if (parti[0] === 'd') {
      const d = (all.decisioni || []).find(x => x.id === parti[1]);
      const v = d && sostituisci(dec.has(d.id) ? dec.get(d.id) : d.testo, sb, co);
      if (v) { dec.set(d.id, v); ok = true; }
    }
    if (ok) applicate++;
  }
  for (const L of lavs.values()) delete L._l;
  for (const [id, L] of lavs) if (!Object.keys(L).length) lavs.delete(id);
  return { project: patchP, lavorazioni: lavs, decisioni: dec, applicate };
}

module.exports = { testiDa, controlla, applica, TOOL, SYSTEM };
