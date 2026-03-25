const { Resend } = require('resend');

// FROM configurabile via env — DEVE essere un dominio verificato in Resend.
// Esempio Railway: RESEND_FROM=Palladia <noreply@palladia.net>
// Fallback sicuro per test: usa il dominio Resend (funziona sempre senza DNS).
const FROM = process.env.RESEND_FROM || 'Palladia <onboarding@resend.dev>';

// URL frontend — usato nei link delle email (es. "Apri la dashboard").
// Configura FRONTEND_URL su Railway. Es: https://palladia.net
const APP_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

// Inizializzazione lazy: evita crash al boot se RESEND_API_KEY non è impostata.
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  return new Resend(key);
}

// ─── Template helpers ──────────────────────────────────────────────────────

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:48px 16px;">
  <tr><td align="center">

    <!-- Logo strip sopra la card -->
    <table width="100%" style="max-width:560px;margin-bottom:8px;">
      <tr>
        <td style="padding:0 0 16px 4px;">
          <span style="font-size:15px;font-weight:800;letter-spacing:0.12em;color:#1a1a1a;text-transform:uppercase;">PALLADIA</span>
          <span style="font-size:12px;color:#9ca3af;margin-left:10px;font-weight:400;letter-spacing:0;">Gestione Cantieri</span>
        </td>
      </tr>
    </table>

    <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08),0 8px 24px rgba(0,0,0,0.04);">

      <!-- Hero band -->
      <tr>
        <td style="background:#1a1a1a;padding:36px 40px 32px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;">Palladia</p>
          <h1 style="margin:0;font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">${title}</h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:36px 40px;">
          ${bodyHtml}
        </td>
      </tr>

      <!-- Divider + Footer -->
      <tr>
        <td style="padding:0 40px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="border-top:1px solid #f0f0f0;padding-top:24px;">
              <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.8;">
                Palladia &mdash; Gestione Cantieri e Sicurezza sul Lavoro<br/>
                Hai ricevuto questa email perché hai creato un account su Palladia.<br/>
                Se non sei stato tu, <a href="mailto:info@palladia.net" style="color:#6b7280;">contattaci</a>.
              </p>
            </td></tr>
          </table>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function btn(text, href) {
  return `<a href="${href}" style="display:inline-block;margin-top:28px;padding:14px 32px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:700;letter-spacing:0.01em;">${text}</a>`;
}

// ─── Email: Benvenuto ──────────────────────────────────────────────────────

/**
 * @param {{ to: string, name: string, companyName: string }} opts
 */
async function sendWelcomeEmail({ to, name, companyName }) {
  const firstName = (name || to).split(' ')[0];

  const steps = [
    { n: '1', title: 'Crea il primo cantiere', desc: 'Aggiungi indirizzo, cliente e stato. Puoi creare quanti cantieri vuoi.' },
    { n: '2', title: 'Inserisci i lavoratori', desc: 'Nome e codice fiscale sono sufficienti. I dati sono al sicuro e conformi GDPR.' },
    { n: '3', title: 'Genera il QR per le timbrature', desc: 'Stampa il QR e attaccalo all\'ingresso. I lavoratori timbrano con il telefono, senza app.' },
    { n: '4', title: 'Genera il POS', desc: 'Piano Operativo di Sicurezza in PDF pronto in meno di un minuto, personalizzato per il cantiere.' },
  ].map(s => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;padding-right:16px;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:#1a1a1a;color:#fff;border-radius:50%;font-size:12px;font-weight:800;">${s.n}</span>
            </td>
            <td style="vertical-align:top;">
              <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#1a1a1a;">${s.title}</p>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">${s.desc}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${firstName},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      L'azienda <strong style="color:#1a1a1a;">${companyName}</strong> è attiva su Palladia.
      Puoi iniziare subito a gestire cantieri, lavoratori e timbrature.
    </p>

    <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Come iniziare</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${steps}
    </table>

    ${btn('Apri la dashboard →', `${APP_URL}/dashboard`)}

    <p style="margin:32px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Palladia supporta la gestione digitale delle presenze in cantiere in conformità al D.Lgs.&nbsp;81/2008.
      L'impresa resta responsabile del rispetto delle normative vigenti sulla sicurezza sul lavoro.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Benvenuto su Palladia — ${companyName} è pronta`,
    html: layout(`Benvenuto su Palladia, ${firstName}!`, body),
  });
}

// ─── Email: Reset password (backup — Supabase la gestisce nativamente) ────

/**
 * Non utilizzata di default: Supabase invia già l'email di reset.
 * Disponibile per override manuale se necessario.
 * @param {{ to: string, resetLink: string }} opts
 */
async function sendPasswordResetEmail({ to, resetLink }) {
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Reimposta la tua password</h1>
    <p style="margin:0 0 16px;color:#64748b;font-size:14px;line-height:1.6;">
      Hai richiesto il reset della password per il tuo account Palladia.<br />
      Clicca il pulsante qui sotto per scegliere una nuova password.
      Il link è valido per <strong>60 minuti</strong>.
    </p>
    ${btn('Reimposta password', resetLink)}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">
      Se non hai richiesto il reset, ignora questa email. La tua password non verrà modificata.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Reimposta la tua password — Palladia',
    html: layout('Reimposta password', body),
  });
}

// ─── Email: Alert uscite mancanti ──────────────────────────────────────────

/**
 * Invia un'email agli admin della company con la lista dei lavoratori
 * che non hanno timbrato l'uscita.
 *
 * @param {{ companyId: string, date: string, missingList: Array }} opts
 */
async function sendMissingExitAlert({ companyId, date, missingList }) {
  if (!missingList || missingList.length === 0) return;

  // Fetch admin users della company
  const supabase = require('../lib/supabase');
  const { data: adminUsers } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin']);

  if (!adminUsers || adminUsers.length === 0) return;

  // Recupera email per ogni admin via getUserById (service_role)
  // Preferibile a listUsers() che restituisce TUTTI gli utenti della piattaforma
  const adminEmails = [];
  for (const { user_id } of adminUsers) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(user_id);
      if (user?.email) adminEmails.push(user.email);
    } catch { /* ignora errori singolo utente */ }
  }

  if (adminEmails.length === 0) return;

  const [y, m, d] = date.split('-');
  const dateDisplay = `${d}/${m}/${y}`;

  // Raggruppa per cantiere
  const bySite = new Map();
  for (const item of missingList) {
    const key = item.site_id;
    if (!bySite.has(key)) bySite.set(key, { name: item.site_name, workers: [] });
    bySite.get(key).workers.push(item);
  }

  let siteRows = '';
  for (const [, { name, workers }] of bySite) {
    const workerRows = workers.map(w =>
      `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${esc(w.worker_name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;">${esc(w.fiscal_code)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;">
          ${new Date(w.last_entry_time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}
        </td>
      </tr>`
    ).join('');
    siteRows += `
      <p style="margin:20px 0 6px;font-size:13px;font-weight:700;color:#0f172a;">📍 ${esc(name)}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:8px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Cod. Fiscale</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Ultima entrata</th>
        </tr></thead>
        <tbody>${workerRows}</tbody>
      </table>`;
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">⚠️ Uscite mancanti — ${dateDisplay}</h1>
    <p style="margin:0 0 20px;color:#64748b;font-size:14px;line-height:1.6;">
      I seguenti <strong>${missingList.length} lavoratori</strong> hanno una timbratura di entrata
      senza la corrispondente uscita. Verificare con i diretti interessati.
    </p>
    ${siteRows}
    <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
      Questo alert viene generato automaticamente da Palladia al termine della giornata lavorativa.
      I dati di presenza sono registrati in modo append-only e non modificabili.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   adminEmails,
    subject: `Palladia — ${missingList.length} uscite mancanti del ${dateDisplay}`,
    html: layout(`Alert uscite mancanti — ${dateDisplay}`, body)
  });
}

// ─── Email: Invito team ────────────────────────────────────────────────────

/**
 * @param {{ to: string, companyName: string, inviterName: string, role: string, inviteUrl: string }} opts
 */
async function sendInviteEmail({ to, companyName, inviterName, role, inviteUrl }) {
  const ROLE_LABELS = { admin: 'Amministratore', tech: 'Tecnico', viewer: 'Solo lettura' };
  const roleLabel = ROLE_LABELS[role] || role;

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Sei stato invitato su Palladia</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      <strong style="color:#1a1a1a;">${companyName}</strong> ti ha invitato a unirsi al team
      come <strong style="color:#1a1a1a;">${roleLabel}</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:8px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Dettagli invito</p>
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;min-width:120px;">Azienda</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">${companyName}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Ruolo assegnato</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">${roleLabel}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Invitato da</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">${companyName}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Scadenza</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">48 ore</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${btn('Accetta invito →', inviteUrl)}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Se non conosci ${companyName} o non ti aspettavi questo invito, ignora questa email.<br/>
      Il link è valido per 48 ore e può essere usato una sola volta.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `${companyName} ti ha invitato su Palladia`,
    html: layout(`Invito team — ${companyName}`, body),
  });
}

// ─── Email: Invito Coordinatore CSE ───────────────────────────────────────────

/**
 * @param {{ to, coordinatorName, siteName, siteAddress, coordinatorCompany, accessUrl, expiresAt }} opts
 */
async function sendCoordinatorInviteEmail({ to, coordinatorName, siteName, siteAddress, coordinatorCompany, accessUrl, expiresAt }) {
  const firstName = (coordinatorName || to).split(' ')[0];
  const expDate   = new Date(expiresAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${esc(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Hai ricevuto l'accesso al portale del coordinatore per il cantiere
      <strong style="color:#1a1a1a;">${esc(siteName)}</strong>.
      Potrai visualizzare i documenti, le maestranze e le presenze in tempo reale.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Dettagli cantiere</p>
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;min-width:130px;">Cantiere</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">${esc(siteName)}</td>
            </tr>
            ${siteAddress ? `<tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Indirizzo</td>
              <td style="padding:4px 0;font-size:13px;color:#1a1a1a;">${esc(siteAddress)}</td>
            </tr>` : ''}
            ${coordinatorCompany ? `<tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Tua società</td>
              <td style="padding:4px 0;font-size:13px;color:#1a1a1a;">${esc(coordinatorCompany)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:4px 0;font-size:13px;color:#6b7280;">Accesso valido fino al</td>
              <td style="padding:4px 0;font-size:13px;font-weight:700;color:#1a1a1a;">${expDate}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;font-size:14px;color:#6b7280;line-height:1.6;">
      Il link è personale e sicuro. Non è richiesto alcun account o download.
    </p>

    ${btn('Apri il portale CSE →', accessUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Hai ricevuto questo invito in qualità di Coordinatore della Sicurezza (CSE) ai sensi del D.Lgs.&nbsp;81/2008.
      L'accesso è in sola lettura. Per revocare il tuo accesso, contatta l'impresa che ti ha invitato.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Accesso CSE — Cantiere ${siteName} su Palladia`,
    html: layout(`Portale coordinatore — ${siteName}`, body),
  });
}

// ─── Email: Alert nota coordinatore (all'impresa) ─────────────────────────────

/**
 * Invia email agli admin della company quando un coordinatore aggiunge una nota.
 * @param {{ companyId, siteName, coordinatorName, noteType, content, siteUrl }} opts
 */
async function sendCoordinatorNoteAlert({ companyId, siteName, coordinatorName, noteType, content, siteUrl }) {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Fetch admin users della company
  const supabase = require('../lib/supabase');
  const { data: adminUsers } = await supabase
    .from('company_users').select('user_id, role')
    .eq('company_id', companyId).in('role', ['owner', 'admin']);
  if (!adminUsers || adminUsers.length === 0) return;

  const adminEmails = [];
  for (const { user_id } of adminUsers) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(user_id);
      if (user?.email) adminEmails.push(user.email);
    } catch { /* ignora */ }
  }
  if (adminEmails.length === 0) return;

  const NOTE_LABELS = {
    observation: 'Osservazione',
    request:     'Richiesta',
    approval:    'Approvazione',
    warning:     'Avvertenza',
  };
  const noteLabel = NOTE_LABELS[noteType] || noteType;
  const badgeColor = noteType === 'warning' ? '#ef4444' : noteType === 'approval' ? '#22c55e' : noteType === 'request' ? '#f59e0b' : '#6b7280';

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Nuova nota dal coordinatore</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Il coordinatore <strong style="color:#1a1a1a;">${esc(coordinatorName)}</strong>
      ha aggiunto una nota sul cantiere <strong style="color:#1a1a1a;">${esc(siteName)}</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 10px;">
            <span style="display:inline-block;padding:3px 10px;border-radius:20px;background:${badgeColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">${noteLabel}</span>
          </p>
          <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7;white-space:pre-wrap;">${esc(content)}</p>
        </td>
      </tr>
    </table>

    ${btn('Apri il cantiere →', siteUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Puoi rispondere al coordinatore rientrando nel cantiere su Palladia. Le note sono visibili nella sezione Sicurezza.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to: adminEmails,
    subject: `Palladia — Nota CSE su ${siteName}: ${noteLabel}`,
    html: layout(`Nota coordinatore — ${siteName}`, body),
  });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendMissingExitAlert, sendInviteEmail, sendCoordinatorInviteEmail, sendCoordinatorNoteAlert };
