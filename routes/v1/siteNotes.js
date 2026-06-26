'use strict';
/**
 * routes/v1/siteNotes.js
 * API note cantiere.
 *
 * POST   /api/v1/site-notes           — crea nota (testo + foto opzionale)
 * GET    /api/v1/site-notes           — lista note con signed URL per media
 * GET    /api/v1/site-notes/stats     — statistiche aggregate
 * GET    /api/v1/site-notes/:id       — singola nota
 * GET    /api/v1/site-notes/:id/media — redirect signed URL per scaricare media (1h)
 * PATCH  /api/v1/site-notes/:id       — modifica nota
 * DELETE /api/v1/site-notes/:id       — elimina nota
 */

const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { createReminderSchema, patchNoteSchema } = require('../../lib/schemas/siteNotes');

const VALID_CATEGORIES = ['nota','foto','non_conformita','verbale','presenza','incidente','documento','altro'];
const VALID_URGENCIES  = ['normale','alta','critica'];
const MAX_MEDIA_SIZE   = 10 * 1024 * 1024; // 10 MB

const { analyzeDiaryNote } = require('../../services/ladiaMemory');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_SIZE },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('FILE_TYPE_NOT_ALLOWED'), ok);
  },
});

router.use(verifySupabaseJwt);

// Durata signed URL: 1 ora
const SIGNED_URL_TTL = 3600;

/**
 * Aggiunge signed_url a ogni nota che ha un media_path.
 * Esegue le richieste signed URL in parallelo.
 */
async function attachSignedUrls(notes) {
  if (!notes || notes.length === 0) return notes;

  await Promise.all(
    notes.map(async (note) => {
      if (!note.media_path) return;
      try {
        const { data, error } = await supabase.storage
          .from('site-media')
          .createSignedUrl(note.media_path, SIGNED_URL_TTL);
        note.media_signed_url = error ? null : data.signedUrl;
      } catch {
        note.media_signed_url = null;
      }
    })
  );

  return notes;
}

// ── Crea nota (web) ─────────────────────────────────────────
// multipart/form-data: site_id, content, category, urgency, file (opzionale)

router.post('/site-notes',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    try {
      const { companyId } = req;
      const { site_id, content, category = 'nota', urgency = 'normale' } = req.body;

      if (!site_id) return res.status(400).json({ error: 'SITE_ID_REQUIRED' });
      if (!content?.trim() && !req.file)
        return res.status(400).json({ error: 'CONTENT_OR_MEDIA_REQUIRED', message: 'Inserisci almeno un testo o una foto.' });

      // Verifica che il cantiere appartenga alla company
      const { data: site } = await supabase
        .from('sites').select('id').eq('id', site_id).eq('company_id', companyId).maybeSingle();
      if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

      // Upload file se presente
      let media_path = null, media_type = null, media_filename = null, media_size_bytes = null;
      if (req.file) {
        const ext  = path.extname(req.file.originalname || '').toLowerCase() || '.bin';
        const dest = `${companyId}/${site_id}/notes/${Date.now()}${ext}`;
        const { error: upErr } = await supabase.storage
          .from('site-media')
          .upload(dest, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
        if (!upErr) {
          media_path      = dest;
          media_type      = req.file.mimetype;
          media_filename  = req.file.originalname || 'allegato';
          media_size_bytes = req.file.size;
        }
      }

      // Nome autore dal profilo auth
      const { data: authData } = await supabase.auth.admin.getUserById(req.user.id).catch(() => ({ data: null }));
      const author_name = authData?.user?.user_metadata?.full_name || authData?.user?.email || 'App';

      const { data: note, error: insErr } = await supabase
        .from('site_notes')
        .insert({
          company_id:      companyId,
          site_id,
          author_id:       req.user.id,
          author_name,
          source:          'web',
          category:        VALID_CATEGORIES.includes(category) ? category : 'nota',
          content:         content?.trim() || null,
          urgency:         VALID_URGENCIES.includes(urgency)   ? urgency  : 'normale',
          media_path,
          media_type,
          media_filename,
          media_size_bytes,
        })
        .select()
        .maybeSingle();

      if (insErr) throw insErr;

      const [result] = await attachSignedUrls([note]);
      res.status(201).json(result);

      // Analisi asincrona: Ladia cerca aggiornamenti strutturati nella nota
      if (note?.content && note.content.length >= 15) {
        setImmediate(async () => {
          try {
            const { data: siteData } = await supabase
              .from('sites')
              .select('name, start_date, end_date, client')
              .eq('id', site_id)
              .eq('company_id', companyId)
              .maybeSingle();
            await analyzeDiaryNote(companyId, site_id, note.content, siteData);
          } catch (e) {
            console.error('[siteNotes/analyzeDiary]', e.message);
          }
        });
      }
    } catch (err) {
      console.error('[site-notes POST]', err.message);
      res.status(500).json({ error: 'INTERNAL', detail: err.message });
    }
  }
);

// ── Lista note ───────────────────────────────────────────────

router.get('/site-notes', async (req, res) => {
  try {
    const { companyId } = req;
    const {
      siteId, category, urgency, source,
      from, to,
      limit  = 50,
      offset = 0,
    } = req.query;

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    let query = supabase
      .from('site_notes')
      .select('id, site_id, author_name, source, category, content, media_path, media_type, media_filename, media_size_bytes, ai_summary, urgency, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (siteId)   query = query.eq('site_id', siteId);
    if (category) query = query.eq('category', category);
    if (urgency)  query = query.eq('urgency', urgency);
    if (source)   query = query.eq('source', source);
    if (from)     query = query.gte('created_at', from);
    if (to)       query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) throw error;

    const notes = await attachSignedUrls(data || []);
    res.json(notes);
  } catch (err) {
    console.error('[site-notes GET]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Statistiche ──────────────────────────────────────────────

router.get('/site-notes/stats', async (req, res) => {
  try {
    const { companyId } = req;
    const { siteId, from, to } = req.query;
    if (!siteId) return res.status(400).json({ error: 'siteId richiesto' });

    let query = supabase
      .from('site_notes')
      .select('category, urgency')
      .eq('company_id', companyId)
      .eq('site_id', siteId);

    if (from) query = query.gte('created_at', from);
    if (to)   query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) throw error;

    const byCategory = {};
    const byUrgency  = {};
    for (const note of data || []) {
      byCategory[note.category] = (byCategory[note.category] || 0) + 1;
      byUrgency[note.urgency]   = (byUrgency[note.urgency]   || 0) + 1;
    }

    res.json({ total: (data || []).length, by_category: byCategory, by_urgency: byUrgency });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Singola nota ─────────────────────────────────────────────

router.get('/site-notes/:id', async (req, res) => {
  try {
    const { companyId } = req;
    const { id }        = req.params;

    if (id === 'stats') return; // gestito dalla route precedente

    const { data, error } = await supabase
      .from('site_notes')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND' });

    const [note] = await attachSignedUrls([data]);
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Signed URL diretto per media (redirect) ──────────────────
// Utile per <img src="/api/v1/site-notes/:id/media"> nel frontend

router.get('/site-notes/:id/media', async (req, res) => {
  try {
    const { companyId } = req;
    const { id }        = req.params;

    const { data: note, error } = await supabase
      .from('site_notes')
      .select('media_path, media_type')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (error) throw error;
    if (!note || !note.media_path) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });

    const { data: signed, error: signErr } = await supabase.storage
      .from('site-media')
      .createSignedUrl(note.media_path, SIGNED_URL_TTL);

    if (signErr) throw signErr;

    // Redirect al signed URL — il browser carica direttamente da Supabase CDN
    res.redirect(302, signed.signedUrl);
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Promemoria via Telegram ──────────────────────────────────

router.post('/site-notes/:id/reminder', validate(createReminderSchema), async (req, res) => {
  try {
    const { companyId } = req;
    const { id }        = req.params;
    const minutes       = parseInt(req.body?.minutes);

    if (!minutes || minutes < 1 || minutes > 1440)
      return res.status(400).json({ error: 'INVALID_MINUTES', detail: 'minutes deve essere 1-1440' });

    const { data: note } = await supabase
      .from('site_notes')
      .select('id, content, ai_summary')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!note) return res.status(404).json({ error: 'NOT_FOUND' });

    const { data: tgUser } = await supabase
      .from('telegram_users')
      .select('telegram_chat_id')
      .eq('user_id', req.user.id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!tgUser) return res.status(409).json({ error: 'TELEGRAM_NOT_LINKED' });

    const sendAt   = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const noteText = note.ai_summary || note.content || 'Nota cantiere';

    const { error } = await supabase.from('site_note_reminders').insert({
      company_id: companyId,
      note_id:    id,
      user_id:    req.user.id,
      chat_id:    tgUser.telegram_chat_id,
      note_text:  noteText,
      send_at:    sendAt,
    });

    if (error) throw error;

    res.json({ scheduled: true, send_at: sendAt, minutes });
  } catch (err) {
    console.error('[site-notes POST reminder]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Modifica nota ────────────────────────────────────────────

router.patch('/site-notes/:id', validate(patchNoteSchema), async (req, res) => {
  try {
    const { companyId, userRole } = req;
    const { id }                  = req.params;
    const { content, category, urgency } = req.body;

    const { data: note } = await supabase
      .from('site_notes')
      .select('id, author_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!note) return res.status(404).json({ error: 'NOT_FOUND' });

    const canEdit = ['owner', 'admin', 'tech'].includes(userRole) || note.author_id === req.user.id;
    if (!canEdit) return res.status(403).json({ error: 'FORBIDDEN' });

    const updates = {};
    if (content  !== undefined) updates.content  = content;
    if (category !== undefined) updates.category = category;
    if (urgency  !== undefined) updates.urgency  = urgency;

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });

    const { data: updated, error } = await supabase
      .from('site_notes')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .maybeSingle();

    if (error) throw error;
    res.json(updated);
  } catch (err) {
    console.error('[site-notes PATCH]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Elimina nota ─────────────────────────────────────────────

router.delete('/site-notes/:id', async (req, res) => {
  try {
    const { companyId, userRole } = req;
    const { id }                  = req.params;

    const { data: note } = await supabase
      .from('site_notes')
      .select('id, author_id, media_path')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!note) return res.status(404).json({ error: 'NOT_FOUND' });

    const canDelete = ['owner', 'admin', 'tech'].includes(userRole) || note.author_id === req.user.id;
    if (!canDelete) return res.status(403).json({ error: 'FORBIDDEN' });

    // Elimina file dallo storage se presente
    if (note.media_path) {
      await supabase.storage.from('site-media').remove([note.media_path]);
    }

    const { error } = await supabase
      .from('site_notes')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);

    if (error) throw error;

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

module.exports = router;
