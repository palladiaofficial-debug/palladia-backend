'use strict';
const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');
const { coordinatorLimiter } = require('../../middleware/rateLimit');

const BUCKET   = 'site-documents';
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const CATEGORIES = ['pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'altro'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo file non supportato. Usa PDF, immagini o documenti Word.'));
  },
});

function safeName(original) {
  const ext  = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base + ext;
}

// ── Helper: resolve coordinator token ────────────────────────────────────────
async function resolveCoordToken(token) {
  if (typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const now  = new Date().toISOString();
  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, is_active, expires_at')
    .eq('token_hash', hash).maybeSingle();
  if (!data || !data.is_active || data.expires_at < now) return null;
  return data;
}

// ── POST /api/v1/sites/:siteId/documents ─────────────────────────────────────
router.post('/sites/:siteId/documents', verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { siteId }         = req.params;
    const { category = 'altro' } = req.body;

    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'INVALID_CATEGORY' });

    const { data: site } = await supabase
      .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
    if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

    const fileId   = crypto.randomUUID();
    const filename = safeName(req.file.originalname);
    const filePath = `${req.companyId}/${siteId}/${fileId}-${filename}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET).upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false,
      });
    if (storageErr) {
      console.error('[documents] storage upload error:', storageErr.message);
      return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });
    }

    const { data: doc, error: dbErr } = await supabase
      .from('site_documents')
      .insert([{
        company_id:  req.companyId,
        site_id:     siteId,
        name:        req.file.originalname.slice(0, 500),
        category,
        file_path:   filePath,
        file_size:   req.file.size,
        mime_type:   req.file.mimetype,
        uploaded_by: req.user?.id || null,
      }])
      .select('id, name, category, file_size, mime_type, created_at')
      .single();

    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    res.status(201).json({ ok: true, document: doc });
  }
);

// ── GET /api/v1/sites/:siteId/documents ──────────────────────────────────────
// Restituisce file caricati (site_documents) + POS generati (pos_documents), unificati
router.get('/sites/:siteId/documents', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const [{ data: uploaded, error }, { data: posDocs }] = await Promise.all([
    supabase.from('site_documents')
      .select('id, name, category, file_size, mime_type, created_at')
      .eq('site_id', siteId).eq('company_id', req.companyId)
      .order('created_at', { ascending: false }),
    supabase.from('pos_documents')
      .select('id, revision, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const posFormatted = (posDocs || []).map(p => ({
    id:         `pos_${p.id}`,
    pos_id:     p.id,
    name:       `POS — Revisione ${p.revision}`,
    category:   'pos',
    file_size:  null,
    mime_type:  'application/pdf',
    created_at: p.created_at,
    source:     'pos',
  }));

  const all = [...(uploaded || []).map(d => ({ ...d, source: 'upload' })), ...posFormatted]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(all);
});

// ── DELETE /api/v1/documents/:docId ──────────────────────────────────────────
router.delete('/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { docId } = req.params;

  const { data: doc } = await supabase
    .from('site_documents')
    .select('id, file_path')
    .eq('id', docId).eq('company_id', req.companyId).maybeSingle();
  if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([doc.file_path]).catch((e) =>
    console.warn('[documents] storage delete warning:', e.message)
  );

  const { error } = await supabase
    .from('site_documents').delete().eq('id', docId).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ ok: true });
});

// ── GET /api/v1/documents/:docId/download (JWT) ───────────────────────────────
router.get('/documents/:docId/download', verifySupabaseJwt, async (req, res) => {
  const { docId } = req.params;

  const { data: doc } = await supabase
    .from('site_documents')
    .select('id, file_path, name, mime_type')
    .eq('id', docId).eq('company_id', req.companyId).maybeSingle();
  if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(doc.file_path, 3600);
  if (signErr || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });

  res.json({ url: signed.signedUrl, name: doc.name });
});

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINT PUBBLICI — accesso via token coordinatore
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/coordinator/:token/documents ──────────────────────────────────
router.get('/coordinator/:token/documents', coordinatorLimiter, async (req, res) => {
  const invite = await resolveCoordToken(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const [{ data: uploaded, error }, { data: posDocs }] = await Promise.all([
    supabase.from('site_documents')
      .select('id, name, category, file_size, mime_type, created_at')
      .eq('site_id', invite.site_id).eq('company_id', invite.company_id)
      .order('created_at', { ascending: false }),
    supabase.from('pos_documents')
      .select('id, revision, created_at')
      .eq('site_id', invite.site_id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const posFormatted = (posDocs || []).map(p => ({
    id:         `pos_${p.id}`,
    pos_id:     p.id,
    name:       `POS — Revisione ${p.revision}`,
    category:   'pos',
    file_size:  null,
    mime_type:  'application/pdf',
    created_at: p.created_at,
    source:     'pos',
  }));

  const all = [...(uploaded || []).map(d => ({ ...d, source: 'upload' })), ...posFormatted]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(all);
});

// ── GET /api/v1/coordinator/:token/documents/:docId/download ─────────────────
router.get('/coordinator/:token/documents/:docId/download', coordinatorLimiter, async (req, res) => {
  const invite = await resolveCoordToken(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: doc } = await supabase
    .from('site_documents')
    .select('id, file_path, name, mime_type')
    .eq('id', req.params.docId)
    .eq('site_id', invite.site_id)
    .eq('company_id', invite.company_id)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(doc.file_path, 1800); // 30 min for CSE
  if (signErr || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });

  res.json({ url: signed.signedUrl, name: doc.name });
});

// ── GET /api/v1/coordinator/:token/pos/:posId/pdf ────────────────────────────
// Genera e invia il PDF del POS al coordinatore (token-gated, no JWT)
router.get('/coordinator/:token/pos/:posId/pdf', coordinatorLimiter, async (req, res) => {
  const invite = await resolveCoordToken(req.params.token);
  if (!invite) return res.status(404).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const { data: pos } = await supabase
    .from('pos_documents')
    .select('id, revision, content, pos_data')
    .eq('id', req.params.posId)
    .eq('site_id', invite.site_id)
    .maybeSingle();
  if (!pos) return res.status(404).json({ error: 'POS_NOT_FOUND' });

  const { data: site } = await supabase
    .from('sites').select('name').eq('id', invite.site_id).maybeSingle();
  const siteName = (site?.name || 'Cantiere').replace(/[^a-zA-Z0-9]/g, '_');

  try {
    // Lazy require — stessi moduli usati in server.js
    const { generatePosHtml } = require('../../pos-html-generator');
    const { selectSigns }     = require('../../sign-selector');
    const { rendererPool }    = require('../../pdf-renderer');

    const signs     = selectSigns(pos.pos_data || {});
    const html      = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
    const pdfBuffer = await rendererPool.render(html, {
      docTitle: `POS – ${site?.name || 'Cantiere'} – Rev. ${pos.revision}`,
      revision: pos.revision,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="POS-Rev${pos.revision}-${siteName}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[documents] POS pdf for coordinator error:', e.message);
    res.status(500).json({ error: 'PDF_GENERATION_ERROR' });
  }
});

module.exports = router;
