'use strict';
/**
 * lib/impreseCarica/ordina.js — F-401: i documenti di un caricamento, in ordine.
 * Puro: provato da scripts/selftest_imprese_carica.js.
 *
 *  - per impresa (quelle note e quelle nuove), e dentro per operaio;
 *  - doppioni: già in Palladia (stesso file) o ripetuti nel caricamento;
 *  - superati: dello stesso requisito (DURC dell'impresa, visita di un operaio,
 *    POS di un cantiere…) se ne salva UNO, il migliore (va bene, poi scadenza
 *    più lontana, poi il più recente); gli altri restano fuori, detto perché;
 *  - da assegnare: quelli di cui non si sa l'impresa;
 *  - non letti: file illeggibili o protetti.
 */
const { motivoItaliano } = require('../impreseControllo');
const { normName } = require('../fuzzyMatch');
const { PERSONA } = require('./attribuisci');

const ETICHETTA = {
  durc: 'DURC', visura: 'Visura camerale', dvr: 'DVR o autocertificazione', dichiarazione: 'Dichiarazione che non è sospesa',
  assicurazione: 'Assicurazione RC', pos: 'POS', idoneita: 'Visita medica', formazione: 'Corso sicurezza',
};
const etichetta = (p) => ETICHETTA[p.tipo] || p.titolo || 'Altro documento';
const chiaveImpresa = (p) => (p.impresa?.id ? `i:${p.impresa.id}` : p.impresa?.nuova ? `n:${p.impresa.nuova.piva || normName(p.impresa.nuova.nome)}` : null);
const chiaveOperaio = (p) => (p.operaio?.id ? `o:${p.operaio.id}` : p.operaio?.nuovo ? `x:${p.operaio.nuovo.cf || normName(p.operaio.nuovo.nome)}` : null);

/** Lo stesso requisito: se ne tiene uno solo. null = niente da confrontare (documenti «altro»). */
function chiaveRequisito(p) {
  const imp = chiaveImpresa(p);
  if (!imp || p.tipo === 'altro') return null;
  if (PERSONA.has(p.tipo)) { const op = chiaveOperaio(p); return op ? `${imp}|${op}|${p.tipo}|${p.corso || ''}` : null; }
  if (p.tipo === 'pos') return p.siteId ? `${imp}|pos|${p.siteId}` : null;
  return `${imp}|${p.tipo}`;
}
const migliore = (a, b) => {
  const va = (d) => (d.proposta.esito === 'va_bene' ? 1 : 0);
  if (va(a) !== va(b)) return va(a) > va(b) ? a : b;
  const sa = a.proposta.scadenza || '', sb = b.proposta.scadenza || '';
  if (sa !== sb) return sa > sb ? a : b;
  const da = a.letto?.dataDocumento || '', db = b.letto?.dataDocumento || '';
  return db > da ? b : a;
};

function vista(d, ctx) {
  const p = d.proposta;
  const cantiere = p.siteId ? (ctx.cantieriPer[p.impresa?.id] || []).find(c => c.id === p.siteId) : null;
  return {
    id: d.id, tipo: p.tipo, corso: p.corso || null, label: p.tipo === 'pos' && cantiere ? `POS · ${cantiere.nome}` : etichetta(p),
    esito: p.esito, motivo: p.motivo ? motivoItaliano(p.motivo) : null, scadenza: p.scadenza || null, scadenzaCalcolata: !!d.letto?.scadenzaCalcolata && !p.scadenzaScelta,
    nomeFile: d.nome_file, pagine: d.pagine, come: p.come, siteId: p.siteId, persona: d.letto?.persona || null,
    impresa: p.impresa, operaio: p.operaio,
  };
}

/** docs: righe «documento» del caricamento, con `gia` (lo stesso file è già in Palladia). */
function ordina(docs, ctx) {
  const out = { imprese: [], daAssegnare: [], doppioni: [], superati: [], scartati: [], errori: [], nostri: [] };
  const visti = new Map();
  const daSalvare = [];
  for (const d of docs) {
    if (d.stato === 'errore') { out.errori.push({ id: d.id, nomeFile: d.nome_file, pagine: d.pagine, errore: d.errore }); continue; }
    if (d.stato !== 'pronto') continue;
    const p = d.proposta;
    if (p.scartato) { out.scartati.push(vista(d, ctx)); continue; }
    if (d.gia) { out.doppioni.push({ ...vista(d, ctx), perche: 'È già in Palladia' }); continue; }
    if (d.content_hash && visti.has(d.content_hash)) { out.doppioni.push({ ...vista(d, ctx), perche: `Uguale a ${visti.get(d.content_hash)}` }); continue; }
    if (d.content_hash) visti.set(d.content_hash, d.nome_file || 'un altro file');
    if (p.nostra) { out.nostri.push(vista(d, ctx)); continue; }
    if (!chiaveImpresa(p)) { out.daAssegnare.push(vista(d, ctx)); continue; }
    daSalvare.push(d);
  }
  // Superati: per ogni requisito il migliore
  const perReq = new Map();
  for (const d of daSalvare) {
    const k = chiaveRequisito(d.proposta);
    if (!k) continue;
    perReq.set(k, perReq.has(k) ? migliore(perReq.get(k), d) : d);
  }
  const salvati = daSalvare.filter(d => {
    const k = chiaveRequisito(d.proposta);
    if (!k || perReq.get(k) === d) return true;
    const v = perReq.get(k);
    out.superati.push({ ...vista(d, ctx), perche: `Ce n'è uno migliore${v.proposta.scadenza ? `, valido fino al ${v.proposta.scadenza}` : ''} (${v.nome_file || 'nello stesso caricamento'})` });
    return false;
  });

  // Per impresa, e dentro per operaio
  const gruppi = new Map();
  for (const d of salvati) {
    const p = d.proposta;
    const k = chiaveImpresa(p);
    if (!gruppi.has(k)) {
      const nota = p.impresa.id ? ctx.imprese.find(i => i.id === p.impresa.id) : null;
      gruppi.set(k, { key: k, id: p.impresa.id || null, nuova: p.impresa.nuova || null, nome: nota ? nota.nome : p.impresa.nuova.nome, documenti: [], operai: new Map() });
    }
    const g = gruppi.get(k);
    if (PERSONA.has(p.tipo)) {
      const ko = chiaveOperaio(p) || 'senza-nome';
      if (!g.operai.has(ko)) {
        const noto = p.operaio?.id ? ctx.operai.find(o => o.id === p.operaio.id) : null;
        g.operai.set(ko, { key: ko, id: p.operaio?.id || null, nuovo: p.operaio?.nuovo || null, nome: noto ? noto.nome : p.operaio?.nuovo?.nome || 'Operaio senza nome', documenti: [] });
      }
      g.operai.get(ko).documenti.push(vista(d, ctx));
    } else g.documenti.push(vista(d, ctx));
  }
  const ORDINE = ['durc', 'visura', 'dvr', 'dichiarazione', 'assicurazione', 'pos', 'altro'];
  out.imprese = [...gruppi.values()].map(g => ({
    ...g,
    documenti: g.documenti.sort((a, b) => ORDINE.indexOf(a.tipo) - ORDINE.indexOf(b.tipo)),
    operai: [...g.operai.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it')),
  })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  out.daSalvare = salvati.map(d => d.id);
  out.nonVanno = salvati.filter(d => d.proposta.esito === 'non_va').length;
  return out;
}

module.exports = { ordina, chiaveRequisito, chiaveImpresa, chiaveOperaio, etichetta, ETICHETTA };
