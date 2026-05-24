'use strict';
/**
 * routes/v1/offers.js
 * Offerte economiche — preventivi e gare d'appalto.
 *
 * POST   /api/v1/offers/parse         — AI parsing capitolato (no save)
 * POST   /api/v1/offers               — salva nuova offerta con voci
 * GET    /api/v1/offers               — lista offerte azienda
 * GET    /api/v1/offers/:id           — dettaglio + voci
 * PATCH  /api/v1/offers/:id           — aggiorna metadati (nome/cliente/stato…)
 * PATCH  /api/v1/offers/items/:itemId — aggiorna prezzo_offerta singola voce
 * DELETE /api/v1/offers/:id           — elimina offerta
 * GET    /api/v1/offers/:id/export.pdf — PDF offerta
 * GET    /api/v1/offers/:id/export.csv — CSV per Excel
 */

const router   = require('express').Router();
const multer   = require('multer');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');
const { parseOfferPdf }      = require('../../services/visionParser');
const { parseExcel }         = require('../../services/computoParser');
const { generateOfferPdf }   = require('../../services/offerPdfGenerator');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = [
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ];
    if (ok.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Formato non supportato. Carica un PDF o un file Excel.'));
  },
});

router.use(verifySupabaseJwt);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const round2 = n => Math.round(n * 100) / 100;

// ── POST /api/v1/offers/parse — AI parsing, nessun salvataggio ───────────────
router.post('/offers/parse',
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });
    const { mimetype, buffer } = req.file;
    const isPdf   = mimetype === 'application/pdf';
    const isExcel = mimetype.includes('excel') || mimetype.includes('spreadsheet') || mimetype === 'text/csv';

    try {
      let parsed;
      if (isPdf)        parsed = await parseOfferPdf(buffer);
      else if (isExcel) parsed = await parseExcel(buffer);
      else return res.status(400).json({ error: 'FORMAT_UNSUPPORTED' });

      // Mappa prezzo_unitario → prezzo_ref, pre-compila prezzo_offerta
      const voci = parsed.voci.map(v => ({
        tipo:           v.tipo,
        parent_codice:  v.parent_codice || null,
        codice:         v.codice || null,
        descrizione:    v.descrizione,
        unita_misura:   v.unita_misura || null,
        quantita:       v.quantita,
        prezzo_ref:     v.prezzo_unitario,
        prezzo_offerta: v.prezzo_unitario,
        importo_offerta: (v.quantita != null && v.prezzo_unitario != null)
          ? round2(v.quantita * v.prezzo_unitario)
          : null,
        sort_order: v.sort_order,
      }));

      const totale_offerta = round2(
        voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo_offerta || 0), 0)
      );

      res.json({
        nome:            parsed.nome || 'Nuova offerta',
        fonte:           isPdf ? 'pdf' : 'excel',
        n_voci:          voci.filter(v => v.tipo === 'voce').length,
        n_categorie:     voci.filter(v => v.tipo === 'categoria').length,
        totale_offerta,
        voci,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[offers/parse] ERROR:', msg, err?.stack || '');
      const isUser = msg.includes('non contiene') || msg.includes('Nessuna voce') || msg.includes('non parsabile') || msg.includes('grande');
      res.status(isUser ? 422 : 500).json({ error: isUser ? 'PARSE_FAILED' : 'INTERNAL', message: msg });
    }
  }
);

// ── POST /api/v1/offers — salva offerta con voci ─────────────────────────────
router.post('/offers', async (req, res) => {
  const { companyId, user } = req;
  const { nome, cliente, oggetto, fonte, note, voci } = req.body;

  if (!voci || !Array.isArray(voci))
    return res.status(400).json({ error: 'VOCI_REQUIRED' });

  const totale = round2(
    voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (Number(v.importo_offerta) || 0), 0)
  );

  const { data: offer, error: offerErr } = await supabase
    .from('offers')
    .insert({
      company_id:     companyId,
      nome:           String(nome || 'Nuova offerta').slice(0, 200),
      cliente:        cliente ? String(cliente).slice(0, 200) : null,
      oggetto:        oggetto ? String(oggetto).slice(0, 500) : null,
      fonte:          fonte || 'manuale',
      note:           note   ? String(note).slice(0, 1000) : null,
      totale_offerta: totale,
      created_by:     user.id,
    })
    .select()
    .single();

  if (offerErr) {
    console.error('[offers/save]', offerErr.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  // Inserisci categorie prima (servono gli id per risolvere parent_id delle voci)
  const codiceToId = {};
  for (const v of voci.filter(v => v.tipo === 'categoria')) {
    const row = {
      offer_id:   offer.id,
      company_id: companyId,
      tipo:       'categoria',
      parent_id:  null,
      sort_order: v.sort_order ?? 0,
      codice:     v.codice || null,
      descrizione: String(v.descrizione).slice(0, 500),
    };
    const { data: saved } = await supabase.from('offer_items').insert(row).select('id, codice').single();
    if (saved && v.codice) codiceToId[v.codice] = saved.id;
  }

  // Inserisci voci in batch
  const vociRows = voci
    .filter(v => v.tipo === 'voce')
    .map(v => {
      const po = v.prezzo_offerta != null ? Number(v.prezzo_offerta) : null;
      const qt = v.quantita != null ? Number(v.quantita) : null;
      return {
        offer_id:        offer.id,
        company_id:      companyId,
        tipo:            'voce',
        parent_id:       v.parent_codice ? (codiceToId[v.parent_codice] || null) : null,
        sort_order:      v.sort_order ?? 0,
        codice:          v.codice || null,
        descrizione:     String(v.descrizione).slice(0, 500),
        unita_misura:    v.unita_misura || null,
        quantita:        qt,
        prezzo_ref:      v.prezzo_ref      != null ? Number(v.prezzo_ref)      : null,
        prezzo_offerta:  po,
        importo_offerta: (qt != null && po != null) ? round2(qt * po) : null,
      };
    });

  const BATCH = 100;
  for (let i = 0; i < vociRows.length; i += BATCH) {
    const { error } = await supabase.from('offer_items').insert(vociRows.slice(i, i + BATCH));
    if (error) console.error('[offers/voci-batch]', error.message);
  }

  res.status(201).json({
    id:             offer.id,
    nome:           offer.nome,
    totale_offerta: offer.totale_offerta,
    n_categorie:    voci.filter(v => v.tipo === 'categoria').length,
    n_voci:         vociRows.length,
  });
});

// ── GET /api/v1/offers — lista offerte azienda ────────────────────────────────
router.get('/offers', async (req, res) => {
  const { data, error } = await supabase
    .from('offers')
    .select('id, nome, cliente, oggetto, stato, totale_offerta, fonte, created_at, updated_at')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── PATCH /api/v1/offers/items/:itemId — aggiorna voce (prezzo, quantità, desc…)
// DEVE stare prima di /offers/:id per evitare che "items" venga catturato come :id
router.patch('/offers/items/:itemId', async (req, res) => {
  const { companyId } = req;
  const { itemId }    = req.params;

  if (!isUuid(itemId)) return res.status(400).json({ error: 'INVALID_ID' });

  const { prezzo_offerta, quantita, descrizione, unita_misura, codice } = req.body;

  const { data: item } = await supabase
    .from('offer_items')
    .select('id, offer_id, tipo, quantita, prezzo_offerta')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!item) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });

  const patch = {};

  if (descrizione !== undefined) {
    if (typeof descrizione !== 'string' || !descrizione.trim())
      return res.status(400).json({ error: 'INVALID_DESCRIZIONE' });
    patch.descrizione = descrizione.trim().slice(0, 500);
  }
  if (unita_misura !== undefined) patch.unita_misura = unita_misura ? String(unita_misura).slice(0, 20) : null;
  if (codice !== undefined)       patch.codice = codice ? String(codice).slice(0, 50) : null;

  if (quantita !== undefined) {
    const qt = quantita === null || quantita === '' ? null : Number(quantita);
    if (qt !== null && (isNaN(qt) || qt < 0))
      return res.status(400).json({ error: 'INVALID_QUANTITA' });
    patch.quantita = qt;
  }

  if (prezzo_offerta !== undefined) {
    const pr = prezzo_offerta === null || prezzo_offerta === '' ? null : Number(prezzo_offerta);
    if (pr !== null && (isNaN(pr) || pr < 0))
      return res.status(400).json({ error: 'INVALID_PRICE' });
    patch.prezzo_offerta = pr;
  }

  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  // Ricalcola importo se quantita o prezzo cambiano
  const finalQt = patch.quantita    !== undefined ? patch.quantita    : (item.quantita       != null ? Number(item.quantita)       : null);
  const finalPr = patch.prezzo_offerta !== undefined ? patch.prezzo_offerta : (item.prezzo_offerta != null ? Number(item.prezzo_offerta) : null);
  patch.importo_offerta = (finalQt != null && finalPr != null) ? round2(finalQt * finalPr) : null;

  await supabase.from('offer_items')
    .update(patch)
    .eq('id', itemId)
    .eq('company_id', companyId);

  // Ricalcola totale offerta
  const { data: allItems } = await supabase
    .from('offer_items')
    .select('importo_offerta')
    .eq('offer_id', item.offer_id)
    .eq('tipo', 'voce');

  const totale_offerta = round2((allItems || []).reduce((s, i) => s + (Number(i.importo_offerta) || 0), 0));

  await supabase.from('offers')
    .update({ totale_offerta })
    .eq('id', item.offer_id)
    .eq('company_id', companyId);

  res.json({ ok: true, ...patch, totale_offerta });
});

// ── GET /api/v1/offers/:id — dettaglio con voci ───────────────────────────────
router.get('/offers/:id', async (req, res) => {
  const { companyId } = req;
  const { id }        = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data: offer } = await supabase
    .from('offers')
    .select('id, nome, cliente, oggetto, stato, totale_offerta, fonte, note, created_at, updated_at')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!offer) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: items } = await supabase
    .from('offer_items')
    .select('id, parent_id, tipo, sort_order, codice, descrizione, unita_misura, quantita, prezzo_ref, prezzo_offerta, importo_offerta')
    .eq('offer_id', id)
    .order('sort_order', { ascending: true });

  res.json({ ...offer, items: items || [] });
});

// ── PATCH /api/v1/offers/:id — aggiorna metadati ─────────────────────────────
router.patch('/offers/:id', async (req, res) => {
  const { companyId } = req;
  const { id }        = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const STATI = ['bozza', 'inviata', 'vinta', 'persa'];
  const allowed = ['nome', 'cliente', 'oggetto', 'stato', 'note'];
  const patch = {};

  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k] || null;
  }
  if (patch.nome)   patch.nome   = String(patch.nome).slice(0, 200);
  if (patch.oggetto) patch.oggetto = String(patch.oggetto).slice(0, 500);
  if (patch.stato && !STATI.includes(patch.stato))
    return res.status(400).json({ error: 'INVALID_STATO' });
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  const { data, error } = await supabase
    .from('offers')
    .update(patch)
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

// ── DELETE /api/v1/offers/:id ────────────────────────────────────────────────
router.delete('/offers/:id', async (req, res) => {
  const { companyId } = req;
  const { id }        = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { error } = await supabase
    .from('offers')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL' });
  res.json({ ok: true });
});

// ── GET /api/v1/offers/:id/export.pdf ────────────────────────────────────────
router.get('/offers/:id/export.pdf', async (req, res) => {
  const { companyId } = req;
  const { id }        = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data: offer } = await supabase
    .from('offers')
    .select('id, nome, cliente, oggetto, stato, totale_offerta, created_at')
    .eq('id', id).eq('company_id', companyId).maybeSingle();
  if (!offer) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: items } = await supabase
    .from('offer_items')
    .select('id, parent_id, tipo, sort_order, codice, descrizione, unita_misura, quantita, prezzo_ref, prezzo_offerta, importo_offerta')
    .eq('offer_id', id).order('sort_order', { ascending: true });

  const { data: company } = await supabase
    .from('companies').select('name').eq('id', companyId).maybeSingle();

  try {
    const pdfBuffer = await generateOfferPdf({ offer, items: items || [], company });
    const safeName  = (offer.nome || 'offerta').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="Offerta_${safeName}.pdf"`,
      'Content-Length':      pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[offers/export.pdf]', err.message);
    res.status(500).json({ error: 'PDF_GENERATION_FAILED', detail: err.message });
  }
});

// ── GET /api/v1/offers/:id/export.xlsx ───────────────────────────────────────
// Alias retrocompat: risponde xlsx anche se chiamato con .csv
router.get('/offers/:id/export.csv',  handleOfferXlsx);
router.get('/offers/:id/export.xlsx', handleOfferXlsx);

async function handleOfferXlsx(req, res) {
  const ExcelJS = require('exceljs');
  const { companyId } = req;
  const { id }        = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const [{ data: offer }, { data: items }, { data: company }] = await Promise.all([
    supabase.from('offers')
      .select('id, nome, cliente, oggetto, totale_offerta, created_at')
      .eq('id', id).eq('company_id', companyId).maybeSingle(),
    supabase.from('offer_items')
      .select('tipo, codice, descrizione, unita_misura, quantita, prezzo_ref, prezzo_offerta, importo_offerta')
      .eq('offer_id', id).order('sort_order', { ascending: true }),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ]);
  if (!offer) return res.status(404).json({ error: 'NOT_FOUND' });

  const fmtEur  = v => v != null ? parseFloat(Number(v).toFixed(2)) : null;
  const dateStr = new Date(offer.created_at || Date.now()).toLocaleDateString('it-IT');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();

  const ws = wb.addWorksheet('Offerta');

  const NAVY  = { argb: 'FF1E3A5F' };
  const WHITE = { argb: 'FFFFFFFF' };
  const LIGHT = { argb: 'FFF8FAFC' };
  const CAT_BG = { argb: 'FFE8EDF3' };

  // ── Header documento ─────────────────────────────────────────────────────────
  ws.columns = [
    { width: 12 }, // tipo
    { width: 16 }, // codice
    { width: 50 }, // descrizione
    { width: 8  }, // um
    { width: 10 }, // quantità
    { width: 14 }, // prezzo rif.
    { width: 14 }, // prezzo offerta
    { width: 16 }, // importo offerta
  ];

  const addMergedRow = (text, rowH, fillArgb, fontOpts) => {
    const r = ws.addRow([text]);
    r.height = rowH;
    const c = r.getCell(1);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
    c.font = { name: 'Calibri', ...fontOpts };
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.mergeCells(r.number, 1, r.number, 8);
    return r;
  };

  addMergedRow(company?.name || 'PALLADIA', 16, 'FFE8EDF3', { size: 9, color: { argb: 'FF6B7280' } });
  addMergedRow(`OFFERTA: ${offer.nome || '—'}`, 26, 'FF1E3A5F', { size: 13, bold: true, color: WHITE });
  if (offer.cliente) addMergedRow(`Cliente: ${offer.cliente}`, 17, 'FFE8EDF3', { size: 9.5, italic: true });
  if (offer.oggetto) addMergedRow(`Oggetto: ${offer.oggetto}`, 17, 'FFE8EDF3', { size: 9.5 });
  addMergedRow(`Data: ${dateStr}`, 15, 'FFE8EDF3', { size: 9, color: { argb: 'FF6B7280' } });
  ws.addRow([]).height = 6;

  // ── Header tabella voci ───────────────────────────────────────────────────────
  const COLS = ['Codice', 'Descrizione', 'UM', 'Quantità', 'Prezzo rif.', 'Prezzo offerta', 'Importo offerta'];
  const hRow = ws.addRow(['', ...COLS]);
  hRow.height = 22;
  hRow.eachCell((cell, col) => {
    if (col < 2) return;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: NAVY };
    cell.font = { bold: true, color: WHITE, size: 9.5, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: col <= 3 ? 'left' : 'right' };
    cell.border = { bottom: { style: 'thin', color: NAVY } };
  });

  // ── Voci ─────────────────────────────────────────────────────────────────────
  let dataRowCount = 0;
  for (const item of (items || [])) {
    if (item.tipo === 'categoria') {
      const r = ws.addRow(['', item.codice || '', item.descrizione || '', '', '', '', '', '']);
      r.height = 20;
      r.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: CAT_BG };
        cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF1E3A5F' } };
        cell.alignment = { vertical: 'middle' };
      });
      r.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      dataRowCount++;
      const even = dataRowCount % 2 === 0;
      const r = ws.addRow([
        '',
        item.codice || '',
        item.descrizione || '',
        item.unita_misura || '',
        fmtEur(item.quantita),
        fmtEur(item.prezzo_ref),
        fmtEur(item.prezzo_offerta),
        fmtEur(item.importo_offerta),
      ]);
      r.height = 18;
      r.eachCell({ includeEmpty: true }, (cell, col) => {
        if (even) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: LIGHT };
        cell.font = { size: 9.5, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: col >= 5 ? 'right' : 'left' };
        if (col >= 6) cell.numFmt = '#,##0.00 "€"';
      });
    }
  }

  // ── Totale ────────────────────────────────────────────────────────────────────
  ws.addRow([]).height = 4;
  const totRow = ws.addRow(['', '', 'TOTALE OFFERTA', '', '', '', '', fmtEur(offer.totale_offerta)]);
  totRow.height = 22;
  totRow.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: NAVY };
    cell.font = { bold: true, color: WHITE, size: 10, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: col >= 5 ? 'right' : 'left' };
    if (col === 8) cell.numFmt = '#,##0.00 "€"';
  });

  const safeName = (offer.nome || 'offerta').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  res.set({
    'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="Offerta_${safeName}.xlsx"`,
    'Cache-Control':       'no-store',
  });
  await wb.xlsx.write(res);
  res.end();
}

module.exports = router;
