'use strict';
/**
 * routes/v1/archiveActions.js
 * Fase 2, Scaglione 3 — azioni (download/elimina/revisiona) sulle 2 fonti
 * CDL↔impresa esposte da DocumentArchive (studio_shared_documents,
 * studio_document_requests), utilizzabili sia da un viewer impresa sia da un
 * viewer CDL con lo stesso middleware `verifySupabaseJwt`.
 *
 * `verifySupabaseJwt` ha già un fallback CDL integrato (vedi
 * middleware/verifyJwt.js): un utente studio_users, passando X-Company-Id di
 * un cliente attivo (studio_clients.status='active'), passa l'autenticazione
 * con req.isCdl=true — nessuna nuova logica di auth necessaria qui. Le
 * mutazioni (delete/review) restano riservate al CDL: enforced lato server
 * con `req.isCdl`, non solo nascoste in UI, perché un'impresa col proprio JWT
 * su X-Company-Id = sé stessa passerebbe comunque il middleware.
 *
 * Le route CDL "storiche" sotto /studio/clients/:companyId/... (verifyStudioJwt,
 * in studioFiles.js/studio.js) restano invariate — servono ancora per le
 * azioni di creazione (upload shared-doc, crea richiesta) che non passano da
 * DocumentArchive.
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { reviewDocumentRequestSchema } = require('../../lib/schemas/studio');

const BUCKET = 'site-documents';

router.use(verifySupabaseJwt);

// ── studio_shared_documents ──────────────────────────────────────────────────

router.get('/archive/studio-shared-documents/:id/download', async (req, res) => {
  const { data: doc } = await supabase
    .from('studio_shared_documents')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
  if (!data?.signedUrl) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: data.signedUrl });
});

router.delete('/archive/studio-shared-documents/:id', async (req, res) => {
  if (!req.isCdl) return res.status(403).json({ error: 'CDL_ONLY' });

  const { data: doc } = await supabase
    .from('studio_shared_documents')
    .select('id, file_path')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('studio_id', req.studioId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
  await supabase.from('studio_shared_documents').delete().eq('id', doc.id);
  res.json({ ok: true });
});

// ── studio_document_requests ─────────────────────────────────────────────────
// response_url NON è un path di storage: è un link esterno incollato dal
// cliente (Google Drive/Dropbox/WeTransfer, vedi StudioUpload.tsx) — nessuna
// signed URL da generare, si restituisce as-is.

router.get('/archive/studio-document-requests/:id/download', async (req, res) => {
  const { data: doc } = await supabase
    .from('studio_document_requests')
    .select('response_url')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!doc.response_url) return res.status(404).json({ error: 'NOT_UPLOADED_YET' });
  res.json({ url: doc.response_url });
});

router.patch('/archive/studio-document-requests/:id/review', validate(reviewDocumentRequestSchema), async (req, res) => {
  if (!req.isCdl) return res.status(403).json({ error: 'CDL_ONLY' });

  const { status, reviewer_notes } = req.body || {};
  const VALID = ['reviewed', 'rejected'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });

  const { data, error } = await supabase
    .from('studio_document_requests')
    .update({ status, reviewer_notes: reviewer_notes || null, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('studio_id', req.studioId)
    .select('id, status')
    .single();

  if (error || !data) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  res.json({ ok: true, request: data });
});

router.delete('/archive/studio-document-requests/:id', async (req, res) => {
  if (!req.isCdl) return res.status(403).json({ error: 'CDL_ONLY' });

  const { error, count } = await supabase
    .from('studio_document_requests')
    .delete({ count: 'exact' })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('studio_id', req.studioId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!count) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

module.exports = router;
