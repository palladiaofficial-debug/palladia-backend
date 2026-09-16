'use strict';
// ── Buste Paga ─────────────────────────────────────────────────────────────────
// GET  /api/v1/workers/:workerId/payslips            — lista buste (JWT)
// POST /api/v1/workers/:workerId/payslips            — upload PDF (JWT, multipart)
// PATCH /api/v1/payslips/:id/share                  — condividi con lavoratore (JWT)
// PATCH /api/v1/payslips/:id/unshare                — ritira condivisione (JWT)
// DELETE /api/v1/payslips/:id                       — elimina (JWT)
//
// Endpoint pubblici RIMOSSI — ora in workerArea.js (autenticazione CF obbligatoria)
// ──────────────────────────────────────────────────────────────────────────────

const multer = require('multer');
const crypto = require('crypto');
const { z } = require('zod');
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { auditLog } = require('../../lib/audit');
const { sendPayerAccessEmail } = require('../../services/email');

const PAYER_SESSION_TTL_DAYS = 365; // stesso orizzonte del Portale Professionisti (coordinator_pro_sessions)

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function appUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
}

const payerInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

const BUCKET   = 'site-documents';  // usa il bucket già esistente con prefisso payslips/
const MAX_SIZE = 20 * 1024 * 1024;  // 20 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo PDF accettato per le buste paga'));
  },
});

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function verifyWorker(workerId, companyId) {
  const { data } = await supabase
    .from('workers').select('id').eq('id', workerId).eq('company_id', companyId).maybeSingle();
  return !!data;
}

async function _signedUrl(filePath, expiresIn = 3600) {
  if (!filePath) return null;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, expiresIn);
  return data?.signedUrl ?? null;
}

// ── GET /api/v1/payslips/draft — controllo mirato prima della condivisione ────
// F-187 (AUDIT.md): dopo l'Importazione Intelligente non esisteva un posto
// unico per rivedere TUTTE le buste paga appena importate prima di
// condividerle — solo la scheda di un lavoratore alla volta
// (BustePagaTab.tsx), che per un'azienda con molti lavoratori significa
// entrare in ognuna una per una. Questo endpoint alimenta una schermata
// dedicata (BustePagaCondivisione.tsx): elenco di tutte le buste paga in
// status 'draft' (mai condivise) dell'azienda, col nome del lavoratore già
// risolto, così il controllo "è la persona giusta?" si fa qui invece che
// spulciando Organico. La condivisione resta invariata: sempre un
// PATCH /payslips/:id/share per riga, mai un'azione che scrive stato.
router.get('/payslips/draft', verifySupabaseJwt, async (req, res) => {
  const { data: rows, error } = await supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, file_size, note, created_at')
    .eq('company_id', req.companyId)
    .eq('status', 'draft')
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!rows?.length) return res.json([]);

  const workerIds = [...new Set(rows.map(r => r.worker_id))];
  const { data: workers } = await supabase
    .from('workers').select('id, full_name, is_active').in('id', workerIds).eq('company_id', req.companyId);
  const workerById = Object.fromEntries((workers || []).map(w => [w.id, w]));

  const withNames = rows.map(r => ({
    ...r,
    worker_name:   workerById[r.worker_id]?.full_name || null,
    worker_active: workerById[r.worker_id]?.is_active ?? null,
  }));
  // Il nome del lavoratore si risolve solo dopo la query principale (non è
  // una colonna su payslips) — l'ordinamento per periodo+lavoratore va
  // quindi rifatto qui, non lasciato all'ordine di ritorno di Postgres
  // (altrimenti dentro lo stesso mese i lavoratori escono in un ordine
  // arbitrario, non alfabetico).
  withNames.sort((a, b) =>
    b.period_year - a.period_year ||
    b.period_month - a.period_month ||
    (a.worker_name || '').localeCompare(b.worker_name || '', 'it'));

  res.json(withNames);
});

// ── GET /api/v1/workers/:workerId/payslips ────────────────────────────────────
router.get('/workers/:workerId/payslips', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;
  if (!isUuid(workerId)) return res.status(400).json({ error: 'INVALID_WORKER_ID' });
  if (!(await verifyWorker(workerId, req.companyId)))
    return res.status(403).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('payslips')
    .select('id, period_year, period_month, filename, file_size, status, note, shared_at, acknowledged_at, created_at')
    .eq('company_id', req.companyId)
    .eq('worker_id',  workerId)
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/workers/:workerId/payslips — upload PDF ──────────────────────
router.post(
  '/workers/:workerId/payslips',
  verifySupabaseJwt,
  upload.single('file'),
  async (req, res) => {
    const { workerId } = req.params;
    if (!isUuid(workerId)) return res.status(400).json({ error: 'INVALID_WORKER_ID' });
    if (!(await verifyWorker(workerId, req.companyId)))
      return res.status(403).json({ error: 'WORKER_NOT_FOUND' });

    const { period_year, period_month, note } = req.body;
    const year  = parseInt(period_year,  10);
    const month = parseInt(period_month, 10);

    if (isNaN(year) || year < 2020 || year > 2099)
      return res.status(400).json({ error: 'INVALID_YEAR' });
    if (isNaN(month) || month < 1 || month > 12)
      return res.status(400).json({ error: 'INVALID_MONTH' });
    if (!req.file)
      return res.status(400).json({ error: 'FILE_REQUIRED' });

    // Percorso storage: payslips/<company_id>/<worker_id>/<year>-<month>.pdf
    const safeMo   = String(month).padStart(2, '0');
    const filePath = `payslips/${req.companyId}/${workerId}/${year}-${safeMo}.pdf`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: 'application/pdf',
        upsert:      true,
      });

    if (upErr) {
      console.error('[payslips/upload] storage error:', upErr.message);
      return res.status(500).json({ error: 'STORAGE_ERROR' });
    }

    const { data: row, error: dbErr } = await supabase
      .from('payslips')
      .upsert({
        company_id:   req.companyId,
        worker_id:    workerId,
        uploaded_by:  req.user?.id ?? null,
        period_year:  year,
        period_month: month,
        filename:     req.file.originalname || `busta-paga-${year}-${safeMo}.pdf`,
        file_path:    filePath,
        file_size:    req.file.size,
        status:       'draft',
        note:         note?.trim() || null,
        updated_at:   new Date().toISOString(),
      }, {
        onConflict: 'company_id,worker_id,period_year,period_month',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (dbErr) {
      console.error('[payslips/upload] db error:', dbErr.message);
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    res.status(201).json(row);
  }
);

// ── PATCH /api/v1/payslips/:id/share — condividi con lavoratore ───────────────
router.patch('/payslips/:id/share', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data, error } = await supabase
    .from('payslips')
    .update({ status: 'shared', shared_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', req.companyId)
    .neq('status', 'acknowledged')  // non si ritira una busta già firmata
    .select('id');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ── PATCH /api/v1/payslips/:id/unshare — ritira condivisione ─────────────────
router.patch('/payslips/:id/unshare', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data, error } = await supabase
    .from('payslips')
    .update({ status: 'draft', shared_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('company_id', req.companyId)
    .eq('status', 'shared')  // solo shared → draft, non acknowledged
    .select('id');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ── GET /api/v1/payslips/:id/download ─────────────────────────────────────────
// Non esisteva un endpoint di download lato-azienda (solo elimina) — l'helper
// _signedUrl era già scritto ma mai collegato a nessuna route. Stessa forma
// degli altri endpoint di download (site/company/worker/subcontractor/certificates).
router.get('/payslips/:id/download', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!row.file_path) return res.status(404).json({ error: 'NO_FILE' });

  const url = await _signedUrl(row.file_path);
  if (!url) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url });
});

// ── GET /api/v1/payslips/shared — tutte le buste condivise, con stato pagamento
// Alimenta la schermata "Pagamenti" lato azienda (stessi dati visti da chi fa
// i bonifici sul suo link, vedi routes/v1/payerArea.js) — solo shared/
// acknowledged, mai draft (non ancora revisionate internamente).
router.get('/payslips/shared', verifySupabaseJwt, async (req, res) => {
  const { data: rows, error } = await supabase
    .from('payslips')
    .select('id, worker_id, period_year, period_month, filename, status, payment_status, paid_at, paid_by, shared_at')
    .eq('company_id', req.companyId)
    .in('status', ['shared', 'acknowledged'])
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!rows?.length) return res.json([]);

  const workerIds = [...new Set(rows.map(r => r.worker_id))];
  const { data: workers } = await supabase
    .from('workers').select('id, full_name, is_active').in('id', workerIds).eq('company_id', req.companyId);
  const workerById = Object.fromEntries((workers || []).map(w => [w.id, w]));

  const withNames = rows.map(r => ({
    ...r,
    worker_name:   workerById[r.worker_id]?.full_name || null,
    worker_active: workerById[r.worker_id]?.is_active ?? null,
  }));
  // Il nome del lavoratore si risolve solo dopo la query principale (non è
  // una colonna su payslips) — l'ordinamento per periodo+lavoratore va
  // quindi rifatto qui, non lasciato all'ordine di ritorno di Postgres
  // (altrimenti dentro lo stesso mese i lavoratori escono in un ordine
  // arbitrario, non alfabetico).
  withNames.sort((a, b) =>
    b.period_year - a.period_year ||
    b.period_month - a.period_month ||
    (a.worker_name || '').localeCompare(b.worker_name || '', 'it'));

  res.json(withNames);
});

// ── PATCH /api/v1/payslips/:id/mark-paid — segna pagata (lato azienda) ───────
router.patch('/payslips/:id/mark-paid', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data, error } = await supabase
    .from('payslips')
    .update({ payment_status: 'pagata', paid_at: new Date().toISOString(), paid_by: 'company' })
    .eq('id', id).eq('company_id', req.companyId)
    .select('id');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ── PATCH /api/v1/payslips/:id/mark-unpaid — annulla (lato azienda) ──────────
router.patch('/payslips/:id/mark-unpaid', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data, error } = await supabase
    .from('payslips')
    .update({ payment_status: 'da_pagare', paid_at: null, paid_by: null })
    .eq('id', id).eq('company_id', req.companyId)
    .select('id');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ── GET /api/v1/payslips/payer-sessions — chi ha accesso per pagare ──────────
// Sostituisce company_payer_access (migrazione 215, AUDIT.md F-204 e
// seguenti): niente più link+PIN da rigenerare e ricopiare a mano — un
// invito via email diretta, più inviti allo stesso indirizzo restano tutti
// validi. Non torna mai il token (solo l'hash esiste lato server).
router.get('/payslips/payer-sessions', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('payslip_payer_sessions')
    .select('id, email, created_at, last_used_at, expires_at, revoked_at')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/payslips/payer-invite — invia l'accesso via email ───────────
// Il token in chiaro non torna MAI nella risposta HTTP: va SOLO nell'email
// inviata all'indirizzo indicato (services/email.js::sendPayerAccessEmail),
// stesso principio del magic link del Portale Professionisti
// (coordinator_pro_sessions, routes/v1/coordinatorPro.js) — a differenza del
// vecchio PIN qui non c'è nessun valore da ricopiare a mano su un altro
// canale: chi lo riceve clicca e basta, l'unico modo di procurarsi un link
// valido è essere il destinatario reale di quella email.
router.post('/payslips/payer-invite', verifySupabaseJwt, validate(payerInviteSchema), async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono invitare chi paga.' });
  }
  const { email } = req.body;

  const { data: company } = await supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle();

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PAYER_SESSION_TTL_DAYS * 86400000).toISOString();

  const { error } = await supabase.from('payslip_payer_sessions').insert({
    company_id: req.companyId, email, token_hash: hashToken(token), expires_at: expiresAt,
  });
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  try {
    await sendPayerAccessEmail({
      to: email, companyName: company?.name || 'La tua azienda',
      accessUrl: `${appUrl()}/pagamenti/${token}`,
    });
  } catch (err) {
    console.error('[payslips/payer-invite] invio email fallito:', err.message);
    return res.status(502).json({ error: 'EMAIL_FAILED', message: 'Accesso creato ma l\'invio dell\'email è fallito. Riprova.' });
  }

  auditLog({
    companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
    action: 'payslips.payer_invited', targetType: 'company', targetId: req.companyId,
    payload: { email }, req,
  });

  res.json({ ok: true, email });
});

// ── POST /api/v1/payslips/payer-sessions/:id/revoke — revoca un accesso ──────
router.post('/payslips/payer-sessions/:id/revoke', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data, error } = await supabase
    .from('payslip_payer_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', req.companyId)
    .select('id, email');
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });

  auditLog({
    companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
    action: 'payslips.payer_access_revoked', targetType: 'payslip_payer_sessions', targetId: id,
    payload: { email: data[0].email }, req,
  });

  res.json({ ok: true });
});

// ── DELETE /api/v1/payslips/:id ───────────────────────────────────────────────
router.delete('/payslips/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'INVALID_ID' });

  const { data: row } = await supabase
    .from('payslips')
    .select('file_path')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

  if (row.file_path) {
    await supabase.storage.from(BUCKET).remove([row.file_path]);
  }

  const { error } = await supabase
    .from('payslips')
    .delete()
    .eq('id', id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

module.exports = router;
