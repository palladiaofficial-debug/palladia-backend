'use strict';
// ── Importazione massiva documenti (zip → chat) ─────────────────────────────
// POST /api/v1/chat/bulk-import — SSE streaming (text/event-stream)
// Body: { upload_ids: string[] }
// Events: {type:'start',total} | {type:'progress',index,total,name,status,detail}
//         | {type:'done',archived,review,errors,reviewItems} | {type:'error',message}
//
// Riusa la stessa AI (analyzeChatUpload) e la stessa archiviazione
// (archiveChatUpload) dei tool agentic di Ladia in chat.js — qui però il
// flusso è pilotato dal server, non dall'LLM: ogni file viene analizzato,
// il lavoratore/cantiere viene risolto per fuzzy-match, e si archivia SOLO
// se la corrispondenza è abbastanza sicura. Altrimenti il file resta non
// archiviato e va in revisione manuale — un errore di archiviazione
// automatica su un documento di compliance è peggio di un file da rivedere
// a mano.
// ─────────────────────────────────────────────────────────────────────────────

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { chatLimiter } = require('../../middleware/rateLimit');
const { checkAiBudget } = require('../../lib/ladiaUsageLog');
const { analyzeChatUpload, archiveChatUpload } = require('../../services/chatDocumentAnalysis');
const { bestMatch } = require('../../lib/fuzzyMatch');

const MAX_UPLOADS   = 300;
const CONCURRENCY   = 3;   // chiamate Claude Vision in parallelo — non travolgere rate limit/costo
const WORKER_MATCH_THRESHOLD = 55;
const SITE_MATCH_THRESHOLD   = 55;

router.post('/chat/bulk-import', verifySupabaseJwt, chatLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const uploadIds = Array.isArray(req.body?.upload_ids)
    ? req.body.upload_ids.filter(id => typeof id === 'string' && id.length > 0).slice(0, MAX_UPLOADS)
    : [];
  if (uploadIds.length === 0) {
    return res.status(400).json({ error: 'UPLOAD_IDS_REQUIRED' });
  }

  const budget = await checkAiBudget(req.companyId);
  if (!budget.allowed) {
    return res.status(403).json({
      error:   'AI_BUDGET_EXCEEDED',
      message: `Budget AI mensile del piano (${budget.plan}) superato: $${budget.spend.toFixed(2)} su $${budget.limit}.`,
      plan: budget.plan, limit: budget.limit, spend: budget.spend, resets_at: budget.resetsAt,
    });
  }

  const { data: uploadRows } = await supabase
    .from('chat_uploads')
    .select('id, original_name, archived')
    .in('id', uploadIds)
    .eq('company_id', req.companyId);
  const validIds = (uploadRows || []).filter(u => !u.archived).map(u => u.id);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'NESSUN_FILE_VALIDO' });
  }

  // SSE headers — stesso pattern di /chat/stream
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  const companyId = req.companyId;
  const userId    = req.user.id;

  // Carica UNA volta lavoratori e cantieri attivi dell'azienda — usati per il
  // matching di ogni singolo documento, non serve riquery per ogni file.
  const [{ data: workers }, { data: sites }] = await Promise.all([
    supabase.from('workers').select('id, full_name').eq('company_id', companyId).eq('is_active', true),
    supabase.from('sites').select('id, name').eq('company_id', companyId).neq('status', 'chiuso'),
  ]);
  const workerCandidates = (workers || []).map(w => ({ id: w.id, name: w.full_name }));
  const siteCandidates   = (sites   || []).map(s => ({ id: s.id, name: s.name }));

  const total = validIds.length;
  send({ type: 'start', total });

  let archivedCount = 0, reviewCount = 0, errorCount = 0;
  const reviewItems = [];

  async function processOne(uploadId, index) {
    if (aborted) return;
    const upload = uploadRows.find(u => u.id === uploadId);
    const name   = upload?.original_name || uploadId;

    try {
      const analysis = await analyzeChatUpload({ uploadId, companyId, userId });

      if (analysis?.error) {
        errorCount++;
        reviewItems.push({ upload_id: uploadId, name, reason: analysis.error });
        send({ type: 'progress', index, total, name, status: 'error', detail: analysis.error });
        return;
      }
      if (analysis?.non_analizzabile || !analysis?.doc_type || analysis.doc_type === 'altro') {
        reviewCount++;
        reviewItems.push({ upload_id: uploadId, name, reason: 'Tipo documento non riconosciuto con certezza' });
        send({ type: 'progress', index, total, name, status: 'review', detail: 'Da controllare manualmente' });
        return;
      }

      let siteId = null, workerId = null;
      if (analysis.destination === 'site_documents') {
        const m = bestMatch(analysis.cantiere_hint, siteCandidates, 'name', SITE_MATCH_THRESHOLD);
        if (!m) {
          reviewCount++;
          reviewItems.push({ upload_id: uploadId, name, reason: `Cantiere non riconosciuto ("${analysis.cantiere_hint || 'non indicato'}")` });
          send({ type: 'progress', index, total, name, status: 'review', detail: 'Cantiere non riconosciuto' });
          return;
        }
        siteId = m.id;
      } else if (analysis.destination === 'worker_documents' || analysis.destination === 'worker_certificates') {
        const m = bestMatch(analysis.worker_name, workerCandidates, 'name', WORKER_MATCH_THRESHOLD);
        if (!m) {
          reviewCount++;
          reviewItems.push({ upload_id: uploadId, name, reason: `Lavoratore non riconosciuto ("${analysis.worker_name || 'non indicato'}")` });
          send({ type: 'progress', index, total, name, status: 'review', detail: 'Lavoratore non riconosciuto' });
          return;
        }
        workerId = m.id;
      }

      const result = await archiveChatUpload({
        uploadId, companyId, userId,
        destination:  analysis.destination,
        name:         analysis.name || name,
        siteId, workerId,
        category:     analysis.doc_type,
        expiryDate:   analysis.expiry_date,
        issueDate:    analysis.issue_date,
        issuingBody:  analysis.issuing_body,
        req,
      });

      if (result?.error) {
        errorCount++;
        reviewItems.push({ upload_id: uploadId, name, reason: result.error });
        send({ type: 'progress', index, total, name, status: 'error', detail: result.error });
        return;
      }

      archivedCount++;
      send({ type: 'progress', index, total, name, status: 'archived', detail: result.messaggio, destination: analysis.destination });
    } catch (err) {
      errorCount++;
      reviewItems.push({ upload_id: uploadId, name, reason: err.message });
      send({ type: 'progress', index, total, name, status: 'error', detail: err.message });
    }
  }

  // Concorrenza limitata: processa a blocchi di CONCURRENCY file alla volta.
  let cursor = 0, i = 0;
  while (cursor < validIds.length && !aborted) {
    const batch = validIds.slice(cursor, cursor + CONCURRENCY);
    await Promise.all(batch.map((id) => processOne(id, i++)));
    cursor += CONCURRENCY;
  }

  send({ type: 'done', archived: archivedCount, review: reviewCount, errors: errorCount, reviewItems });
  res.end();
});

module.exports = router;
