'use strict';
/**
 * routes/v1/verbale.js
 * Genera il Verbale di Sopralluogo in PDF per il professionista.
 *
 * GET /api/v1/coordinator/:token/verbale          — CSE: verbale del suo cantiere
 * GET /api/v1/coordinator/pro/:token/site/:siteId/verbale — Pro: verbale di un sito
 *
 * Il documento include: data sopralluogo, cantiere, lavoratori presenti,
 * stato compliance documenti, non conformità aperte, note recenti.
 * Generato con Puppeteer in stile Palladia — istituzionale e professionale.
 */

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { coordinatorLimiter } = require('../../middleware/rateLimit');

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

// ── helpers ───────────────────────────────────────────────────────────────────

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}
function isValidToken(t) {
  return typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/i.test(t);
}
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function resolveInvite(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, coordinator_company, expires_at, is_active')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (!data || !data.is_active || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function resolveProSession(token) {
  if (!isValidToken(token)) return null;
  const { data } = await supabase
    .from('coordinator_pro_sessions')
    .select('id, email')
    .eq('token_hash', hashToken(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

async function resolveProInviteForSite(email, siteId) {
  const { data } = await supabase
    .from('site_coordinator_invites')
    .select('id, company_id, site_id, coordinator_name, coordinator_email, coordinator_company, expires_at, is_active')
    .eq('site_id', siteId)
    .eq('coordinator_email', email)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

function complianceStatus(expiry) {
  if (!expiry) return 'not_set';
  const days = (new Date(expiry) - Date.now()) / 86400000;
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'ok';
}

/**
 * Raccoglie tutti i dati per il verbale
 */
async function buildVerbaleData(invite) {
  const [siteRes, workersRes, ncRes, notesRes, companyRes] = await Promise.all([
    supabase.from('sites')
      .select('id, name, address, status, client, start_date')
      .eq('id', invite.site_id).maybeSingle(),
    supabase.from('worksite_workers')
      .select('worker_id')
      .eq('site_id', invite.site_id)
      .eq('company_id', invite.company_id)
      .eq('status', 'active'),
    supabase.from('site_nonconformities')
      .select('id, title, category, severity, status, due_date, created_at')
      .eq('invite_id', invite.id)
      .in('status', ['aperta', 'in_lavorazione'])
      .order('created_at', { ascending: false }),
    supabase.from('site_coordinator_notes')
      .select('id, note_type, content, created_at')
      .eq('invite_id', invite.id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('companies')
      .select('name')
      .eq('id', invite.company_id).maybeSingle(),
  ]);

  // Dettagli lavoratori
  let workers = [];
  if (workersRes.data && workersRes.data.length > 0) {
    const workerIds = workersRes.data.map(r => r.worker_id);
    const { data: wData } = await supabase
      .from('workers')
      .select('id, full_name, fiscal_code, role, qualification, employer_name, safety_training_expiry, health_fitness_expiry')
      .in('id', workerIds)
      .eq('is_active', true);
    workers = (wData || []).map(w => ({
      ...w,
      safety:  complianceStatus(w.safety_training_expiry),
      health:  complianceStatus(w.health_fitness_expiry),
    }));
  }

  return {
    site:    siteRes.data,
    company: companyRes.data,
    workers,
    nc:      ncRes.data || [],
    notes:   notesRes.data || [],
  };
}

/**
 * Genera l'HTML del verbale in stile Palladia — istituzionale e professionale.
 */
function buildVerbaleHtml(invite, data) {
  const today     = new Date();
  const dateStr   = today.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr   = today.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const { site, company, workers, nc, notes } = data;

  const SEVERITY_LABEL = { bassa: 'Bassa', media: 'Media', alta: 'Alta', critica: 'Critica' };
  const SEVERITY_COLOR = { bassa: '#6b7280', media: '#f59e0b', alta: '#f97316', critica: '#ef4444' };
  const CATEGORY_LABEL = { sicurezza: 'Sicurezza', documentale: 'Documentale', operativa: 'Operativa', igiene: 'Igiene' };
  const NOTE_LABEL     = { observation: 'Osservazione', request: 'Richiesta', approval: 'Approvazione', warning: 'Avvertenza' };

  // Compliance stats
  const compliant   = workers.filter(w => w.safety === 'ok' && w.health === 'ok').length;
  const expiring    = workers.filter(w => (w.safety === 'expiring' || w.health === 'expiring') && w.safety !== 'expired' && w.health !== 'expired').length;
  const nonCompliant = workers.filter(w => w.safety === 'expired' || w.health === 'expired').length;
  const incomplete  = workers.length - compliant - expiring - nonCompliant;

  const workerRows = workers.map((w, i) => {
    const safetyColor = w.safety === 'expired' ? '#ef4444' : w.safety === 'expiring' ? '#f59e0b' : w.safety === 'ok' ? '#22c55e' : '#9ca3af';
    const healthColor = w.health === 'expired' ? '#ef4444' : w.health === 'expiring' ? '#f59e0b' : w.health === 'ok' ? '#22c55e' : '#9ca3af';
    const rowBg = i % 2 === 0 ? '#ffffff' : '#f9f9f7';
    return `<tr style="background:${rowBg};">
      <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;border-bottom:1px solid #f0f0ed;">${esc(w.full_name)}</td>
      <td style="padding:8px 10px;font-size:10px;color:#6b7280;border-bottom:1px solid #f0f0ed;font-family:monospace;">${esc(w.fiscal_code)}</td>
      <td style="padding:8px 10px;font-size:10px;color:#6b7280;border-bottom:1px solid #f0f0ed;">${esc(w.qualification || w.role || '—')}</td>
      <td style="padding:8px 10px;font-size:10px;border-bottom:1px solid #f0f0ed;text-align:center;">
        <span style="color:${safetyColor};font-weight:600;">${w.safety_training_expiry ? fmtDateShort(w.safety_training_expiry) : '—'}</span>
      </td>
      <td style="padding:8px 10px;font-size:10px;border-bottom:1px solid #f0f0ed;text-align:center;">
        <span style="color:${healthColor};font-weight:600;">${w.health_fitness_expiry ? fmtDateShort(w.health_fitness_expiry) : '—'}</span>
      </td>
    </tr>`;
  }).join('');

  const ncRows = nc.map((n, i) => {
    const bg    = i % 2 === 0 ? '#ffffff' : '#f9f9f7';
    const color = SEVERITY_COLOR[n.severity] || '#6b7280';
    const statusLabel = n.status === 'aperta' ? 'Aperta' : 'In lavorazione';
    const statusColor = n.status === 'aperta' ? '#ef4444' : '#f59e0b';
    return `<tr style="background:${bg};">
      <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;border-bottom:1px solid #f0f0ed;">${esc(n.title)}</td>
      <td style="padding:8px 10px;font-size:10px;border-bottom:1px solid #f0f0ed;text-align:center;">
        <span style="color:${color};font-weight:700;">${esc(SEVERITY_LABEL[n.severity] || n.severity)}</span>
      </td>
      <td style="padding:8px 10px;font-size:10px;color:#6b7280;border-bottom:1px solid #f0f0ed;">${esc(CATEGORY_LABEL[n.category] || n.category)}</td>
      <td style="padding:8px 10px;font-size:10px;border-bottom:1px solid #f0f0ed;">
        <span style="color:${statusColor};font-weight:600;">${statusLabel}</span>
      </td>
      <td style="padding:8px 10px;font-size:10px;color:#6b7280;border-bottom:1px solid #f0f0ed;">${n.due_date ? fmtDateShort(n.due_date) : '—'}</td>
    </tr>`;
  }).join('');

  const noteItems = notes.map(n => {
    const label = NOTE_LABEL[n.note_type] || n.note_type;
    const noteColor = n.note_type === 'warning' ? '#ef4444' : n.note_type === 'approval' ? '#22c55e' : n.note_type === 'request' ? '#f59e0b' : '#6b7280';
    return `<div style="padding:10px 0;border-bottom:1px solid #f0f0ed;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="font-size:9px;font-weight:700;color:${noteColor};text-transform:uppercase;letter-spacing:0.08em;">${esc(label)}</span>
        <span style="font-size:9px;color:#9ca3af;">${fmtDateShort(n.created_at)}</span>
      </div>
      <p style="margin:0;font-size:10.5px;color:#374151;line-height:1.6;">${esc(n.content)}</p>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    background: #ffffff;
    color: #1a1a1a;
    font-size: 11px;
    line-height: 1.5;
  }
  .doc { padding: 0 16mm; }
  @page { size: A4; margin: 26mm 0 24mm 0; }

  /* Cover */
  .cover {
    height: 247mm;
    background: #1a1a1a;
    padding: 0 16mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .cover-top { padding-top: 14mm; }
  .cover-brand {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #ffffff;
    opacity: 0.5;
    margin-bottom: 32mm;
  }
  .cover-title {
    font-size: 28px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin-bottom: 4mm;
  }
  .cover-subtitle {
    font-size: 13px;
    color: rgba(255,255,255,0.55);
    letter-spacing: 0.01em;
  }
  .cover-bottom {
    padding-bottom: 12mm;
    border-top: 1px solid rgba(255,255,255,0.12);
    padding-top: 8mm;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6mm;
  }
  .cover-field label {
    display: block;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.35);
    margin-bottom: 3px;
  }
  .cover-field span {
    font-size: 11.5px;
    color: #ffffff;
    font-weight: 500;
  }

  /* Sections */
  .section { margin-bottom: 12mm; }
  .section-title {
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #9ca3af;
    border-bottom: 1px solid #e5e5e0;
    padding-bottom: 3mm;
    margin-bottom: 5mm;
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4mm;
    margin-bottom: 8mm;
  }
  .stat-box {
    background: #f8f8f5;
    border: 1px solid #e5e5e0;
    border-radius: 6px;
    padding: 5mm 4mm;
    text-align: center;
  }
  .stat-box .num {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
    margin-bottom: 2px;
  }
  .stat-box .lbl {
    font-size: 8.5px;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  th {
    background: #f8f8f5;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #9ca3af;
    padding: 7px 10px;
    text-align: left;
    border-bottom: 1px solid #e5e5e0;
  }
  .empty-state {
    padding: 10mm 0;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
  }

  /* Firma */
  .firma-section {
    margin-top: 16mm;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10mm;
  }
  .firma-box {
    border-top: 1px solid #1a1a1a;
    padding-top: 3mm;
  }
  .firma-box .lbl {
    font-size: 8.5px;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 700;
  }
  .firma-box .val {
    font-size: 11px;
    color: #1a1a1a;
    margin-top: 2px;
  }
  .firma-space {
    height: 18mm;
    border-bottom: 1px solid #e5e5e0;
    margin-bottom: 3mm;
  }
  .legal-note {
    margin-top: 10mm;
    font-size: 9px;
    color: #9ca3af;
    line-height: 1.7;
    border-top: 1px solid #f0f0ed;
    padding-top: 4mm;
  }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <div class="cover-top">
    <div class="cover-brand">Palladia — Gestione Cantieri</div>
    <div class="cover-title">Verbale di<br/>Sopralluogo</div>
    <div class="cover-subtitle">D.Lgs 81/2008 — Coordinamento della Sicurezza</div>
  </div>
  <div class="cover-bottom">
    <div class="cover-field">
      <label>Cantiere</label>
      <span>${esc(site?.name || site?.address || '—')}</span>
    </div>
    <div class="cover-field">
      <label>Data Sopralluogo</label>
      <span>${dateStr}</span>
    </div>
    <div class="cover-field">
      <label>Indirizzo</label>
      <span>${esc(site?.address || '—')}</span>
    </div>
    <div class="cover-field">
      <label>Impresa</label>
      <span>${esc(company?.name || '—')}</span>
    </div>
    <div class="cover-field">
      <label>Coordinatore</label>
      <span>${esc(invite.coordinator_name)}</span>
    </div>
    ${invite.coordinator_company ? `<div class="cover-field">
      <label>Società</label>
      <span>${esc(invite.coordinator_company)}</span>
    </div>` : ''}
  </div>
</div>

<!-- DOCUMENT BODY -->
<div class="doc">

  <!-- 1. SINTESI SOPRALLUOGO -->
  <div class="section" style="margin-top:12mm;">
    <div class="section-title">1. Sintesi del Sopralluogo</div>
    <div class="stats-grid">
      <div class="stat-box">
        <div class="num" style="color:#1a1a1a;">${workers.length}</div>
        <div class="lbl">Lavoratori</div>
      </div>
      <div class="stat-box">
        <div class="num" style="color:#22c55e;">${compliant}</div>
        <div class="lbl">Conformi</div>
      </div>
      <div class="stat-box">
        <div class="num" style="color:#f59e0b;">${expiring}</div>
        <div class="lbl">In Scadenza</div>
      </div>
      <div class="stat-box">
        <div class="num" style="color:#ef4444;">${nonCompliant}</div>
        <div class="lbl">Non Conformi</div>
      </div>
    </div>
    <table>
      <tr>
        <th style="width:30%;">Voce</th>
        <th>Valore</th>
      </tr>
      <tr style="background:#fff;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Data sopralluogo</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${dateStr} ore ${timeStr}</td>
      </tr>
      <tr style="background:#f9f9f7;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Cantiere</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${esc(site?.name || site?.address || '—')} ${site?.address && site?.name ? '— ' + esc(site.address) : ''}</td>
      </tr>
      <tr style="background:#fff;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Impresa</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${esc(company?.name || '—')}</td>
      </tr>
      <tr style="background:#f9f9f7;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Coordinatore (CSE)</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${esc(invite.coordinator_name)}${invite.coordinator_company ? ' — ' + esc(invite.coordinator_company) : ''}</td>
      </tr>
      <tr style="background:#fff;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Stato cantiere</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${esc(site?.status || '—')}</td>
      </tr>
      ${site?.client ? `<tr style="background:#f9f9f7;">
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;border-bottom:1px solid #f0f0ed;">Committente</td>
        <td style="padding:7px 10px;font-size:11px;border-bottom:1px solid #f0f0ed;">${esc(site.client)}</td>
      </tr>` : ''}
    </table>
  </div>

  <!-- 2. MAESTRANZE PRESENTI -->
  <div class="section">
    <div class="section-title">2. Maestranze — Stato Documentale</div>
    ${workers.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th style="width:28%;">Nominativo</th>
          <th style="width:18%;">Codice Fiscale</th>
          <th>Qualifica</th>
          <th style="text-align:center;">Form. Sicurezza</th>
          <th style="text-align:center;">Idoneità Medica</th>
        </tr>
      </thead>
      <tbody>${workerRows}</tbody>
    </table>` : `<div class="empty-state">Nessun lavoratore assegnato al cantiere.</div>`}
  </div>

  <!-- 3. NON CONFORMITÀ APERTE -->
  <div class="section">
    <div class="section-title">3. Non Conformità in Corso</div>
    ${nc.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th style="width:35%;">Descrizione</th>
          <th style="text-align:center;">Gravità</th>
          <th>Categoria</th>
          <th>Stato</th>
          <th>Scadenza</th>
        </tr>
      </thead>
      <tbody>${ncRows}</tbody>
    </table>` : `<div class="empty-state">Nessuna non conformità aperta.</div>`}
  </div>

  <!-- 4. NOTE DI SOPRALLUOGO -->
  <div class="section">
    <div class="section-title">4. Note del Coordinatore</div>
    ${notes.length > 0 ? noteItems : '<div class="empty-state">Nessuna nota registrata.</div>'}
  </div>

  <!-- 5. FIRMA -->
  <div class="section">
    <div class="section-title">5. Firme</div>
    <div class="firma-section">
      <div>
        <div class="firma-space"></div>
        <div class="firma-box">
          <div class="lbl">Coordinatore della Sicurezza in Fase di Esecuzione</div>
          <div class="val">${esc(invite.coordinator_name)}${invite.coordinator_company ? ' — ' + esc(invite.coordinator_company) : ''}</div>
        </div>
      </div>
      <div>
        <div class="firma-space"></div>
        <div class="firma-box">
          <div class="lbl">Impresa Esecutrice</div>
          <div class="val">${esc(company?.name || '—')}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- NOTE LEGALI -->
  <div class="legal-note">
    Verbale generato tramite Palladia il ${dateStr} alle ore ${timeStr} — D.Lgs 81/2008 e successive modifiche e integrazioni.<br/>
    Documento a valenza formale; la firma del presente costituisce attestazione dell'avvenuto sopralluogo.
    I dati relativi alla formazione e all'idoneità medica sono tratti dal sistema di gestione documentale dell'impresa.
  </div>

</div>
</body>
</html>`;
}

/**
 * Genera il PDF con Puppeteer e lo invia come risposta.
 */
async function renderVerbalePdf(res, invite, data) {
  if (!puppeteer) {
    return res.status(503).json({ error: 'PDF_NOT_AVAILABLE', message: 'Puppeteer non disponibile.' });
  }

  const html = buildVerbaleHtml(invite, data);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const siteName    = (data.site?.name || data.site?.address || 'cantiere').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const dateStr     = new Date().toISOString().split('T')[0];
    const filename    = `verbale-sopralluogo-${siteName}-${dateStr}.pdf`;
    const coordName   = invite.coordinator_name;

    const pdf = await page.pdf({
      format:  'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margin: { top: '26mm', bottom: '24mm', left: '0mm', right: '0mm' },
      headerTemplate: `<div style="box-sizing:border-box;width:100%;height:10mm;display:flex;align-items:center;justify-content:space-between;padding:0 16mm;border-bottom:0.5pt solid #ddd;font-family:Arial,sans-serif;font-size:0;">
        <span style="font-size:9px;font-weight:800;color:#2c2c2c;letter-spacing:0.5pt;">PALLADIA</span>
        <span style="font-size:9px;color:#aaa;">Verbale di Sopralluogo — ${coordName.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>
      </div>`,
      footerTemplate: `<div style="box-sizing:border-box;width:100%;height:9mm;display:flex;align-items:center;justify-content:space-between;padding:0 16mm;border-top:0.5pt solid #ddd;font-family:Arial,sans-serif;font-size:0;">
        <span style="font-size:8.5px;color:#bbb;">D.Lgs 81/2008</span>
        <span style="font-size:8.5px;color:#444;font-weight:700;">Pagina <span class="pageNumber" style="font-size:8.5px;"></span> / <span class="totalPages" style="font-size:8.5px;"></span></span>
        <span style="font-size:8.5px;color:#bbb;">palladia.net</span>
      </div>`,
    });

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':       pdf.length,
    });
    res.end(pdf);
  } catch (err) {
    console.error('[verbale] PDF render error:', err.message);
    res.status(500).json({ error: 'PDF_ERROR', message: err.message });
  } finally {
    if (browser) browser.close().catch(() => {});
  }
}

// ── GET /api/v1/coordinator/:token/verbale ────────────────────────────────────
// CSE: scarica il verbale del suo cantiere
router.get('/coordinator/:token/verbale', coordinatorLimiter, async (req, res) => {
  const invite = await resolveInvite(req.params.token);
  if (!invite) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const data = await buildVerbaleData(invite);
  return renderVerbalePdf(res, invite, data);
});

// ── GET /api/v1/coordinator/pro/:token/site/:siteId/verbale ───────────────────
// Pro: scarica il verbale di un sito specifico
router.get('/coordinator/pro/:token/site/:siteId/verbale', coordinatorLimiter, async (req, res) => {
  const session = await resolveProSession(req.params.token);
  if (!session) return res.status(401).json({ error: 'TOKEN_INVALID_OR_EXPIRED' });

  const invite = await resolveProInviteForSite(session.email, req.params.siteId);
  if (!invite) return res.status(403).json({ error: 'ACCESS_DENIED' });

  const data = await buildVerbaleData(invite);
  return renderVerbalePdf(res, invite, data);
});

module.exports = router;
