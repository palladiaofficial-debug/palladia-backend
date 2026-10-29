'use strict';
/**
 * lib/bustePaga/index.js — F-399 (AUDIT.md del frontend): «Carica le buste del mese».
 *
 *  leggi()      → il PDF del commercialista: lo mette da parte e lo divide
 *                 (./dividi.js, senza AI); dice il mese, chi ha già la busta di
 *                 quel mese e chi non ha la busta nel file
 *  esistenti()  → chi ha già la busta di un altro mese (se il titolare lo cambia)
 *  conferma()   → una busta per operaio, mandata (status «shared»: la trova nel
 *                 badge col PIN); prospetti e riepiloghi in Documenti › Impresa;
 *                 il file caricato si cancella
 *
 * Prima lo faceva Ladia in chat (il 14/10 ha scritto «archiviate 21 buste» per
 * 17). Qui il conto lo fa il codice e il titolare vede prima cosa manda.
 */
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const supabase = require('../supabase');
const { extractPdfText } = require('../pdfExtract');
const { inspectPdf } = require('../pdfSplit');
const { dividi, paginaPerPagina, MESI } = require('./dividi');

const BUCKET = 'site-documents';
class BusteError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const nomeMese = (m) => MESI[m - 1].charAt(0) + MESI[m - 1].slice(1).toLowerCase();

function meseScorso() {
  const oggi = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) + 'T12:00:00Z');
  oggi.setUTCMonth(oggi.getUTCMonth() - 1);
  return { anno: oggi.getUTCFullYear(), mese: oggi.getUTCMonth() + 1 };
}

async function operai(companyId) {
  const { data, error } = await supabase.from('workers').select('id, full_name, fiscal_code, is_active, pending_approval')
    .eq('company_id', companyId).order('full_name');
  dbErr(error);
  return (data || []).filter(w => !w.pending_approval).map(w => ({ id: w.id, nome: w.full_name, cf: w.fiscal_code, attivo: w.is_active !== false }));
}

async function esistenti(companyId, workerIds, { anno, mese }) {
  if (!workerIds.length) return [];
  const { data, error } = await supabase.from('payslips').select('worker_id, status')
    .eq('company_id', companyId).eq('period_year', anno).eq('period_month', mese).in('worker_id', workerIds);
  dbErr(error);
  return (data || []).map(p => ({ workerId: p.worker_id, firmata: p.status === 'acknowledged' }));
}

async function leggi(companyId, userId, file) {
  if (!file?.buffer?.length) throw new BusteError(400, 'FILE_REQUIRED');
  const ins = await inspectPdf(file.buffer);
  if (!ins.ok) throw new BusteError(400, 'PDF_ROTTO');
  if (ins.encrypted) throw new BusteError(400, 'PDF_PROTETTO');
  const { text, numPages } = await extractPdfText(file.buffer, { maxPages: 400, minChars: 0 });
  const ws = await operai(companyId);
  const r = dividi(paginaPerPagina(text, numPages), ws);
  if (r.senzaTesto) throw new BusteError(422, 'SCANSIONE');
  const periodo = r.periodo || meseScorso();

  const path = `payslips/${companyId}/_caricamenti/${crypto.randomUUID()}.pdf`;
  const up = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(up.error.message);
  const { data: row, error } = await supabase.from('buste_caricamenti').insert({
    company_id: companyId, file_path: path, nome_file: String(file.originalname || '').slice(0, 200) || null,
    pagine: numPages, analisi: { segmenti: r.segmenti, periodo, periodoLetto: !!r.periodo }, created_by: userId || null,
  }).select('id').single();
  if (error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }

  const nelFile = new Set(r.segmenti.filter(s => s.workerId).map(s => s.workerId));
  return {
    id: row.id, nomeFile: file.originalname || null, pagine: numPages,
    periodo, periodoLetto: !!r.periodo,
    segmenti: r.segmenti,
    esistenti: await esistenti(companyId, [...nelFile], periodo),
    // Chi lavora qui ma non ha la busta nel file (in ufficio o dimenticato dal commercialista)
    senzaBusta: ws.filter(w => w.attivo && !nelFile.has(w.id)).map(w => ({ id: w.id, nome: w.nome })),
    operai: ws.filter(w => w.attivo).map(w => ({ id: w.id, nome: w.nome })),
  };
}

async function caricamento(companyId, id) {
  const { data, error } = await supabase.from('buste_caricamenti').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw new BusteError(404, 'NOT_FOUND');
  return data;
}

async function esistentiPer(companyId, id, periodo) {
  const c = await caricamento(companyId, id);
  const ids = [...new Set(c.analisi.segmenti.filter(s => s.workerId).map(s => s.workerId))];
  return esistenti(companyId, ids, periodo);
}

/** Un PDF con le pagine date (1-based), nell'ordine. */
async function pagineDa(src, pagine) {
  const out = await PDFDocument.create();
  const copiate = await out.copyPages(src, pagine.map(n => n - 1));
  copiate.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

/**
 * assegna: { [indice del segmento]: workerId | null } — per le buste «da guardare»
 * (o per cambiare la persona di una busta). null = non mandarla a nessuno.
 */
async function conferma(companyId, userId, id, { anno, mese, assegna = {} } = {}) {
  if (!Number.isInteger(anno) || anno < 2020 || anno > 2099 || !Number.isInteger(mese) || mese < 1 || mese > 12) throw new BusteError(400, 'MESE_NON_VALIDO');
  const c = await caricamento(companyId, id);
  if (c.confermato_at) throw new BusteError(409, 'GIA_MANDATE');
  const ws = await operai(companyId);
  const validi = new Map(ws.map(w => [w.id, w]));

  const perOperaio = new Map();   // workerId → [pagine]
  const riepilogo = [];
  c.analisi.segmenti.forEach((s, i) => {
    const pagine = Array.from({ length: s.a - s.da + 1 }, (_, k) => s.da + k);
    if (s.tipo === 'riepilogo') { riepilogo.push(...pagine); return; }
    const scelto = Object.prototype.hasOwnProperty.call(assegna, i) ? assegna[i] : (s.tipo === 'busta' ? s.workerId : null);
    if (!scelto) return;
    if (!validi.has(scelto)) throw new BusteError(400, 'OPERAIO_NON_VALIDO');
    perOperaio.set(scelto, [...(perOperaio.get(scelto) || []), ...pagine]);
  });
  if (!perOperaio.size) throw new BusteError(400, 'NIENTE_DA_MANDARE');

  const dl = await supabase.storage.from(BUCKET).download(c.file_path);
  if (dl.error) throw new Error(dl.error.message);
  const src = await PDFDocument.load(Buffer.from(await dl.data.arrayBuffer()));
  const mm = String(mese).padStart(2, '0');
  const ora = new Date().toISOString();
  const mandate = [];
  for (const [workerId, pagine] of perOperaio) {
    const pdf = await pagineDa(src, pagine);
    const path = `payslips/${companyId}/${workerId}/${anno}-${mm}.pdf`;
    const up = await supabase.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(up.error.message);
    const { error } = await supabase.from('payslips').upsert({
      company_id: companyId, worker_id: workerId, uploaded_by: userId || null, period_year: anno, period_month: mese,
      filename: `Busta paga ${nomeMese(mese)} ${anno}.pdf`, file_path: path, file_size: pdf.length,
      status: 'shared', shared_at: ora, acknowledged_at: null, updated_at: ora,
    }, { onConflict: 'company_id,worker_id,period_year,period_month' });
    dbErr(error);
    mandate.push(workerId);
  }

  let riepilogoSalvato = false;
  if (riepilogo.length) {
    const pdf = await pagineDa(src, riepilogo);
    const path = `${companyId}/company/${crypto.randomUUID()}-buste-${anno}-${mm}-riepilogo.pdf`;
    const up = await supabase.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (!up.error) {
      const { error } = await supabase.from('company_documents').insert({
        company_id: companyId, name: `Buste paga ${nomeMese(mese)} ${anno} — prospetti e riepiloghi`, category: 'altro',
        file_path: path, mime_type: 'application/pdf', file_size: pdf.length, uploaded_by: userId || null,
      });
      riepilogoSalvato = !error;
    }
  }

  await supabase.storage.from(BUCKET).remove([c.file_path]).catch(() => {});
  await supabase.from('buste_caricamenti').update({ confermato_at: ora, esito: { anno, mese, mandate: mandate.length, riepilogo: riepilogo.length } }).eq('id', id);

  // Verifica: le buste ci sono davvero, condivise, per quel mese
  const { data: check } = await supabase.from('payslips').select('worker_id').eq('company_id', companyId)
    .eq('period_year', anno).eq('period_month', mese).eq('status', 'shared').in('worker_id', mandate);
  const ok = (check || []).length === mandate.length;
  return {
    mandate: mandate.length, riepilogo: riepilogoSalvato,
    resultCard: {
      id, title: `Buste di ${nomeMese(mese).toLowerCase()} mandate`,
      fatto: {
        verified: ok, verdict: { kind: 'none' },
        after: `${mandate.length === 1 ? 'Una busta mandata' : `${mandate.length} buste mandate`}: ognuno la trova nel suo badge, con il PIN.${riepilogoSalvato ? ' Prospetti e riepiloghi sono in Documenti › Impresa.' : ''}`,
        ...(ok ? {} : { mismatchWarning: `Ne risultano ${(check || []).length} su ${mandate.length}: controlla in Buste paga.` }),
      },
    },
  };
}

module.exports = { leggi, esistentiPer, conferma, BusteError };
