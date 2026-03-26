'use strict';
/**
 * routes/v1/siteNotes.js
 * API note cantiere (da Telegram + future fonti web).
 *
 * GET    /api/v1/site-notes           — lista note con signed URL per media
 * GET    /api/v1/site-notes/stats     — statistiche aggregate
 * GET    /api/v1/site-notes/:id       — singola nota
 * GET    /api/v1/site-notes/:id/media — redirect signed URL per scaricare media (1h)
 * DELETE /api/v1/site-notes/:id       — elimina nota
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

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

    const canDelete = ['owner', 'admin'].includes(userRole) || note.author_id === req.user.id;
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
