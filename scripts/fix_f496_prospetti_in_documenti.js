#!/usr/bin/env node
/**
 * scripts/fix_f496_prospetti_in_documenti.js — una tantum, F-496 (AUDIT.md del frontend).
 * 4 prospetti paghe trovati dal CONTENUTO in Documenti › Impresa (nome «altro»):
 * MSCedilizia S.r.l. agosto (2) e settembre (1), MSCedilizia luglio (1).
 * Per ogni impresa e mese: ricontrolla che sia davvero paghe, unisce i PDF, lo
 * mette fra i «Prospetti del commercialista» (solo owner/admin) e solo dopo
 * averlo verificato lo toglie da Documenti.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { controllaFile } = require('../lib/bustePaga/riconosci');

const B = 'site-documents';
// in ordine di pagina dentro ogni mese
const IDS = ['9ea280b7-4804-46cc-a35b-cd210805c662', '9b151bb1-e3f3-4b4d-af3a-08d67861d8f0', 'c9dfd68d-df76-4a63-970e-f2749f5fcbab', 'c2fdebb7-66bd-4c33-ba7d-e018b6e1aa6b'];

(async () => {
  const { data: rows, error } = await supabase.from('company_documents').select('id, company_id, file_path, created_at, companies(name)').in('id', IDS);
  if (error) throw error;
  if (!rows.length) { console.log('Niente da spostare (già fatto?)'); return; }

  const gruppi = new Map();
  for (const id of IDS) {
    const r = rows.find(x => x.id === id);
    if (!r) continue;
    const { data, error: e } = await supabase.storage.from(B).download(r.file_path);
    if (e) throw e;
    const buf = Buffer.from(await data.arrayBuffer());
    const c = await controllaFile(buf, 'application/pdf', 'x.pdf');
    if (!c.paghe || !c.periodo) { console.log(`SALTO ${id}: non lo riconosco più come prospetto`); continue; }
    const k = `${r.company_id}|${c.periodo.anno}|${c.periodo.mese}`;
    if (!gruppi.has(k)) gruppi.set(k, { company_id: r.company_id, impresa: r.companies?.name, periodo: c.periodo, docs: [], ultimo: r.created_at });
    const g = gruppi.get(k);
    g.docs.push({ ...r, buf });
    if (r.created_at > g.ultimo) g.ultimo = r.created_at;
  }

  for (const g of gruppi.values()) {
    const out = await PDFDocument.create();
    for (const d of g.docs) {
      const src = await PDFDocument.load(d.buf);
      (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    const bytes = Buffer.from(await out.save());
    const pag = out.getPageCount();
    const mm = String(g.periodo.mese).padStart(2, '0');
    const path = `payslips/${g.company_id}/_riepiloghi/${g.periodo.anno}-${mm}-${crypto.randomUUID()}.pdf`;
    const up = await supabase.storage.from(B).upload(path, bytes, { contentType: 'application/pdf' });
    if (up.error) throw up.error;
    const chk = await supabase.storage.from(B).download(path);
    if (chk.error || (await chk.data.arrayBuffer()).byteLength !== bytes.length) throw new Error('verifica del nuovo PDF fallita: non tolgo niente');
    const ids = g.docs.map(d => d.id);
    const { error: ie } = await supabase.from('buste_caricamenti').insert([{
      company_id: g.company_id, file_path: path, nome_file: `Prospetti ${mm}/${g.periodo.anno} (spostati da Documenti, F-496)`,
      pagine: pag, analisi: { spostato_da: 'company_documents', ids }, confermato_at: g.ultimo,
      esito: { anno: g.periodo.anno, mese: g.periodo.mese }, riepilogo_path: path, riepilogo_pagine: pag,
    }]);
    if (ie) throw ie;
    const del = await supabase.from('company_documents').delete().in('id', ids);
    if (del.error) throw del.error;
    await supabase.storage.from(B).remove(g.docs.map(d => d.file_path));
    const { data: left } = await supabase.from('documents').select('id').eq('source_table', 'company_documents').in('legacy_id', ids);
    console.log(`${g.impresa}: ${mm}/${g.periodo.anno} → Buste paga (${pag} pagine, ${ids.length} file tolti da Documenti, ${left?.length ?? 0} righe rimaste nell'archivio)`);
  }
  process.exit(0);
})().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
