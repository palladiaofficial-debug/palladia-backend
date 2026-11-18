'use strict';
/**
 * lib/fattureCantiere.js — F-510 (AUDIT.md del frontend, 18/11/2026).
 *
 * Le fatture dei fornitori (company_expenses, Da pagare) vanno sul cantiere
 * giusto, così «Cosa hai speso» in Soldi le conta. Una domanda alla volta al
 * titolare: «di quale cantiere è?». Palladia propone, il titolare conferma.
 *
 * Proposte, nell'ordine:
 *  1. il cantiere scritto nella fattura (via + numero civico del cantiere nel
 *     testo del PDF/XML: «Corso Sardegna» da solo non basta, ce ne sono due);
 *  2. il cantiere delle fatture precedenti dello stesso fornitore.
 * Mai assegnate da sole: una fattura di bagni chimici cita tre cantieri.
 *
 * site_id NULL + cantiere_scelto_at valorizzato = spesa generale (risposta data).
 */
const supabase = require('./supabase');
const { extractPdfText } = require('./pdfExtract');
const { normNome } = require('./daPagare');

const BUCKET = 'site-documents';
const PREFISSI = /^(via|viale|corso|piazza|piazzale|salita|vico|vicolo|largo|strada|località|loc\.)\s+/i;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

/** «Via Balbi 31» → { parola: 'balbi', numero: '31' } (puro). */
function chiaveCantiere(nome) {
  const n = norm(nome).replace(PREFISSI, '').trim();
  const m = n.match(/^(.*?)\s+(\d+[a-z]?)\b/);
  const testo = m ? m[1] : n;
  const parola = testo.split(' ').filter(w => w.length > 3).sort((a, b) => b.length - a.length)[0] || null;
  return { parola, numero: m ? m[2] : null };
}

/** I cantieri scritti nel testo della fattura, in ordine di comparsa (puro). */
function cantieriNelTesto(testo, siti) {
  const t = norm(testo);
  const trovati = [];
  for (const s of siti) {
    for (const nome of [s.name, s.address].filter(Boolean)) {
      const { parola, numero } = chiaveCantiere(nome);
      // Solo via + numero civico: un nome senza numero («Magazzino MSCedilizia»)
      // compare in ogni fattura intestata all'impresa e darebbe proposte sbagliate
      if (!parola || !numero) continue;
      // Il nome del cantiere lo scrive l'utente: tutto ciò che non è lettera o cifra si toglie
      const p = parola.replace(/[^a-z0-9]/g, ''), n = numero.replace(/[^a-z0-9]/g, '');
      if (!p || !n) continue;
      // eslint-disable-next-line security/detect-non-literal-regexp -- solo [a-z0-9], ripulito qui sopra
      const re = new RegExp(`\\b${p}\\b[^0-9]{0,12}\\b${n}\\b`);
      const m = t.match(re);
      if (m) { trovati.push({ siteId: s.id, pos: m.index }); break; }
    }
  }
  return trovati.sort((a, b) => a.pos - b.pos).map(x => x.siteId);
}

async function testoFattura(path) {
  if (!path) return '';
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return '';
  const buf = Buffer.from(await data.arrayBuffer());
  if (/\.pdf$/i.test(path)) return (await extractPdfText(buf, { maxPages: 3, minChars: 1 })).text || '';
  if (/\.(xml|p7m)$/i.test(path)) return buf.toString('utf8');
  return '';
}

/** I cantieri tra cui scegliere: quelli non eliminati, i più lavorati negli ultimi 60 giorni prima. */
async function cantieriScelta(companyId) {
  const { data: siti } = await supabase.from('sites').select('id, name, address, status')
    .eq('company_id', companyId).neq('status', 'eliminato');
  const da = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: tim } = await supabase.from('presence_logs').select('site_id')
    .eq('company_id', companyId).gte('timestamp_server', da).limit(5000);
  const conta = {};
  for (const r of tim || []) if (r.site_id) conta[r.site_id] = (conta[r.site_id] || 0) + 1;
  return (siti || []).map(s => ({ ...s, attivita: conta[s.id] || 0 }))
    .sort((a, b) => b.attivita - a.attivita || a.name.localeCompare(b.name, 'it'));
}

/** Le fatture che non sanno ancora di quale cantiere sono, con le proposte. */
async function fattureSenzaCantiere(companyId) {
  const { data: righe, error } = await supabase.from('company_expenses')
    .select('id, supplier, amount, invoice_number, expense_date, receipt_url, suggested_site_id, suggested_site_reason, is_credit_note')
    .eq('company_id', companyId).is('site_id', null).is('cantiere_scelto_at', null)
    .order('expense_date', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  if (!righe?.length) return { fatture: [], cantieri: [] };

  const siti = await cantieriScelta(companyId);
  const { data: storia } = await supabase.from('company_expenses').select('supplier, site_id, expense_date')
    .eq('company_id', companyId).not('site_id', 'is', null).order('expense_date', { ascending: false }).limit(500);

  const fatture = [];
  for (const r of righe) {
    let proposte = [];
    let motivo = null;
    // La proposta letta dalla fattura si ricorda (suggested_site_*): il PDF si legge una volta sola
    if (r.suggested_site_reason) {
      try { const p = JSON.parse(r.suggested_site_reason); proposte = p.ids || []; motivo = p.motivo || null; } catch { /* vecchio formato */ }
    } else {
      const ids = cantieriNelTesto(await testoFattura(r.receipt_url), siti);
      if (ids.length) { proposte = ids; motivo = ids.length === 1 ? 'È scritto nella fattura' : 'Nella fattura ci sono questi cantieri'; }
      await supabase.from('company_expenses').update({
        suggested_site_id: ids[0] || null,
        suggested_site_reason: JSON.stringify({ ids, motivo }),
      }).eq('id', r.id);
    }
    if (!proposte.length) {
      const prima = (storia || []).find(x => normNome(x.supplier) === normNome(r.supplier));
      if (prima) { proposte = [prima.site_id]; motivo = 'Le altre fatture di questo fornitore erano di questo cantiere'; }
    }
    fatture.push({
      id: r.id, fornitore: r.supplier, importo: Number(r.amount) * (r.is_credit_note ? -1 : 1),
      numero: r.invoice_number, data: r.expense_date, proposte: proposte.filter(id => siti.some(s => s.id === id)), motivo,
    });
  }
  return { fatture, cantieri: siti.map(s => ({ id: s.id, nome: s.name, chiuso: s.status === 'chiuso' })) };
}

/** La risposta del titolare: siteId = un cantiere, null = spesa generale. */
async function assegna(companyId, expenseId, siteId) {
  if (siteId) {
    const { data: s } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
    if (!s) { const e = new Error('Cantiere non trovato.'); e.status = 404; throw e; }
  }
  const { data, error } = await supabase.from('company_expenses')
    .update({ site_id: siteId || null, cantiere_scelto_at: new Date().toISOString() })
    .eq('id', expenseId).eq('company_id', companyId).select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) { const e = new Error('Fattura non trovata.'); e.status = 404; throw e; }
  return { ok: true };
}

module.exports = { chiaveCantiere, cantieriNelTesto, fattureSenzaCantiere, assegna };
