#!/usr/bin/env node
/**
 * scripts/fix_f506_f507_documenti_impresa.js — una tantum, F-506/F-507 (AUDIT.md del frontend).
 *
 * F-506: i documenti d'impresa salvati col nome «altro» (Importa cartella, 16/8, 16/9, 14/10).
 *   - Quelli che dal contenuto sono prospetti paghe del commercialista: per impresa e
 *     importazione si uniscono in un PDF che va fra i «Prospetti del commercialista»
 *     (buste_caricamenti, solo owner/admin), e solo dopo averlo verificato si tolgono
 *     da Documenti. Il mese è quello scritto su una delle pagine dello stesso gruppo.
 *   - Gli altri prendono un nome leggibile (tipo + pagine).
 * F-507: rilegge i documenti d'impresa e di cantiere mai letti (lib/documentiRilettura).
 *
 *   node scripts/fix_f506_f507_documenti_impresa.js        → dice cosa farebbe
 *   node scripts/fix_f506_f507_documenti_impresa.js --vai  → lo fa
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { controllaFile } = require('../lib/bustePaga/riconosci');

const VAI = process.argv.includes('--vai');
const B = 'site-documents';
const NOMI_TIPO = { f24: 'Modello F24', durc: 'DURC', visura: 'Visura camerale', altro: 'Documento' };

(async () => {
  const { data: rows, error } = await supabase.from('company_documents')
    .select('id, company_id, name, category, file_path, mime_type, created_at, companies(name)').eq('name', 'altro');
  if (error) throw error;
  console.log(`${rows.length} documenti d'impresa col nome «altro»${VAI ? '' : ' (prova: niente viene cambiato)'}`);

  const gruppi = new Map();
  for (const r of rows) {
    const { data, error: e } = await supabase.storage.from(B).download(r.file_path);
    if (e) { console.log(`  SALTO ${r.id}: file non scaricabile (${e.message})`); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    const c = await controllaFile(buf, r.mime_type || 'application/pdf', 'x.pdf');
    const pag = (String(r.file_path).match(/(\d+-\d+)\)\s*$/) || [])[1];
    if (!c.paghe) {
      const nome = `${NOMI_TIPO[r.category] || 'Documento'}${pag ? ` (pag. ${pag})` : ''}`;
      console.log(`  ${r.companies?.name}: ${r.id.slice(0, 8)} non è paghe → si chiamerà «${nome}»`);
      if (VAI) { const u = await supabase.from('company_documents').update({ name: nome }).eq('id', r.id); if (u.error) throw u.error; }
      continue;
    }
    const k = `${r.company_id}|${r.created_at.slice(0, 10)}`;
    if (!gruppi.has(k)) gruppi.set(k, { company_id: r.company_id, impresa: r.companies?.name, giorno: r.created_at.slice(0, 10), docs: [], periodo: null, ultimo: r.created_at });
    const g = gruppi.get(k);
    g.docs.push({ ...r, buf, pagIni: Number((pag || '0').split('-')[0]) });
    if (c.periodo && !g.periodo) g.periodo = c.periodo;
    if (r.created_at > g.ultimo) g.ultimo = r.created_at;
  }

  for (const g of gruppi.values()) {
    if (!g.periodo) { console.log(`  SALTO ${g.impresa} ${g.giorno}: nessuna pagina dice il mese`); continue; }
    g.docs.sort((a, b) => a.pagIni - b.pagIni);
    const mm = String(g.periodo.mese).padStart(2, '0');
    console.log(`  ${g.impresa}: importazione del ${g.giorno} → prospetti ${mm}/${g.periodo.anno} (${g.docs.length} file)`);
    if (!VAI) continue;
    const out = await PDFDocument.create();
    for (const d of g.docs) {
      const src = await PDFDocument.load(d.buf);
      (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    const bytes = Buffer.from(await out.save());
    const pagine = out.getPageCount();
    const path = `payslips/${g.company_id}/_riepiloghi/${g.periodo.anno}-${mm}-${crypto.randomUUID()}.pdf`;
    const up = await supabase.storage.from(B).upload(path, bytes, { contentType: 'application/pdf' });
    if (up.error) throw up.error;
    const chk = await supabase.storage.from(B).download(path);
    if (chk.error || (await chk.data.arrayBuffer()).byteLength !== bytes.length) throw new Error('verifica del nuovo PDF fallita: non tolgo niente');
    const ids = g.docs.map(d => d.id);
    const { error: ie } = await supabase.from('buste_caricamenti').insert([{
      company_id: g.company_id, file_path: path, nome_file: `Prospetti ${mm}/${g.periodo.anno} (spostati da Documenti, F-506)`,
      pagine, analisi: { spostato_da: 'company_documents', ids }, confermato_at: g.ultimo,
      esito: { anno: g.periodo.anno, mese: g.periodo.mese }, riepilogo_path: path, riepilogo_pagine: pagine,
    }]);
    if (ie) throw ie;
    const del = await supabase.from('company_documents').delete().in('id', ids);
    if (del.error) throw del.error;
    await supabase.storage.from(B).remove(g.docs.map(d => d.file_path));
    const { data: left } = await supabase.from('documents').select('id').eq('source_table', 'company_documents').in('legacy_id', ids);
    console.log(`    fatto: ${pagine} pagine fra i prospetti, ${ids.length} file tolti da Documenti, ${left?.length ?? 0} righe rimaste nell'archivio`);
  }

  const { daRileggere, rileggi } = require('../lib/documentiRilettura');
  const lista = await daRileggere({ max: 60 });
  console.log(`\nF-507: ${lista.length} documenti mai letti da rileggere`);
  for (const d of lista) console.log(`  ${d.company} | ${d.tabella} | ${d.id.slice(0, 8)}`);
  if (VAI && lista.length) console.log(await rileggi({ max: 60 }));
  process.exit(0);
})().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
