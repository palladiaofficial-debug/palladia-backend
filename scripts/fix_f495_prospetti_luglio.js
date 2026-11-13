#!/usr/bin/env node
/**
 * scripts/fix_f495_prospetti_luglio.js — una tantum, F-495 (AUDIT.md del frontend).
 * I prospetti paghe di luglio 2026 di MSCedilizia S.r.l. erano in Documenti ›
 * Impresa (3 PDF «busta_paga»). Li unisce in un PDF, li mette fra i
 * «Prospetti del commercialista» (buste_caricamenti.riepilogo_path, solo
 * owner/admin) e solo dopo averlo verificato li toglie da Documenti.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
const B = 'site-documents';
const ORD = ['f734e6c0-8ab7-4e17-a3d9-8ec316940010', '2e352e26-9f37-4d75-9b00-2ce7e8d60ea4', '8dc198cb-c0b8-4183-a939-81bc2be9d543'];

(async () => {
  const { data: rows, error } = await db.from('company_documents').select('id, file_path').in('id', ORD).eq('company_id', CO);
  if (error) throw error;
  if (rows.length !== 3) throw new Error(`attesi 3 documenti, trovati ${rows.length} (già spostati?)`);

  const out = await PDFDocument.create();
  for (const id of ORD) {
    const r = rows.find(x => x.id === id);
    const { data, error: e } = await db.storage.from(B).download(r.file_path);
    if (e) throw e;
    const src = await PDFDocument.load(Buffer.from(await data.arrayBuffer()));
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
  }
  const bytes = Buffer.from(await out.save());
  const pag = out.getPageCount();

  const path = `payslips/${CO}/_riepiloghi/2026-07-${crypto.randomUUID()}.pdf`;
  const up = await db.storage.from(B).upload(path, bytes, { contentType: 'application/pdf' });
  if (up.error) throw up.error;
  const chk = await db.storage.from(B).download(path);
  if (chk.error || (await chk.data.arrayBuffer()).byteLength !== bytes.length) throw new Error('verifica del nuovo PDF fallita: non tolgo niente');

  const { data: car, error: ie } = await db.from('buste_caricamenti').insert([{
    company_id: CO, file_path: path, nome_file: 'Prospetti luglio 2026 (spostati da Documenti, F-495)',
    pagine: pag, analisi: { spostato_da: 'company_documents', ids: ORD },
    confermato_at: '2026-08-16T17:25:43.946389+00:00', esito: { anno: 2026, mese: 7 },
    riepilogo_path: path, riepilogo_pagine: pag,
  }]).select('id').single();
  if (ie) throw ie;
  console.log(`Prospetto di luglio in Buste paga: ${pag} pagine (caricamento ${car.id})`);

  const del = await db.from('company_documents').delete().in('id', ORD).eq('company_id', CO);
  if (del.error) throw del.error;
  const rm = await db.storage.from(B).remove(rows.map(r => r.file_path));
  console.log(`Tolti da Documenti: 3 documenti, ${rm.data?.length ?? 0} file${rm.error ? ' — errore file: ' + rm.error.message : ''}`);
  const { data: left } = await db.from('documents').select('id').eq('source_table', 'company_documents').in('legacy_id', ORD);
  console.log(`Righe rimaste nell'archivio unificato: ${left?.length ?? 0}`);
})().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
