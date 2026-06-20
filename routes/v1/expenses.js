'use strict';
const router    = require('express').Router();
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt }    = require('../../middleware/verifyJwt');
const { validate }             = require('../../middleware/validate');
const { aiLimiter }            = require('../../middleware/rateLimit');
const { withAiLimit }          = require('../../lib/concurrencyLimit');
const { createExpenseSchema, updateExpenseSchema, CATEGORIES, PAYMENT_METHODS } = require('../../lib/schemas/expenses');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

router.use(verifySupabaseJwt);

// ── GET /api/v1/expenses — lista spese con filtri ───────────────────────────
router.get('/expenses', async (req, res) => {
  const { from, to, category, paid_by, site_id, payment_method, limit: lim, offset: off } = req.query;

  let q = supabase
    .from('company_expenses')
    .select('*, sites(name)', { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (from)            q = q.gte('expense_date', from);
  if (to)              q = q.lte('expense_date', to);
  if (category)        q = q.eq('category', category);
  if (paid_by)         q = q.eq('paid_by', paid_by);
  if (site_id)         q = q.eq('site_id', site_id);
  if (payment_method)  q = q.eq('payment_method', payment_method);

  q = q.range(Number(off) || 0, (Number(off) || 0) + (Number(lim) || 50) - 1);

  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Signed URL per le ricevute
  const expenses = await Promise.all((data || []).map(async (exp) => {
    if (!exp.receipt_url) return exp;
    const { data: signed } = await supabase.storage
      .from('company-docs').createSignedUrl(exp.receipt_url, 3600);
    return { ...exp, receipt_signed_url: signed?.signedUrl || null };
  }));

  res.json({ expenses, total: count, categories: CATEGORIES, payment_methods: PAYMENT_METHODS });
});

// ── POST /api/v1/expenses — crea spesa ──────────────────────────────────────
router.post('/expenses', validate(createExpenseSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('company_expenses')
    .insert({
      ...req.body,
      company_id: req.companyId,
      created_by: req.user?.id || null,
    })
    .select('*, sites(name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── POST /api/v1/expenses/:id/receipt — upload ricevuta/scontrino ───────────
router.post('/expenses/:id/receipt', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { data: expense } = await supabase
    .from('company_expenses')
    .select('id, receipt_url')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .single();

  if (!expense) return res.status(404).json({ error: 'NOT_FOUND' });

  // Rimuovi vecchia ricevuta se presente
  if (expense.receipt_url) {
    await supabase.storage.from('company-docs').remove([expense.receipt_url]).catch(() => {});
  }

  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const storagePath = `${req.companyId}/expenses/${id}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('company-docs')
    .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

  if (upErr) return res.status(500).json({ error: 'STORAGE_ERROR', detail: upErr.message });

  await supabase.from('company_expenses')
    .update({ receipt_url: storagePath, updated_at: new Date().toISOString() })
    .eq('id', id);

  const { data: signed } = await supabase.storage
    .from('company-docs').createSignedUrl(storagePath, 3600);

  res.json({ ok: true, receipt_url: storagePath, receipt_signed_url: signed?.signedUrl || null });
});

// ── PUT /api/v1/expenses/:id — modifica spesa ──────────────────────────────
router.put('/expenses/:id', validate(updateExpenseSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('company_expenses')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select('*, sites(name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

// ── DELETE /api/v1/expenses/:id ─────────────────────────────────────────────
router.delete('/expenses/:id', async (req, res) => {
  const { data: expense } = await supabase
    .from('company_expenses')
    .select('receipt_url')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (!expense) return res.status(404).json({ error: 'NOT_FOUND' });

  if (expense.receipt_url) {
    await supabase.storage.from('company-docs').remove([expense.receipt_url]).catch(() => {});
  }

  const { error } = await supabase
    .from('company_expenses')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /api/v1/expenses/summary — riepilogo per categoria/mese/pagatore ────
router.get('/expenses/summary', async (req, res) => {
  const { from, to, group_by } = req.query;

  let q = supabase
    .from('company_expenses')
    .select('amount, category, payment_method, paid_by, expense_date, site_id, is_deductible')
    .eq('company_id', req.companyId)
    .order('expense_date');

  if (from) q = q.gte('expense_date', from);
  if (to)   q = q.lte('expense_date', to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const expenses = data || [];
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalDeductible = expenses.filter(e => e.is_deductible).reduce((s, e) => s + Number(e.amount), 0);

  // Per categoria
  const byCategory = {};
  for (const e of expenses) {
    const cat = e.category || 'altro';
    if (!byCategory[cat]) byCategory[cat] = { count: 0, total: 0 };
    byCategory[cat].count++;
    byCategory[cat].total += Number(e.amount);
  }

  // Per metodo di pagamento
  const byMethod = {};
  for (const e of expenses) {
    const m = e.payment_method || 'altro';
    if (!byMethod[m]) byMethod[m] = { count: 0, total: 0 };
    byMethod[m].count++;
    byMethod[m].total += Number(e.amount);
  }

  // Per pagatore
  const byPayer = {};
  for (const e of expenses) {
    const p = e.paid_by || 'Non specificato';
    if (!byPayer[p]) byPayer[p] = { count: 0, total: 0 };
    byPayer[p].count++;
    byPayer[p].total += Number(e.amount);
  }

  // Per mese
  const byMonth = {};
  for (const e of expenses) {
    const m = e.expense_date?.slice(0, 7) || 'sconosciuto';
    if (!byMonth[m]) byMonth[m] = { count: 0, total: 0 };
    byMonth[m].count++;
    byMonth[m].total += Number(e.amount);
  }

  res.json({
    total: Math.round(total * 100) / 100,
    total_deductible: Math.round(totalDeductible * 100) / 100,
    count: expenses.length,
    by_category: byCategory,
    by_payment_method: byMethod,
    by_payer: byPayer,
    by_month: byMonth,
  });
});

// ── GET /api/v1/expenses/export — CSV per commercialista ────────────────────
router.get('/expenses/export', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obbligatori (YYYY-MM-DD)' });

  let q = supabase
    .from('company_expenses')
    .select('*, sites(name)')
    .eq('company_id', req.companyId)
    .gte('expense_date', from)
    .lte('expense_date', to)
    .order('expense_date')
    .order('created_at');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const header = 'Data,Importo,Descrizione,Categoria,Metodo Pagamento,Rif. Pagamento,Pagato da,Fornitore,N. Fattura,Deducibile,Cantiere,Note';
  const rows = (data || []).map(e => {
    const esc = s => `"${String(s || '').replace(/"/g, '""')}"`;
    return [
      esc(e.expense_date),
      esc(Number(e.amount).toFixed(2)),
      esc(e.description),
      esc(e.category),
      esc(e.payment_method),
      esc(e.payment_reference),
      esc(e.paid_by),
      esc(e.supplier),
      esc(e.invoice_number),
      esc(e.is_deductible ? 'Sì' : 'No'),
      esc(e.sites?.name),
      esc(e.notes),
    ].join(',');
  });

  const todayStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="spese_${from}_${to}.csv"`);
  res.send('﻿' + [header, ...rows].join('\r\n'));
});

// ── GET /api/v1/expenses/payers — lista pagatori usati (per autocomplete) ───
router.get('/expenses/payers', async (req, res) => {
  const { data } = await supabase
    .from('company_expenses')
    .select('paid_by')
    .eq('company_id', req.companyId)
    .not('paid_by', 'is', null)
    .order('paid_by');

  const unique = [...new Set((data || []).map(r => r.paid_by).filter(Boolean))];
  res.json(unique);
});

// ── GET /api/v1/expenses/suppliers — lista fornitori usati (per autocomplete)
router.get('/expenses/suppliers', async (req, res) => {
  const { data } = await supabase
    .from('company_expenses')
    .select('supplier')
    .eq('company_id', req.companyId)
    .not('supplier', 'is', null)
    .order('supplier');

  const unique = [...new Set((data || []).map(r => r.supplier).filter(Boolean))];
  res.json(unique);
});

// ═══════════════════════════════════════════════════════════════════════════════
// OCR RICEVUTA — scatta foto → AI estrae importo, data, fornitore, N. fattura
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/expenses/scan', aiLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const { buffer, mimetype } = req.file;
  const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!SUPPORTED.includes(mimetype)) {
    return res.status(400).json({ error: 'INVALID_FILE_TYPE', detail: 'Accettati: jpg, png, webp, pdf' });
  }

  try {
    const base64 = buffer.toString('base64');
    const mediaType = mimetype === 'application/pdf' ? 'application/pdf' : mimetype;
    const sourceType = mimetype === 'application/pdf' ? 'document' : 'image';

    const content = [
      { type: sourceType, source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: `Analizza questa ricevuta/scontrino/fattura ed estrai i dati. Restituisci SOLO JSON valido con questi campi:
{"amount":null,"description":null,"supplier":null,"invoice_number":null,"expense_date":null,"category":null,"payment_method":null}

Regole:
- amount: numero decimale (es. 125.50), senza simbolo €
- expense_date: formato YYYY-MM-DD
- category: una tra [materiali, carburante, utenze, assicurazioni, tasse_contributi, stipendi, affitto, attrezzature, subappalto, consulenze, manutenzione, trasporti, cancelleria, vitto_alloggio, altro] — scegli la più appropriata
- payment_method: una tra [contanti, assegno, bonifico, carta, pos, altro] — deduci dal documento se possibile, altrimenti null
- description: breve descrizione della spesa (max 100 caratteri)
- null per campi non presenti nel documento` },
    ];

    const msg = await withAiLimit(() =>
      getClient().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content }],
      })
    );

    const text  = msg.content[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    const extracted = match ? JSON.parse(match[0]) : {};

    // Verifica duplicato
    let duplicate = null;
    if (extracted.amount && extracted.expense_date) {
      const { data: dup } = await supabase
        .from('company_expenses')
        .select('id, description, supplier, expense_date, amount')
        .eq('company_id', req.companyId)
        .eq('amount', extracted.amount)
        .eq('expense_date', extracted.expense_date)
        .limit(1)
        .maybeSingle();
      if (dup) duplicate = dup;
    }

    res.json({ extracted, duplicate_warning: duplicate });
  } catch (e) {
    console.error('[expenses/scan] OCR error:', e.message);
    res.status(500).json({ error: 'OCR_FAILED', detail: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPESE RICORRENTI — imposta una volta, si ripete ogni mese
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/expenses/recurring', async (req, res) => {
  const { data, error } = await supabase
    .from('company_recurring_expenses')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('description');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/expenses/recurring', async (req, res) => {
  const { amount, description, category, payment_method, paid_by, supplier, day_of_month } = req.body;
  if (!amount || !description) return res.status(400).json({ error: 'amount e description obbligatori' });

  const { data, error } = await supabase
    .from('company_recurring_expenses')
    .insert({
      company_id:     req.companyId,
      amount:         Number(amount),
      description,
      category:       category || 'altro',
      payment_method: payment_method || 'bonifico',
      paid_by:        paid_by || null,
      supplier:       supplier || null,
      day_of_month:   Math.min(28, Math.max(1, Number(day_of_month) || 1)),
      created_by:     req.user?.id || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/expenses/recurring/:id', async (req, res) => {
  const { error } = await supabase
    .from('company_recurring_expenses')
    .update({ is_active: false })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/expenses/recurring/generate', async (req, res) => {
  const { month } = req.body; // YYYY-MM
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month obbligatorio (YYYY-MM)' });
  }

  const { data: recurring } = await supabase
    .from('company_recurring_expenses')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true);

  if (!recurring?.length) return res.json({ generated: 0 });

  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const rows = recurring.map(r => ({
    company_id:     req.companyId,
    amount:         r.amount,
    description:    r.description,
    category:       r.category,
    payment_method: r.payment_method,
    paid_by:        r.paid_by,
    supplier:       r.supplier,
    expense_date:   `${month}-${String(Math.min(r.day_of_month, lastDay)).padStart(2, '0')}`,
    is_deductible:  true,
    notes:          `Generata da spesa ricorrente`,
    created_by:     req.user?.id || null,
  }));

  // Evita duplicati: non generare se esiste già una spesa con stessa descrizione+mese
  const toInsert = [];
  for (const row of rows) {
    const { data: existing } = await supabase
      .from('company_expenses')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('description', row.description)
      .eq('expense_date', row.expense_date)
      .maybeSingle();
    if (!existing) toInsert.push(row);
  }

  if (!toInsert.length) return res.json({ generated: 0, message: 'Spese ricorrenti già generate per questo mese' });

  const { error } = await supabase.from('company_expenses').insert(toInsert);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ generated: toInsert.length });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE CHECK — verifica se una spesa simile esiste già
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/expenses/check-duplicate', async (req, res) => {
  const { amount, expense_date, supplier } = req.body;
  if (!amount || !expense_date) return res.json({ duplicate: null });

  let q = supabase
    .from('company_expenses')
    .select('id, description, supplier, expense_date, amount')
    .eq('company_id', req.companyId)
    .eq('amount', amount)
    .eq('expense_date', expense_date);

  if (supplier) q = q.eq('supplier', supplier);

  const { data } = await q.limit(1).maybeSingle();
  res.json({ duplicate: data || null });
});

module.exports = router;
