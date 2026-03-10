'use strict';
// ── Accesso ASL / Ispettori Esterni ──────────────────────────────────────────
// Endpoint privati (JWT) per generare link temporanei firmati:
//   POST   /api/v1/sites/:siteId/asl-token    — genera link accesso
//   GET    /api/v1/sites/:siteId/asl-tokens   — lista token del cantiere
//   DELETE /api/v1/asl-tokens/:tokenId        — revoca token
//
// Endpoint pubblici (token firmato nel path):
//   GET    /api/v1/asl/:token                 — scarica PDF presenze
//   GET    /api/v1/asl/:token?format=csv      — scarica CSV presenze
//   GET    /api/v1/asl/:token?format=info     — metadata (per pagina HTML asl.html)
// ─────────────────────────────────────────────────────────────────────────────
const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }           = require('../../middleware/verifyJwt');
const { aslLimiter }                  = require('../../middleware/rateLimit');
const { auditLog }                    = require('../../lib/audit');
const { buildDailyPresenceSummary,
        generatePresenceReportHtml }  = require('../../services/presenceReport');
const { rendererPool }                = require('../../pdf-renderer');

// TTL default 30 giorni (configurabile via env ASL_TOKEN_TTL_DAYS)
const ASL_TTL_DAYS_DEFAULT = Math.max(1, Math.min(365,
  parseInt(process.env.ASL_TOKEN_TTL_DAYS || '30', 10)
));

function generateAslToken() {
  return crypto.randomBytes(32).toString('hex');  // 64 hex chars
}

function hashAslToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── POST /api/v1/sites/:siteId/asl-token — genera link accesso (PRIVATO) ─────
// body: { label?, from_date, to_date, ttl_days? }
router.post('/sites/:siteId/asl-token', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { label, from_date, to_date, ttl_days } = req.body;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from_date || !to_date || !dateRe.test(from_date) || !dateRe.test(to_date)) {
    return res.status(400).json({ error: 'from_date e to_date obbligatori (YYYY-MM-DD)' });
  }
  if (from_date > to_date) {
    return res.status(400).json({ error: 'from_date deve essere <= to_date' });
  }

  // Verifica ownership cantiere (no cross-company)
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const ttl       = Math.min(Math.max(Number(ttl_days) || ASL_TTL_DAYS_DEFAULT, 1), 365);
  const expiresAt = new Date(Date.now() + ttl * 86_400_000).toISOString();
  const rawToken  = generateAslToken();
  const tokenHash = hashAslToken(rawToken);
  const tokenLabel = label
    ? String(label).trim().slice(0, 200)
    : `Presenze ${from_date} → ${to_date}`;

  const { data: tokenRow, error: insertErr } = await supabase
    .from('asl_access_tokens')
    .insert([{
      company_id: req.companyId,
      site_id:    siteId,
      token_hash: tokenHash,
      label:      tokenLabel,
      from_date,
      to_date,
      expires_at: expiresAt,
      created_by: req.user?.id || null
    }])
    .select('id, label, from_date, to_date, expires_at')
    .single();

  if (insertErr) return res.status(500).json({ error: 'TOKEN_CREATE_ERROR' });

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const url = `${appBase}/asl/${rawToken}`;

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'asl_token.create',
    targetType: 'site',
    targetId:   siteId,
    payload:    { label: tokenLabel, from_date, to_date, expires_at: expiresAt, token_id: tokenRow.id },
    req
  });

  res.status(201).json({
    ok:         true,
    token_id:   tokenRow.id,
    url,
    label:      tokenRow.label,
    from_date:  tokenRow.from_date,
    to_date:    tokenRow.to_date,
    expires_at: tokenRow.expires_at,
    ttl_days:   ttl
  });
});

// ── GET /api/v1/sites/:siteId/asl-tokens — lista token del cantiere (PRIVATO) ─
router.get('/sites/:siteId/asl-tokens', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site, error: sErr } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (sErr || !site) return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const { data, error } = await supabase
    .from('asl_access_tokens')
    .select('id, label, from_date, to_date, expires_at, used_count, last_used_at, revoked_at, created_at')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const now = new Date();
  res.json(data.map(t => ({
    ...t,
    is_active: !t.revoked_at && new Date(t.expires_at) > now
  })));
});

// ── DELETE /api/v1/asl-tokens/:tokenId — revoca token (PRIVATO) ──────────────
router.delete('/asl-tokens/:tokenId', verifySupabaseJwt, async (req, res) => {
  const { tokenId } = req.params;

  const { data, error } = await supabase
    .from('asl_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('company_id', req.companyId)
    .select('id, site_id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'asl_token.revoke',
    targetType: 'asl_token',
    targetId:   tokenId,
    payload:    { site_id: data.site_id },
    req
  });

  res.json({ ok: true });
});

// ── GET /api/v1/asl/:token — accesso pubblico con token ASL ──────────────────
// format=info  → JSON con metadata (per la pagina HTML asl.html)
// format=csv   → CSV presenze scaricabile
// format=pdf   → PDF presenze (default)
router.get('/asl/:token', aslLimiter, async (req, res) => {
  const { token } = req.params;
  const { format = 'pdf' } = req.query;

  if (typeof token !== 'string' || token.length !== 64) {
    return res.status(400).json({ error: 'TOKEN_INVALID' });
  }

  const tokenHash = hashAslToken(token);
  const now       = new Date();

  const { data: tokenRow, error: tErr } = await supabase
    .from('asl_access_tokens')
    .select('id, company_id, site_id, from_date, to_date, expires_at, revoked_at, label')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (tErr)              return res.status(500).json({ error: 'DB_ERROR' });
  if (!tokenRow)         return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  if (tokenRow.revoked_at)                 return res.status(403).json({ error: 'TOKEN_REVOKED' });
  if (new Date(tokenRow.expires_at) < now) return res.status(403).json({ error: 'TOKEN_EXPIRED' });

  // Aggiorna last_used_at + incremento used_count (best-effort via RPC)
  supabase.rpc('increment_asl_usage', { p_token_id: tokenRow.id }).then(() => {});

  // ── Info only (per la pagina HTML) ──────────────────────────────────────
  if (format === 'info') {
    const { data: site } = await supabase
      .from('sites')
      .select('id, name, address')
      .eq('id', tokenRow.site_id)
      .maybeSingle();

    return res.json({
      site,
      from_date:  tokenRow.from_date,
      to_date:    tokenRow.to_date,
      label:      tokenRow.label,
      expires_at: tokenRow.expires_at
    });
  }

  // ── Build dati (comune a CSV e PDF) ─────────────────────────────────────
  let reportData;
  try {
    reportData = await buildDailyPresenceSummary(
      tokenRow.site_id,
      tokenRow.company_id,
      tokenRow.from_date,
      tokenRow.to_date
    );
  } catch (err) {
    console.error('[asl] data error:', err.message);
    return res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }

  const fileBase = `presenze-asl-${tokenRow.from_date}-${tokenRow.to_date}`;

  // ── CSV ──────────────────────────────────────────────────────────────────
  if (format === 'csv') {
    const csvRows = [
      'data,lavoratore,codice_fiscale,prima_entrata,ultima_uscita,ore_totali,n_ingressi,distanza_media_m,gps_media_m,anomalie'
    ];

    for (const r of reportData.rows) {
      csvRows.push([
        r.dateKey,
        `"${r.worker_name.replace(/"/g, '""')}"`,
        r.fiscal_code,
        r.first_entry  || '',
        r.last_exit    || '',
        r.hours_total  != null ? r.hours_total.toFixed(2) : '',
        r.intervals_count ?? '',
        r.avg_distance_m  ?? '',
        r.avg_accuracy_m  ?? '',
        `"${(r.anomalies || []).join('; ').replace(/"/g, '""')}"`
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
    return res.send('\uFEFF' + csvRows.join('\r\n'));
  }

  // ── PDF (default) ────────────────────────────────────────────────────────
  const html = generatePresenceReportHtml(reportData);
  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `Registro Presenze — ${reportData.site.name}`,
      rev: 1
    });
  } catch (renderErr) {
    console.error('[asl] render error:', renderErr.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

module.exports = router;
