const { Resend } = require('resend');

// FROM configurabile via env — DEVE essere un dominio verificato in Resend.
// Esempio Railway: RESEND_FROM=Palladia <noreply@palladia.net>
// Fallback sicuro per test: usa il dominio Resend (funziona sempre senza DNS).
const FROM = process.env.RESEND_FROM || 'Palladia <onboarding@resend.dev>';

// URL frontend — usato nei link delle email (es. "Apri la dashboard").
// Configura FRONTEND_URL su Railway. Es: https://palladia.net
const APP_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

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
          <span style="font-size:15px;font-weight:800;letter-spacing:0.12em;color:#1a1a1a;text-transform:uppercase;vertical-align:middle;">PALLADIA</span>
          <span style="font-size:12px;color:#9ca3af;margin-left:10px;font-weight:400;letter-spacing:0;vertical-align:middle;">Gestione Cantieri</span>
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

  const supabase = require('../lib/supabase');
  const { filterUserIdsByChannel } = require('../lib/notificationPrefs');
  const { data: adminUsers } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin']);

  if (!adminUsers || adminUsers.length === 0) return;

  const allUserIds = adminUsers.map(u => u.user_id);
  const enabledUserIds = await filterUserIdsByChannel(companyId, allUserIds, 'email');

  const adminEmails = [];
  for (const uid of enabledUserIds) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(uid);
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
async function sendInviteEmail({ to, companyName, _inviterName, role, inviteUrl }) {
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

  const supabase = require('../lib/supabase');
  const { filterUserIdsByChannel } = require('../lib/notificationPrefs');
  const { data: adminUsers } = await supabase
    .from('company_users').select('user_id, role')
    .eq('company_id', companyId).in('role', ['owner', 'admin']);
  if (!adminUsers || adminUsers.length === 0) return;

  const allUserIds = adminUsers.map(u => u.user_id);
  const enabledUserIds = await filterUserIdsByChannel(companyId, allUserIds, 'email');

  const adminEmails = [];
  for (const uid of enabledUserIds) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(uid);
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

  const isUrgent = noteType === 'warning' || noteType === 'request';
  const subjectPrefix = isUrgent ? `[URGENTE] ` : '';

  return getResend().emails.send({
    from: FROM,
    to: adminEmails,
    subject: `${subjectPrefix}Palladia — Nota CSE su ${siteName}: ${noteLabel}`,
    html: layout(`Nota coordinatore — ${siteName}`, body),
  });
}

// ─── Email: Magic link Portale Professionisti ─────────────────────────────────

/**
 * @param {{ to, coordinatorName, coordinatorCompany, accessUrl }} opts
 */
async function sendProMagicLinkEmail({ to, coordinatorName, coordinatorCompany, accessUrl }) {
  const firstName = (coordinatorName || to).split(' ')[0];

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${esc(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Hai richiesto l'accesso al tuo <strong style="color:#1a1a1a;">Portale Professionisti</strong> su Palladia.
      ${coordinatorCompany ? `<br/>Società: <strong style="color:#1a1a1a;">${esc(coordinatorCompany)}</strong>` : ''}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">
            Il link ti darà accesso a <strong style="color:#1a1a1a;">tutti i cantieri</strong> in cui sei registrato
            come coordinatore o tecnico della sicurezza.<br/><br/>
            È valido per <strong style="color:#1a1a1a;">365 giorni</strong> — trattalo come una password.
          </p>
        </td>
      </tr>
    </table>

    ${btn('Accedi al portale →', accessUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Se non hai richiesto questo link, ignora questa email. Nessun account è stato creato e nessuna modifica è stata apportata.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Accesso Portale Professionisti — Palladia',
    html: layout('Portale Professionisti', body),
  });
}

// ─── Email: Rimozione dal team ────────────────────────────────────────────────

/**
 * @param {{ to: string, companyName: string }} opts
 */
async function sendMemberRemovedEmail({ to, companyName }) {
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Accesso rimosso</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Il tuo accesso al team di <strong style="color:#1a1a1a;">${companyName}</strong> su Palladia
      è stato rimosso dal proprietario dell'account.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.7;">
            Non potrai più accedere ai dati, ai cantieri o ai documenti di <strong style="color:#1a1a1a;">${companyName}</strong>.<br/><br/>
            Se ritieni si tratti di un errore, contatta direttamente il proprietario dell'account.
          </p>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Il tuo account Palladia rimane attivo. Puoi continuare a usarlo con altre aziende che ti invitano.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Accesso rimosso — ${companyName} su Palladia`,
    html: layout(`Accesso rimosso — ${companyName}`, body),
  });
}

// ─── Email: Alert Non Conformità (all'impresa) ───────────────────────────────

/**
 * Invia email agli admin quando un coordinatore apre una non conformità.
 * @param {{ companyId, siteName, coordinatorName, severity, category, title, siteUrl }} opts
 */
async function sendNonconformityAlert({ companyId, siteName, coordinatorName, severity, category, title, siteUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const supabase = require('../lib/supabase');
  const { filterUserIdsByChannel } = require('../lib/notificationPrefs');
  const { data: adminUsers } = await supabase
    .from('company_users').select('user_id, role')
    .eq('company_id', companyId).in('role', ['owner', 'admin', 'tech']);
  if (!adminUsers?.length) return;

  const allUserIds = adminUsers.map(u => u.user_id);
  const enabledUserIds = await filterUserIdsByChannel(companyId, allUserIds, 'email');

  const adminEmails = [];
  for (const uid of enabledUserIds) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(uid);
      if (user?.email) adminEmails.push(user.email);
    } catch { /* ignora */ }
  }
  if (!adminEmails.length) return;

  const SEVERITY_LABEL = { bassa: 'Bassa', media: 'Media', alta: 'Alta', critica: 'Critica' };
  const SEVERITY_COLOR = { bassa: '#6b7280', media: '#f59e0b', alta: '#f97316', critica: '#ef4444' };
  const CATEGORY_LABEL = { sicurezza: 'Sicurezza', documentale: 'Documentale', operativa: 'Operativa', igiene: 'Igiene' };

  const sevLabel  = SEVERITY_LABEL[severity]  || severity;
  const sevColor  = SEVERITY_COLOR[severity]  || '#6b7280';
  const catLabel  = CATEGORY_LABEL[category]  || category;

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Non conformità aperta</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Il coordinatore <strong style="color:#1a1a1a;">${esc(coordinatorName)}</strong>
      ha aperto una non conformità sul cantiere <strong style="color:#1a1a1a;">${esc(siteName)}</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 10px;">
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${sevColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">${sevLabel}</span>
          <span style="display:inline-block;margin-left:8px;padding:4px 12px;border-radius:20px;background:#f0f0ec;color:#6b7280;font-size:11px;font-weight:600;">${catLabel}</span>
        </p>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(title)}</p>
      </td></tr>
    </table>

    ${btn('Gestisci la non conformità →', siteUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Aggiorna lo stato della non conformità dalla sezione Sicurezza del cantiere su Palladia.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   adminEmails,
    subject: `Palladia — Non conformità ${sevLabel.toLowerCase()} su ${siteName}`,
    html: layout(`Non conformità — ${siteName}`, body),
  });
}

// ─── Email: Aggiornamento NC (al coordinatore) ────────────────────────────────

/**
 * Notifica il coordinatore quando l'impresa risolve una non conformità.
 * @param {{ to, coordinatorName, siteName, ncTitle, newStatus, resolutionNotes, accessUrl }} opts
 */
async function sendNonconformityUpdate({ to, coordinatorName, siteName, ncTitle, newStatus, resolutionNotes, accessUrl }) {
  const firstName = (coordinatorName || to).split(' ')[0];
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const STATUS_LABEL = { in_lavorazione: 'In lavorazione', risolta: 'Risolta' };
  const STATUS_COLOR = { in_lavorazione: '#f59e0b', risolta: '#22c55e' };
  const statusLabel  = STATUS_LABEL[newStatus]  || newStatus;
  const statusColor  = STATUS_COLOR[newStatus]  || '#6b7280';

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${esc(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      L'impresa ha aggiornato una non conformità sul cantiere
      <strong style="color:#1a1a1a;">${esc(siteName)}</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 8px;">
          <span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${statusColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">${statusLabel}</span>
        </p>
        <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(ncTitle)}</p>
        ${resolutionNotes ? `<p style="margin:0;font-size:13px;color:#374151;line-height:1.6;border-top:1px solid #e5e5e0;padding-top:10px;">${esc(resolutionNotes)}</p>` : ''}
      </td></tr>
    </table>

    ${newStatus === 'risolta' ? `<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Puoi ora verificare la risoluzione e chiudere definitivamente la non conformità dal portale.
    </p>` : ''}

    ${btn('Apri il portale →', accessUrl)}
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Palladia — NC ${statusLabel.toLowerCase()}: ${ncTitle.slice(0, 60)}`,
    html: layout(`Aggiornamento Non Conformità`, body),
  });
}

// ─── Email: Alert scadenze (al professionista) ────────────────────────────────

/**
 * Invia al professionista un riepilogo settimanale dei documenti in scadenza.
 * @param {{ to, coordinatorName, sitesWithIssues: Array<{ siteName, workers }> }} opts
 */
async function sendExpiryAlertPro({ to, coordinatorName, sitesWithIssues }) {
  const firstName = (coordinatorName || to).split(' ')[0];
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  const totalWorkers = sitesWithIssues.reduce((acc, s) => acc + s.workers.length, 0);

  const siteBlocks = sitesWithIssues.map(site => {
    const workerRows = site.workers.map(w => {
      const safetyColor = w.safety_status === 'expired' ? '#ef4444' : '#f59e0b';
      const healthColor = w.health_status === 'expired' ? '#ef4444' : '#f59e0b';
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${esc(w.name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
          ${w.safety_status ? `<span style="color:${safetyColor};font-weight:600;">${fmtDate(w.safety_expiry)}</span>` : '<span style="color:#9ca3af;">ok</span>'}
        </td>
        <td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
          ${w.health_status ? `<span style="color:${healthColor};font-weight:600;">${fmtDate(w.health_expiry)}</span>` : '<span style="color:#9ca3af;">ok</span>'}
        </td>
      </tr>`;
    }).join('');

    return `
      <p style="margin:20px 0 6px;font-size:13px;font-weight:700;color:#1a1a1a;">📍 ${esc(site.siteName)}</p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:8px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Form. Sicurezza</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Idoneità Medica</th>
        </tr></thead>
        <tbody>${workerRows}</tbody>
      </table>`;
  }).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${esc(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Riepilogo settimanale: <strong style="color:#1a1a1a;">${totalWorkers} lavoratori</strong>
      hanno documenti scaduti o in scadenza entro 30 giorni nei cantieri che coordini.
    </p>

    ${siteBlocks}

    ${btn('Accedi al portale →', `${APP_URL}`)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Questo alert viene inviato ogni lunedì. Le date in arancione scadono entro 30 giorni; in rosso sono già scadute.
      Sollecita l'impresa ad aggiornare i documenti.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Palladia — ${totalWorkers} documenti in scadenza nei tuoi cantieri`,
    html: layout('Alert scadenze documenti', body),
  });
}

// ── sendWorkerExpiryAlertCompany ─────────────────────────────────────────────
// Alert giornaliero per owner/admin/tech dell'impresa:
// lavoratori con documenti in scadenza entro 30 giorni.
async function sendWorkerExpiryAlertCompany({ to, companyName, workers, dashboardUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function statusColor(status) {
    return status === 'expired' ? '#ef4444' : '#f59e0b';
  }
  function statusLabel(days) {
    if (days === null) return null;
    if (days < 0)  return `scaduto ${Math.abs(days)}gg fa`;
    if (days === 0) return 'scade oggi';
    return `scade in ${days}gg`;
  }

  const expired  = workers.filter(w => w.safety_status === 'expired' || w.health_status === 'expired').length;
  const expiring = workers.length - expired;

  const rows = workers.map(w => {
    const safetyLabel = w.safety_status ? statusLabel(w.safety_days) : null;
    const healthLabel = w.health_status ? statusLabel(w.health_days) : null;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:500;">${esc(w.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
        ${safetyLabel
          ? `<span style="color:${statusColor(w.safety_status)};font-weight:600;">${fmtDate(w.safety_expiry)}</span><br><span style="font-size:10px;color:${statusColor(w.safety_status)};">${esc(safetyLabel)}</span>`
          : '<span style="color:#9ca3af;">ok</span>'}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
        ${healthLabel
          ? `<span style="color:${statusColor(w.health_status)};font-weight:600;">${fmtDate(w.health_expiry)}</span><br><span style="font-size:10px;color:${statusColor(w.health_status)};">${esc(healthLabel)}</span>`
          : '<span style="color:#9ca3af;">ok</span>'}
      </td>
    </tr>`;
  }).join('');

  const summaryParts = [];
  if (expired  > 0) summaryParts.push(`<span style="color:#ef4444;font-weight:700;">${expired} scaduti</span>`);
  if (expiring > 0) summaryParts.push(`<span style="color:#f59e0b;font-weight:700;">${expiring} in scadenza</span>`);

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Attenzione documenti lavoratori</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Per <strong style="color:#1a1a1a;">${esc(companyName)}</strong> risultano
      ${summaryParts.join(' e ')} tra i tuoi lavoratori.
      Aggiorna i documenti prima della scadenza per restare in conformità.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Form. Sicurezza</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Idoneità Medica</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${btn('Gestisci Lavoratori →', dashboardUrl)}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Questo alert viene inviato ogni mattina quando ci sono documenti scaduti o in scadenza entro 30 giorni.
      Le date in arancione scadono a breve; in rosso sono già scadute.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia — ${expired > 0 ? `${expired} documenti scaduti` : `${expiring} documenti in scadenza`} | ${esc(companyName)}`,
    html:    layout('Documenti lavoratori in scadenza', body),
  });
}

// ── sendWorkerDocExpiryAlert ──────────────────────────────────────────────────
// Alert giornaliero — tutti i tipi di documento lavoratori in scadenza.
async function sendWorkerDocExpiryAlert({ to, companyName, docs, docTypeLabels, dashboardUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function severityColor(s) {
    return s === 'critical' ? '#ef4444' : s === 'warning' ? '#f59e0b' : '#3b82f6';
  }
  function severityLabel(days) {
    if (days === null) return '';
    if (days < 0) return `scaduto ${Math.abs(days)}gg fa`;
    if (days === 0) return 'scade oggi';
    return `scade in ${days}gg`;
  }

  const critical = docs.filter(d => d.severity === 'critical').length;
  const warning  = docs.filter(d => d.severity === 'warning').length;
  const info     = docs.length - critical - warning;

  const rows = docs.map(d => {
    const typeLabel = (docTypeLabels || {})[d.doc_type] || d.doc_type || 'Documento';
    const color     = severityColor(d.severity);
    const label     = severityLabel(d.days);
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(d.worker?.full_name || '')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(typeLabel)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
        <span style="color:${color};font-weight:700;">${fmtDate(d.expiry_date)}</span><br>
        <span style="font-size:10px;color:${color};">${esc(label)}</span>
      </td>
    </tr>`;
  }).join('');

  const summaryParts = [];
  if (critical > 0) summaryParts.push(`<span style="color:#ef4444;font-weight:700;">${critical} scadut${critical === 1 ? 'o' : 'i'}</span>`);
  if (warning  > 0) summaryParts.push(`<span style="color:#f59e0b;font-weight:700;">${warning} in scadenza entro 7 giorni</span>`);
  if (info     > 0) summaryParts.push(`<span style="color:#3b82f6;font-weight:700;">${info} in scadenza entro 30 giorni</span>`);

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Documenti lavoratori in scadenza</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Per <strong style="color:#1a1a1a;">${esc(companyName)}</strong>: ${summaryParts.join(', ')}.
      Rinnova i documenti prima della scadenza per restare in conformità con il D.Lgs. 81/2008.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Tipo documento</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Scadenza</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${btn('Gestisci Lavoratori →', dashboardUrl)}
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Rosso = già scaduto · Arancione = scade entro 7 giorni · Blu = scade entro 30 giorni.<br>
      Alert quotidiano finché i documenti non sono rinnovati.
    </p>
  `;

  const subjectLabel = critical > 0 ? `${critical} documenti scaduti` : `${warning + info} documenti in scadenza`;
  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia — ${subjectLabel} | Lavoratori | ${esc(companyName)}`,
    html:    layout('Documenti lavoratori in scadenza', body),
  });
}

// ── sendEquipmentExpiryAlert ──────────────────────────────────────────────────
// Alert giornaliero — mezzi aziendali con assicurazione/revisione/tagliando in scadenza.
async function sendEquipmentExpiryAlert({ to, companyName, items, dashboardUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function severityColor(s) {
    return s === 'critical' ? '#ef4444' : s === 'warning' ? '#f59e0b' : '#3b82f6';
  }
  function severityLabel(days) {
    if (days === null) return '';
    if (days < 0) return `scaduto ${Math.abs(days)}gg fa`;
    if (days === 0) return 'scade oggi';
    return `scade in ${days}gg`;
  }

  const critical = items.filter(i => i.issues.some(x => x.severity === 'critical')).length;

  const rows = items.flatMap(eq => {
    const name = esc([eq.type, eq.model, eq.plate_or_serial].filter(Boolean).join(' — '));
    return eq.issues.map((issue, idx) => {
      const color = severityColor(issue.severity);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:${idx === 0 ? '700' : '400'};color:${idx === 0 ? '#1a1a1a' : '#9ca3af'};">${idx === 0 ? name : ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(issue.label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
          <span style="color:${color};font-weight:700;">${fmtDate(issue.date)}</span><br>
          <span style="font-size:10px;color:${color};">${esc(severityLabel(issue.days))}</span>
        </td>
      </tr>`;
    });
  }).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Scadenze mezzi aziendali</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Per <strong style="color:#1a1a1a;">${esc(companyName)}</strong>: ${items.length} mezzo/i con scadenze imminenti${critical > 0 ? ` (<span style="color:#ef4444;font-weight:700;">${critical} già scadut${critical === 1 ? 'o' : 'i'}</span>)` : ''}.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Mezzo</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Tipo scadenza</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Data</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${btn('Gestisci Mezzi →', dashboardUrl)}
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Rosso = già scaduto · Arancione = scade entro 7 giorni · Blu = scade entro 30 giorni.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia — Scadenze mezzi aziendali | ${esc(companyName)}`,
    html:    layout('Scadenze mezzi aziendali', body),
  });
}

// ── sendCompanyDocExpiryAlert ─────────────────────────────────────────────────
// Alert giornaliero — documenti aziendali (DURC, DVR, SOA, ecc.) in scadenza.
async function sendCompanyDocExpiryAlert({ to, companyName, docs, categoryLabels, dashboardUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function severityColor(s) {
    return s === 'critical' ? '#ef4444' : s === 'warning' ? '#f59e0b' : '#3b82f6';
  }
  function severityLabel(days) {
    if (days === null) return '';
    if (days < 0) return `scaduto ${Math.abs(days)}gg fa`;
    if (days === 0) return 'scade oggi';
    return `scade in ${days}gg`;
  }

  const critical = docs.filter(d => d.severity === 'critical').length;

  const rows = docs.map(d => {
    const catLabel = (categoryLabels || {})[d.category] || d.category || 'Documento';
    const color    = severityColor(d.severity);
    const renewalNote = d.ai_renewal_years
      ? `<br><span style="font-size:10px;color:#9ca3af;">Rinnovo ogni ${d.ai_renewal_years} ann${d.ai_renewal_years === 1 ? 'o' : 'i'}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(d.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(catLabel)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:center;">
        <span style="color:${color};font-weight:700;">${fmtDate(d.ai_expiry_date)}</span><br>
        <span style="font-size:10px;color:${color};">${esc(severityLabel(d.days))}</span>${renewalNote}
      </td>
    </tr>`;
  }).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Documenti aziendali in scadenza</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Per <strong style="color:#1a1a1a;">${esc(companyName)}</strong>: ${docs.length} documento/i con scadenze imminenti${critical > 0 ? ` (<span style="color:#ef4444;font-weight:700;">${critical} già scadut${critical === 1 ? 'o' : 'i'}</span>)` : ''}.
      Rinnova tempestivamente per mantenere la conformità normativa.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Documento</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Categoria</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Scadenza</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${btn('Gestisci Documenti Aziendali →', dashboardUrl)}
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Rosso = già scaduto · Arancione = scade entro 7 giorni · Blu = scade entro 30 giorni.<br>
      Le date di scadenza sono estratte automaticamente dall'analisi AI dei documenti caricati.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia — Documenti aziendali in scadenza | ${esc(companyName)}`,
    html:    layout('Documenti aziendali in scadenza', body),
  });
}

// ── sendWorkerMissingDocsAlert ────────────────────────────────────────────────
// Alert giornaliero — lavoratori privi di idoneità medica o formazione sicurezza.
async function sendWorkerMissingDocsAlert({ to, companyName, workers, dashboardUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const rows = workers.map(w => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(w.full_name)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#ef4444;">${esc(w.missingTypes.join(', '))}</td>
  </tr>`).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Documenti obbligatori mancanti</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Per <strong style="color:#1a1a1a;">${esc(companyName)}</strong>: ${workers.length} lavorator${workers.length === 1 ? 'e' : 'i'} senza documenti obbligatori per legge (D.Lgs. 81/2008).
      Carica i documenti mancanti al più presto.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#fef2f2;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
        <th style="padding:10px 12px;text-align:left;font-size:11px;color:#ef4444;text-transform:uppercase;letter-spacing:0.05em;">Documenti mancanti</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${btn('Carica i Documenti →', dashboardUrl)}
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Questo alert viene inviato ogni giorno finché i documenti non vengono caricati su Palladia.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia ⚠️ — ${workers.length} lavorator${workers.length === 1 ? 'e' : 'i'} senza documenti obbligatori | ${esc(companyName)}`,
    html:    layout('Documenti obbligatori mancanti', body),
  });
}

// ─── Email: Recupero link CSE ──────────────────────────────────────────────────
async function sendCoordinatorRecoveryEmail({ to, coordinatorName, siteLinks }) {
  const firstName = (coordinatorName || to).split(' ')[0];
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  const linksHtml = siteLinks.map(({ siteName, siteAddress, accessUrl, expiresAt }) => {
    const expDate = new Date(expiresAt).toLocaleDateString('it-IT', { day:'2-digit', month:'long', year:'numeric' });
    return `
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:12px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a1a;">${esc(siteName)}</p>
        ${siteAddress ? `<p style="margin:0 0 10px;font-size:13px;color:#6b7280;">${esc(siteAddress)}</p>` : ''}
        <p style="margin:0 0 14px;font-size:12px;color:#9ca3af;">Accesso valido fino al ${esc(expDate)}</p>
        ${btn('Apri portale CSE →', accessUrl)}
      </td></tr>
    </table>`;
  }).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Ciao ${esc(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Hai richiesto i link di accesso al portale CSE. Di seguito trovi i tuoi cantieri attivi.
    </p>
    ${linksHtml}
    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      I link precedenti sono stati sostituiti con quelli nuovi presenti in questa email.<br>
      Se non hai richiesto questo invio, puoi ignorare questa email.
    </p>`;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `I tuoi link di accesso CSE — Palladia`,
    html: layout('Recupero accesso portale CSE', body),
  });
}

// ─── Email: Attestati in scadenza (Formazione) ─────────────────────────────

/**
 * @param {string} to - email responsabile impresa
 * @param {Array<{workers:{full_name:string}, course_types:{name:string}, expiry_date:string}>} certs
 */
async function sendExpiryAlert(to, certs) {
  const rows = certs.map(c => {
    const days = Math.floor((new Date(c.expiry_date) - Date.now()) / 86_400_000);
    const status = days < 0 ? '🔴 Scaduto' : days < 30 ? '🟠 Critico' : '🟡 In scadenza';
    const dateStr = new Date(c.expiry_date).toLocaleDateString('it-IT');
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;">${c.workers?.full_name || '—'}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${c.course_types?.name || '—'}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${dateStr}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600;">${status}</td>
    </tr>`;
  }).join('');

  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Ci sono <strong>${certs.length} attestat${certs.length > 1 ? 'i' : 'o'}</strong>
      che richiedono attenzione nella tua impresa.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#9ca3af;border-bottom:2px solid #f0f0f0;">Lavoratore</th>
          <th style="text-align:left;padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#9ca3af;border-bottom:2px solid #f0f0f0;">Corso</th>
          <th style="text-align:left;padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#9ca3af;border-bottom:2px solid #f0f0f0;">Scadenza</th>
          <th style="text-align:left;padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#9ca3af;border-bottom:2px solid #f0f0f0;">Stato</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${btn('Vai alla Dashboard Formazione', `${APP_URL}/formazione`)}
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">
      Trova enti di formazione accreditati direttamente su Palladia → Formazione → Marketplace.
    </p>`;

  const resend = getResend();
  await resend.emails.send({
    from:    FROM,
    to,
    subject: `⚠️ ${certs.length} attestat${certs.length > 1 ? 'i' : 'o'} in scadenza su Palladia`,
    html:    layout('Attestati in scadenza', body),
  });
}

// ─── Email: Conferma prenotazione (impresa) ────────────────────────────────

async function sendBookingConfirmation(to, { courseName, providerName, sessionDate, workers, totalCents, bookingIds }) {
  const dateStr  = sessionDate ? new Date(sessionDate).toLocaleDateString('it-IT', { weekday:'long', day:'2-digit', month:'long', year:'numeric' }) : '—';
  const total    = (totalCents / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 });
  const wList    = (workers || []).map(w => `<li style="padding:4px 0;font-size:14px;color:#374151;">${w.worker_name || w.full_name || w}</li>`).join('');

  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      La tua prenotazione è stata confermata. Ecco il riepilogo:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:120px;">Corso</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;font-weight:600;">${courseName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Erogatore</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${providerName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Data</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${dateStr}</td></tr>
      <tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;">Totale</td><td style="padding:10px 0;font-size:15px;color:#1a1a1a;font-weight:700;">€ ${total}</td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">Lavoratori iscritti:</p>
    <ul style="margin:0 0 24px;padding:0 0 0 16px;">${wList}</ul>
    ${btn('Vedi la prenotazione', `${APP_URL}/formazione/prenotazioni?ids=${bookingIds}`)}`;

  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM, to,
      subject: `✅ Prenotazione confermata — ${courseName}`,
      html: layout('Prenotazione confermata', body),
    });
  } catch (e) {
    console.error('[email] sendBookingConfirmation:', e.message);
  }
}

// ─── Email: Nuova prenotazione (consulente) ────────────────────────────────

async function sendBookingConfirmedConsultant(to, { companyName, courseName, participants, totalCents, sessionDate, bookingId }) {
  const dateStr = sessionDate ? new Date(sessionDate).toLocaleDateString('it-IT', { day:'2-digit', month:'long', year:'numeric' }) : '—';
  const total   = (totalCents / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 });
  const payout  = ((totalCents * 0.85) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 });

  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Hai ricevuto una nuova prenotazione da <strong>${companyName}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:130px;">Corso</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;font-weight:600;">${courseName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Data sessione</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${dateStr}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Partecipanti</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(String(participants))}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Totale incassato</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:15px;color:#1a1a1a;font-weight:700;">€ ${esc(String(total))}</td></tr>
      <tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;">Tuo guadagno netto</td><td style="padding:10px 0;font-size:15px;color:#16a34a;font-weight:700;">€ ${esc(String(payout))}</td></tr>
    </table>
    ${btn('Vedi dettaglio prenotazione', `${APP_URL}/consulente/prenotazioni/${bookingId}`)}`;

  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM, to,
      subject: `💼 Nuova prenotazione da ${companyName} — ${courseName}`,
      html: layout('Nuova prenotazione ricevuta', body),
    });
  } catch (e) {
    console.error('[email] sendBookingConfirmedConsultant:', e.message);
  }
}

// ─── Email: Attestati caricati (impresa) ───────────────────────────────────

async function sendCertificatesUploaded(to, { certificates_count, booking_id: _booking_id }) {
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Il tuo consulente ha caricato <strong>${certificates_count} nuov${certificates_count > 1 ? 'i attestati' : 'o attestato'}</strong>
      nella tua area Formazione.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.6;">
      I nuovi attestati sono già visibili nel profilo di ogni lavoratore e la dashboard è stata aggiornata.
    </p>
    ${btn('Vedi i nuovi attestati', `${APP_URL}/formazione`)}`;

  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM, to,
      subject: `🎓 Nuovi attestati caricati dal tuo consulente`,
      html: layout('Attestati aggiornati', body),
    });
  } catch (e) {
    console.error('[email] sendCertificatesUploaded:', e.message);
  }
}

// ─── Email: Promemoria sessione (48h prima) ────────────────────────────────

async function sendSessionReminder(to, { courseName, sessionDate, location, workers }) {
  const dateStr = sessionDate ? new Date(sessionDate).toLocaleString('it-IT', { weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit' }) : '—';
  const wList   = (workers || []).map(w => `<li style="padding:4px 0;font-size:14px;color:#374151;">${w}</li>`).join('');

  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Promemoria: il corso <strong>${courseName}</strong> si svolge domani.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:100px;">Data</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;font-weight:600;">${dateStr}</td></tr>
      ${location ? `<tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;">Luogo</td><td style="padding:10px 0;font-size:14px;color:#374151;">${location}</td></tr>` : ''}
    </table>
    ${wList ? `<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">Lavoratori iscritti:</p><ul style="margin:0 0 24px;padding:0 0 0 16px;">${wList}</ul>` : ''}
    ${btn('Vedi la prenotazione', `${APP_URL}/formazione/prenotazioni`)}`;

  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM, to,
      subject: `⏰ Promemoria corso domani — ${courseName}`,
      html: layout('Promemoria sessione', body),
    });
  } catch (e) {
    console.error('[email] sendSessionReminder:', e.message);
  }
}

async function sendQuoteRequestConsultant({ to, consultantName, companyName, courseName, participants, address, preferredDates, notes, quoteUrl }) {
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Ciao ${consultantName}, <strong>${companyName}</strong> ha richiesto un preventivo per il corso <strong>${courseName}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:130px;">Partecipanti</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;font-weight:600;">${esc(String(participants))}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Cantiere</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(address)}</td></tr>
      ${preferredDates ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Date preferite</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(preferredDates)}</td></tr>` : ''}
      ${notes ? `<tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;vertical-align:top;">Note</td><td style="padding:10px 0;font-size:14px;color:#374151;">${esc(notes)}</td></tr>` : ''}
    </table>
    ${btn('Rispondi al preventivo', quoteUrl)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: `📋 Richiesta preventivo — ${courseName} (${participants} partecipanti)`,
      html: layout('Richiesta preventivo in cantiere', body),
    });
  } catch (e) {
    console.error('[email] sendQuoteRequestConsultant:', e.message);
  }
}

async function sendQuoteReceivedCompany({ to, _companyName, consultantName, courseName, quotedPriceCents, quotedMessage, acceptUrl }) {
  const price = `€${(quotedPriceCents / 100).toFixed(2)}`;
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      ${consultantName} ha risposto alla tua richiesta di preventivo per <strong>${courseName}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:130px;">Totale preventivo</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:20px;color:#1a1a1a;font-weight:700;">${price}</td></tr>
      ${quotedMessage ? `<tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;vertical-align:top;">Messaggio</td><td style="padding:10px 0;font-size:14px;color:#374151;">${quotedMessage}</td></tr>` : ''}
    </table>
    ${btn('Accetta e procedi al pagamento', acceptUrl)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: `💰 Preventivo ricevuto — ${courseName} (${price})`,
      html: layout('Preventivo ricevuto', body),
    });
  } catch (e) {
    console.error('[email] sendQuoteReceivedCompany:', e.message);
  }
}

async function sendProviderApplicationAlert({ adminEmail, providerName, city, province, email, phone, accreditationCode, notes }) {
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Un nuovo ente ha richiesto di entrare nel marketplace Palladia.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;width:140px;">Ente</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;font-weight:600;">${providerName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Città</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${city}${province ? ', ' + province : ''}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(email)}</td></tr>
      ${phone ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Telefono</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(phone)}</td></tr>` : ''}
      ${accreditationCode ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">Accreditamento</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${esc(accreditationCode)}</td></tr>` : ''}
      ${notes ? `<tr><td style="padding:10px 0;font-size:13px;color:#9ca3af;vertical-align:top;">Note</td><td style="padding:10px 0;font-size:14px;color:#374151;">${esc(notes)}</td></tr>` : ''}
    </table>
    ${btn('Approva nella dashboard admin', `${APP_URL}/admin/formazione/providers`)}`;

  try {
    await getResend().emails.send({
      from: FROM, to: adminEmail,
      subject: `📋 Nuova candidatura ente — ${providerName}`,
      html: layout('Nuova candidatura ente formatore', body),
    });
  } catch (e) {
    console.error('[email] sendProviderApplicationAlert:', e.message);
  }
}

async function sendProviderApprovedEmail({ to, providerName }) {
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Ottima notizia! Il profilo di <strong>${providerName}</strong> è stato approvato e i tuoi corsi sono ora visibili nel marketplace Palladia.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#374151;">
      Puoi aggiungere e gestire i tuoi corsi direttamente dalla dashboard.
    </p>
    ${btn('Accedi al marketplace', `${APP_URL}/formazione/marketplace`)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: 'Profilo approvato — Benvenuto nel marketplace Palladia!',
      html: layout('Profilo approvato', body),
    });
  } catch (e) {
    console.error('[email] sendProviderApprovedEmail:', e.message);
  }
}

// ─── Email: Invito Studio CDL ─────────────────────────────────────────────────

/**
 * Invia all'owner dell'impresa cliente l'invito dello studio CDL a collaborare.
 * @param {{ to: string, studioName: string, acceptUrl: string }} opts
 */
async function sendStudioInviteEmail({ to, studioName, acceptUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Invito da ${esc(studioName)}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Lo studio <strong style="color:#1a1a1a;">${esc(studioName)}</strong> ti ha invitato a collaborare
      su Palladia. Come studio CDL/consulente, monitorerà la compliance della tua azienda
      (DVR, documenti, formazione) e ti segnalerà eventuali scadenze.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Cosa significa accettare</p>
          <ul style="margin:0;padding:0 0 0 16px;">
            <li style="padding:4px 0;font-size:13px;color:#374151;line-height:1.5;">Lo studio potrà visualizzare i tuoi cantieri, lavoratori e documenti</li>
            <li style="padding:4px 0;font-size:13px;color:#374151;line-height:1.5;">Non può modificare nulla — solo consultare e monitorare</li>
            <li style="padding:4px 0;font-size:13px;color:#374151;line-height:1.5;">Riceverai segnalazioni proattive su scadenze e non conformità</li>
          </ul>
        </td>
      </tr>
    </table>

    ${btn('Accetta la collaborazione →', acceptUrl)}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Se non conosci ${esc(studioName)} o non ti aspettavi questo invito, ignora questa email.
      Il link scade e non darà accesso a nessuno senza la tua conferma.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `${studioName} ti ha invitato su Palladia`,
    html: layout(`Invito studio — ${studioName}`, body),
  });
}

/**
 * Invita un'impresa non ancora su Palladia a registrarsi e collegarsi allo studio.
 * @param {{ to: string, studioName: string, companyNameHint: string, acceptUrl: string, registerUrl: string }} opts
 */
async function sendStudioPendingInviteEmail({ to, studioName, companyNameHint, acceptUrl, _registerUrl }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Invito da ${esc(studioName)}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Lo studio <strong style="color:#1a1a1a;">${esc(studioName)}</strong>
      ${companyNameHint ? `vuole monitorare la compliance di <strong style="color:#1a1a1a;">${esc(companyNameHint)}</strong>` : 'vuole collaborare con te'}
      tramite Palladia, la piattaforma per la sicurezza sul lavoro nei cantieri.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Come funziona</p>
          <ul style="margin:0;padding:0 0 0 16px;">
            <li style="padding:5px 0;font-size:13px;color:#374151;line-height:1.5;"><strong>1.</strong> Crea il tuo account gratuito su Palladia (2 minuti)</li>
            <li style="padding:5px 0;font-size:13px;color:#374151;line-height:1.5;"><strong>2.</strong> Collega la tua azienda allo Studio ${esc(studioName)}</li>
            <li style="padding:5px 0;font-size:13px;color:#374151;line-height:1.5;"><strong>3.</strong> Il tuo studio monitora DVR, formazione e documenti per te</li>
          </ul>
        </td>
      </tr>
    </table>

    ${btn('Accetta l\'invito e registrati →', acceptUrl)}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Se non conosci ${esc(studioName)} o non ti aspettavi questo invito, ignora questa email — non verrà creato nessun account senza la tua azione.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `${studioName} ti invita su Palladia`,
    html: layout(`Invito da ${studioName}`, body),
  });
}

/**
 * Digest settimanale per lo studio CDL: riepilogo stato conformità di tutti i clienti.
 * @param {{ to: string, studioName: string, summary: object, issues: Array }} opts
 */
async function sendStudioWeeklyDigest({ to, studioName, summary, issues }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  const APP_BASE_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

  const semRow = (label, count, color) =>
    `<td style="text-align:center;padding:16px 24px;border-right:1px solid #f0f0f0;">
       <div style="font-size:28px;font-weight:800;color:${color};">${count}</div>
       <div style="font-size:11px;color:#9ca3af;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">${label}</div>
     </td>`;

  const issueRows = (issues || []).slice(0, 30).map(i => {
    const color   = i.severity === 'critical' ? '#ef4444' : '#f59e0b';
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #f9f9f6;vertical-align:top;">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="vertical-align:top;padding-right:10px;width:8px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-top:4px;"></span>
            </td>
            <td>
              <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${esc(i.company_name)}</div>
              <div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(i.message)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const today = new Date().toLocaleDateString('it-IT', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const body = `
    <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">${esc(today)}</p>
    <p style="margin:0 0 24px;font-size:20px;font-weight:800;color:#1a1a1a;">Rapporto settimanale — ${esc(studioName)}</p>

    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f8f8f5;border-radius:12px;border:1px solid #e5e5e0;margin-bottom:28px;">
      <tr>
        ${semRow('Conformi', summary.verde, '#10b981')}
        ${semRow('Attenzione', summary.giallo, '#f59e0b')}
        ${semRow('Non conformi', summary.rosso, '#ef4444')}
        <td style="text-align:center;padding:16px 24px;">
          <div style="font-size:28px;font-weight:800;color:#1a1a1a;">${summary.total}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Clienti totali</div>
        </td>
      </tr>
    </table>

    ${issues && issues.length > 0 ? `
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Problemi rilevati</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${issueRows}
    </table>
    ` : `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;text-align:center;">
      <p style="margin:0;font-size:15px;font-weight:700;color:#16a34a;">✅ Tutti i clienti sono conformi questa settimana.</p>
    </div>
    `}

    ${btn('Apri il portale studio →', APP_BASE_URL + '/studio')}
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `[Palladia] Rapporto settimanale — ${summary.rosso > 0 ? `${summary.rosso} non ${summary.rosso === 1 ? 'conforme' : 'conformi'}` : summary.giallo > 0 ? `${summary.giallo} in attenzione` : 'tutto ok'}`,
    html: layout(`Rapporto settimanale — ${studioName}`, body),
  });
}

/**
 * Notifica l'impresa di scadenze imminenti rilevate dal suo studio CDL.
 * @param {{ to: string, companyName: string, studioName: string, issues: Array, studioUrl: string }} opts
 */
async function sendStudioExpiryAlertToCompany({ to, companyName, studioName, issues }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  const APP_BASE_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

  const criticalCount = (issues || []).filter(i => i.severity === 'critical').length;
  const warningCount  = (issues || []).filter(i => i.severity === 'warning').length;

  const issueRows = (issues || []).map(i => {
    const color = i.severity === 'critical' ? '#ef4444' : '#f59e0b';
    const label = i.severity === 'critical' ? 'URGENTE' : 'Attenzione';
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="vertical-align:middle;padding-right:12px;width:80px;">
              <span style="display:inline-block;padding:3px 8px;background:${color}18;color:${color};font-size:10px;font-weight:700;border-radius:4px;letter-spacing:0.06em;">${label}</span>
            </td>
            <td>
              <div style="font-size:13px;color:#374151;">${esc(i.message)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Attenzione richiesta — ${esc(companyName)}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Il tuo studio consulente <strong style="color:#1a1a1a;">${esc(studioName)}</strong> ha rilevato
      ${criticalCount > 0 ? `<strong style="color:#ef4444;">${criticalCount} problema${criticalCount > 1 ? 'i critici' : ' critico'}</strong>` : ''}
      ${criticalCount > 0 && warningCount > 0 ? ' e ' : ''}
      ${warningCount > 0 ? `<strong style="color:#f59e0b;">${warningCount} ${warningCount > 1 ? 'avvisi' : 'avviso'}</strong>` : ''}
      che richiedono la tua attenzione.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      ${issueRows}
    </table>

    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Contatta il tuo studio <strong>${esc(studioName)}</strong> per risolvere queste non conformità o accedi direttamente a Palladia per aggiornare i documenti.</p>

    ${btn('Apri Palladia →', APP_BASE_URL + '/dashboard')}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Questa notifica è stata generata automaticamente da Palladia su richiesta di ${esc(studioName)}.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `[Palladia] Scadenze rilevate — ${companyName} (segnalato da ${studioName})`,
    html: layout(`Scadenze rilevate — ${companyName}`, body),
  });
}

// ── sendDailyAlertDigest ──────────────────────────────────────────────────────
// Email digest giornaliera unica — raggruppa tutti gli alert in un'unica email per company.
// sections: { missingDocs?, workerExpiry?, companyExpiry?, equipmentExpiry? }
async function sendDailyAlertDigest({ to, companyName, dashboardUrl, sections }) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function sevColor(s) { return s === 'critical' ? '#ef4444' : s === 'warning' ? '#f59e0b' : '#3b82f6'; }
  function sevLabel(days) {
    if (days === null) return '';
    if (days < 0) return `scaduto ${Math.abs(days)}gg fa`;
    if (days === 0) return 'scade oggi';
    return `scade in ${days}gg`;
  }

  const sectionHtml = [];
  let totalIssues = 0;
  let hasCritical = false;

  // ── Sezione 1: Documenti obbligatori mancanti ────────────────────────────
  if (sections.missingDocs?.length) {
    const items = sections.missingDocs;
    totalIssues += items.length;
    hasCritical = true;
    const rows = items.map(w => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(w.full_name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#ef4444;">${esc((w.missingTypes || []).join(', '))}</td>
    </tr>`).join('');
    sectionHtml.push(`
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ef4444;">
        Documenti obbligatori mancanti (${items.length})
      </p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #fca5a5;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:28px;">
        <thead><tr style="background:#fef2f2;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#ef4444;text-transform:uppercase;letter-spacing:0.05em;">Documenti mancanti</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  // ── Sezione 2: Documenti lavoratori in scadenza ──────────────────────────
  if (sections.workerExpiry?.length) {
    const items = sections.workerExpiry;
    totalIssues += items.length;
    if (items.some(d => d.severity === 'critical')) hasCritical = true;
    const rows = items.map(d => {
      const color = sevColor(d.severity);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(d.worker?.full_name || '')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(d.typeLabel || d.doc_type)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:right;">
          <span style="color:${color};font-weight:700;">${fmtDate(d.expiry_date)}</span>
          <br><span style="font-size:10px;color:${color};">${esc(sevLabel(d.days))}</span>
        </td>
      </tr>`;
    }).join('');
    sectionHtml.push(`
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#f59e0b;">
        Documenti lavoratori in scadenza (${items.length})
      </p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:28px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Lavoratore</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Tipo</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Scadenza</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  // ── Sezione 3: Documenti aziendali in scadenza ───────────────────────────
  if (sections.companyExpiry?.length) {
    const items = sections.companyExpiry;
    totalIssues += items.length;
    if (items.some(d => d.severity === 'critical')) hasCritical = true;
    const rows = items.map(d => {
      const color = sevColor(d.severity);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${esc(d.name)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(d.catLabel || d.category)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:right;">
          <span style="color:${color};font-weight:700;">${fmtDate(d.ai_expiry_date)}</span>
          <br><span style="font-size:10px;color:${color};">${esc(sevLabel(d.days))}</span>
        </td>
      </tr>`;
    }).join('');
    sectionHtml.push(`
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">
        Documenti aziendali in scadenza (${items.length})
      </p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:28px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Documento</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Categoria</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Scadenza</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  // ── Sezione 4: Scadenze mezzi ────────────────────────────────────────────
  if (sections.equipmentExpiry?.length) {
    const items = sections.equipmentExpiry;
    totalIssues += items.reduce((n, eq) => n + (eq.issues?.length || 0), 0);
    if (items.some(eq => eq.issues?.some(i => i.severity === 'critical'))) hasCritical = true;
    const rows = items.flatMap(eq => {
      const name = esc([eq.type, eq.model, eq.plate_or_serial].filter(Boolean).join(' — '));
      return (eq.issues || []).map((issue, idx) => {
        const color = sevColor(issue.severity);
        return `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:${idx === 0 ? '700' : '400'};color:${idx === 0 ? '#1a1a1a' : '#9ca3af'};">${idx === 0 ? name : ''}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#6b7280;">${esc(issue.label)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:right;">
            <span style="color:${color};font-weight:700;">${fmtDate(issue.date)}</span>
            <br><span style="font-size:10px;color:${color};">${esc(sevLabel(issue.days))}</span>
          </td>
        </tr>`;
      });
    }).join('');
    sectionHtml.push(`
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">
        Scadenze mezzi (${items.length})
      </p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:28px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Mezzo</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Tipo scadenza</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Data</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  if (!sectionHtml.length) return; // nessun problema → nessuna email

  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long' });
  const subjectPrefix = hasCritical ? '⚠️ ' : '';
  const subjectSummary = sections.missingDocs?.length
    ? `${sections.missingDocs.length} doc. obbligatori mancanti`
    : `${totalIssues} alert di conformità`;

  const body = `
    <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">${esc(today)}</p>
    <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.6;">
      Riepilogo giornaliero per <strong style="color:#1a1a1a;">${esc(companyName)}</strong>.
      ${totalIssues === 1
        ? 'C\'è <strong style="color:#1a1a1a;">1 problema</strong> che richiede attenzione.'
        : `Ci sono <strong style="color:#1a1a1a;">${totalIssues} problemi</strong> che richiedono attenzione.`
      }
    </p>

    ${sectionHtml.join('')}

    ${btn('Apri la dashboard →', dashboardUrl)}

    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Questo riepilogo viene inviato ogni mattina e riassume tutti i problemi di conformità attivi.<br>
      Rosso = già scaduto · Arancione = in scadenza entro 7 giorni · Blu = entro 30 giorni.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   Array.isArray(to) ? to : [to],
    subject: `Palladia ${subjectPrefix}— ${subjectSummary} | ${esc(companyName)}`,
    html:    layout('Riepilogo conformità', body),
  });
}

// ─── Email: Provider Formazione — Magic Link ──────────────────────────────────

async function sendProviderMagicLinkEmail({ to, name, accessUrl }) {
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Accedi al tuo portale</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Ciao <strong style="color:#1a1a1a;">${esc(name)}</strong>, ecco il tuo link di accesso al portale
      Enti Formazione di Palladia. Valido per 365 giorni.
    </p>
    ${btn('Accedi al portale →', accessUrl)}
    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Se non hai richiesto questo link, ignoralo. Non è richiesta nessuna azione.
    </p>
  `;
  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: 'Accedi al portale Enti Formazione — Palladia',
      html: layout('Accesso portale formazione', body),
    });
  } catch (e) { console.error('[email] sendProviderMagicLinkEmail:', e.message); }
}

// ─── Email: Registrazione ente formazione (admin + provider) ─────────────────

async function sendProviderRegistrationEmail({ to, providerName, email, city, province, accCode, isProvider }) {
  const body = isProvider
    ? `
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
        Grazie per aver registrato <strong>${esc(providerName)}</strong> su Palladia!<br/>
        Il team Palladia verificherà la tua richiesta e ti risponderà entro 1-2 giorni lavorativi.
        Riceverai un link di accesso al portale non appena il tuo profilo sarà approvato.
      </p>
      <p style="margin:0;font-size:12px;color:#9ca3af;">
        Per accelerare l'approvazione assicurati di avere a portata: codice di accreditamento regionale e
        estremi ATECO dell'ente.
      </p>`
    : `
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
        Nuova registrazione ente formazione in attesa di approvazione:
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;width:140px;">Ente</td><td style="font-size:13px;font-weight:700;">${esc(providerName)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Email</td><td style="font-size:13px;">${esc(email)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Sede</td><td style="font-size:13px;">${esc(city)} (${esc(province)})</td></tr>
        ${accCode ? `<tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Accreditamento</td><td style="font-size:13px;">${esc(accCode)}</td></tr>` : ''}
      </table>
      ${btn('Approva nel pannello admin →', `${APP_URL}/formazione/admin`)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: isProvider ? 'Richiesta ricevuta — in attesa di approvazione' : `[Admin] Nuovo ente formazione: ${providerName}`,
      html: layout(isProvider ? 'Richiesta in lavorazione' : 'Nuova registrazione ente', body),
    });
  } catch (e) { console.error('[email] sendProviderRegistrationEmail:', e.message); }
}

// ─── Email: Provider in attesa (già registrato, non ancora approvato) ─────────

async function sendProviderPendingEmail({ to, name }) {
  const body = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
      Ciao <strong>${esc(name)}</strong>, il tuo profilo è ancora in fase di revisione da parte del team Palladia.
      Riceverai un link di accesso non appena sarà approvato. Non è necessaria nessuna altra azione da parte tua.
    </p>`;
  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: 'Il tuo profilo Palladia è in fase di approvazione',
      html: layout('Profilo in approvazione', body),
    });
  } catch (e) { console.error('[email] sendProviderPendingEmail:', e.message); }
}

// ─── Email: Prenotazione confermata (dal provider) ────────────────────────────

async function sendBookingConfirmedEmail({ bookingId }) {
  // Recupera dati prenotazione e manda email al lavoratore/azienda
  // Fire-and-forget — errori non bloccano il flusso
  try {
    const supabase = require('../lib/supabase');
    const { data: booking } = await supabase
      .from('course_bookings')
      .select(`
        id, worker_id,
        workers(full_name),
        course_sessions(
          start_date,
          marketplace_courses(title, training_providers(name))
        )
      `)
      .eq('id', bookingId)
      .maybeSingle();
    if (!booking) return;

    const courseName   = booking.course_sessions?.marketplace_courses?.title || 'Corso';
    const providerName = booking.course_sessions?.marketplace_courses?.training_providers?.name || 'Ente';
    const sessionDate  = booking.course_sessions?.start_date;
    const workerName   = booking.workers?.full_name || 'Lavoratore';

    // Non abbiamo l'email del worker direttamente — skip per ora
    // In futuro integrare con company_users
    console.log(`[email] Booking ${bookingId} confirmed — ${workerName} su ${courseName} (${providerName}) il ${sessionDate}`);
  } catch (e) { console.error('[email] sendBookingConfirmedEmail:', e.message); }
}

// ─── Email: Richiesta documento CDL → cliente ─────────────────────────────────

async function sendDocumentRequestEmail({ to, studioName, companyName, title, description, dueDate, uploadUrl }) {
  function fmtDate(d) {
    if (!d) return null;
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Documento richiesto</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Lo Studio <strong style="color:#1a1a1a;">${esc(studioName)}</strong> ha richiesto un documento
      per l'impresa <strong style="color:#1a1a1a;">${esc(companyName)}</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#f8f8f5;border-radius:10px;border:1px solid #e5e5e0;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;">Documento richiesto</p>
        <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#1a1a1a;">${esc(title)}</p>
        ${description ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;line-height:1.6;">${esc(description)}</p>` : ''}
        ${dueDate ? `<p style="margin:0;font-size:13px;color:#f59e0b;font-weight:600;">Scadenza: ${fmtDate(dueDate)}</p>` : ''}
      </td></tr>
    </table>
    ${btn('Carica il documento →', uploadUrl)}
    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;">
      Puoi caricare il documento cliccando il pulsante sopra. Non è richiesto nessun account.
    </p>`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: `${studioName} richiede un documento: ${title}`,
      html: layout('Richiesta documento', body),
    });
  } catch (e) { console.error('[email] sendDocumentRequestEmail:', e.message); }
}

// ─── Email: Documento caricato dal cliente → CDL ──────────────────────────────

async function sendDocumentUploadedEmail({ to, _studioName, companyName, title, portalUrl }) {
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Documento caricato</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      L'impresa <strong style="color:#1a1a1a;">${esc(companyName)}</strong> ha caricato il documento
      richiesto: <strong style="color:#1a1a1a;">${esc(title)}</strong>.
    </p>
    ${btn('Vedi nel portale →', portalUrl)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: `Documento caricato: ${title} — ${companyName}`,
      html: layout('Documento ricevuto', body),
    });
  } catch (e) { console.error('[email] sendDocumentUploadedEmail:', e.message); }
}

// ─── Email: Notifica al CSE (NC risolta, documento aggiornato) ────────────────

async function sendCseNotificationEmail({ to, _coordinatorName, siteName, eventType, details, accessUrl }) {
  const LABELS = {
    nc_resolved:       'Non Conformità Risolta',
    doc_updated:       'Documento Aggiornato',
    worker_added:      'Nuovo Lavoratore Aggiunto',
    expiry_reminder:   'Scadenze in Arrivo',
  };
  const label = LABELS[eventType] || 'Aggiornamento Cantiere';

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">${esc(label)}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Aggiornamento per il cantiere <strong style="color:#1a1a1a;">${esc(siteName)}</strong>.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.6;">${esc(details)}</p>
    ${btn('Vedi nel portale →', accessUrl)}`;

  try {
    await getResend().emails.send({
      from: FROM, to,
      subject: `${label} — ${siteName}`,
      html: layout(label, body),
    });
  } catch (e) { console.error('[email] sendCseNotificationEmail:', e.message); }
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Email: Report settimanale scadenze ───────────────────────────────────────

/**
 * Riepilogo settimanale scadenze — inviato ogni lunedì agli owner/admin.
 * @param {{
 *   to: string,
 *   companyName: string,
 *   critical: Array<{label:string, date:string, days:number}>,
 *   warning:  Array<{label:string, date:string, days:number}>,
 * }} opts
 */
async function sendWeeklyExpiryReport({ to, companyName, critical, warning }) {
  const hasCritical = critical.length > 0;
  const hasWarning  = warning.length > 0;
  if (!hasCritical && !hasWarning) return; // niente da inviare

  const dayLabel = d => {
    if (d < 0) return `<span style="color:#dc2626;font-weight:700;">scaduta da ${-d} gg</span>`;
    if (d === 0) return `<span style="color:#dc2626;font-weight:700;">scade oggi</span>`;
    return `<span style="color:#1a1a1a;">scade in ${d} gg</span>`;
  };

  const rowHtml = (items, _color) => items.map(e =>
    `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#374151;">${esc(e.label)}</td>
      <td style="padding:8px 0 8px 16px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;white-space:nowrap;">${dayLabel(e.days)}</td>
    </tr>`
  ).join('');

  const critSection = hasCritical ? `
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#dc2626;">Critiche (${critical.length})</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">${rowHtml(critical, '#dc2626')}</table>` : '';

  const warnSection = hasWarning ? `
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#d97706;">In scadenza (${warning.length})</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">${rowHtml(warning, '#d97706')}</table>` : '';

  const total = critical.length + warning.length;
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Riepilogo scadenze</p>
    <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.6;">
      Questa settimana <strong style="color:#1a1a1a;">${companyName}</strong> ha <strong>${total} scadenz${total > 1 ? 'e' : 'a'}</strong> da gestire.
    </p>
    ${critSection}
    ${warnSection}
    ${btn('Apri lo scadenzario →', `${APP_URL}/scadenze`)}
    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Ricevi questo riepilogo ogni lunedì mattina. Gestisci le notifiche dal tuo profilo.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `${hasCritical ? '🔴 ' : '🟡 '}Scadenze della settimana — ${companyName}`,
    html: layout('Scadenze questa settimana', body),
  });
}

// ─── Email: Conferma account (Auth Hook Supabase) ─────────────────────────────

/**
 * Inviata dal Supabase Auth Hook invece della conferma email di default.
 * @param {{ to: string, confirmUrl: string, name?: string }} opts
 */
async function sendConfirmEmail({ to, confirmUrl, name }) {
  const firstName = name ? name.split(' ')[0] : null;

  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">
      ${firstName ? `Ciao ${firstName},` : 'Benvenuto su Palladia.'}
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Clicca il pulsante qui sotto per confermare il tuo indirizzo email e attivare l'account.
      Il link è valido per <strong style="color:#1a1a1a;">24 ore</strong>.
    </p>

    ${btn('Conferma il tuo account →', confirmUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Se non hai creato un account su Palladia, ignora questa email in tutta sicurezza.
      Nessuna azione è richiesta da parte tua.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Conferma il tuo account Palladia',
    html: layout('Conferma account', body),
  });
}

// ─── Email: Reset password via Auth Hook ──────────────────────────────────────

/**
 * Sovrascrive la funzione di reset esistente (ora usata anche dall'Auth Hook).
 * Già definita sopra come sendPasswordResetEmail — alias per chiarezza nel hook.
 */

// ─── Email: Magic link login (Auth Hook Supabase) ─────────────────────────────

/**
 * @param {{ to: string, magicUrl: string }} opts
 */
async function sendMagicLinkEmail({ to, magicUrl }) {
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Accedi a Palladia</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Hai richiesto un link di accesso rapido. Clicca il pulsante qui sotto per entrare nella dashboard.
      Il link è valido per <strong style="color:#1a1a1a;">60 minuti</strong> e può essere usato una sola volta.
    </p>

    ${btn('Accedi a Palladia →', magicUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Se non hai richiesto questo link, ignora questa email. Il tuo account è al sicuro.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Il tuo link di accesso a Palladia',
    html: layout('Accesso rapido', body),
  });
}

// ─── Email: Cambio email (Auth Hook Supabase) ─────────────────────────────────

/**
 * @param {{ to: string, changeUrl: string }} opts
 */
async function sendEmailChangeEmail({ to, changeUrl }) {
  const body = `
    <p style="margin:0 0 6px;font-size:20px;font-weight:800;color:#1a1a1a;">Conferma cambio email</p>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
      Hai richiesto di cambiare l'indirizzo email del tuo account Palladia.
      Clicca il pulsante qui sotto per confermare il nuovo indirizzo.
    </p>

    ${btn('Conferma il nuovo indirizzo →', changeUrl)}

    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Se non hai richiesto il cambio email, contatta immediatamente il supporto Palladia.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Conferma cambio email — Palladia',
    html: layout('Cambio indirizzo email', body),
  });
}

module.exports = {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendMissingExitAlert,
  sendInviteEmail,
  sendCoordinatorInviteEmail,
  sendCoordinatorNoteAlert,
  sendCoordinatorRecoveryEmail,
  sendProMagicLinkEmail,
  sendMemberRemovedEmail,
  sendNonconformityAlert,
  sendNonconformityUpdate,
  sendExpiryAlertPro,
  sendWorkerExpiryAlertCompany,
  sendWorkerDocExpiryAlert,
  sendEquipmentExpiryAlert,
  sendCompanyDocExpiryAlert,
  sendWorkerMissingDocsAlert,
  sendDailyAlertDigest,
  sendExpiryAlert,
  sendBookingConfirmation,
  sendBookingConfirmedConsultant,
  sendCertificatesUploaded,
  sendSessionReminder,
  sendProviderApplicationAlert,
  sendProviderApprovedEmail,
  sendQuoteRequestConsultant,
  sendQuoteReceivedCompany,
  sendStudioInviteEmail,
  sendStudioPendingInviteEmail,
  sendStudioWeeklyDigest,
  sendStudioExpiryAlertToCompany,
  sendProviderMagicLinkEmail,
  sendProviderRegistrationEmail,
  sendProviderPendingEmail,
  sendBookingConfirmedEmail,
  sendDocumentRequestEmail,
  sendDocumentUploadedEmail,
  sendCseNotificationEmail,
  sendWeeklyExpiryReport,
  sendConfirmEmail,
  sendMagicLinkEmail,
  sendEmailChangeEmail,
  sendStudioDurcAlert,
  sendWeatherExtremeAlert,
  sendAiCreditExhaustedAlert,
};

// ─── Studio CDL — Alert DURC clienti ──────────────────────────────────────────

async function sendStudioDurcAlert({ to, studioName, companies, dashboardUrl }) {
  const rows = companies
    .sort((a, b) => a.days - b.days)
    .map(c => {
      const daysLabel = c.days < 0 ? `scaduto da ${-c.days} gg` : c.days === 0 ? 'scade oggi' : `scade in ${c.days} gg`;
      const color     = c.days < 0 ? '#ef4444' : c.days <= 7 ? '#f97316' : '#f59e0b';
      const exp       = c.expiryDate ? new Date(c.expiryDate).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e5e0;font-size:13px;font-weight:600;">${c.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e5e0;font-size:13px;color:#6b7280;">${exp}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e5e0;font-size:12px;font-weight:700;color:${color};">${daysLabel}</td>
      </tr>`;
    }).join('');

  const body = `
    <tr><td style="padding:0 40px 32px;">
      <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#111;">Buongiorno ${studioName},</p>
      <p style="margin:0 0 24px;font-size:14px;color:#555;">
        ${companies.length === 1
          ? `Hai 1 cliente con DURC in scadenza che richiede la tua attenzione.`
          : `Hai ${companies.length} clienti con DURC in scadenza che richiedono la tua attenzione.`}
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e5e0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f5f5f0;">
            <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;">Cliente</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;">Scadenza DURC</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;">Stato</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
          Apri dashboard studio →
        </a>
      </div>
    </td></tr>`;

  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `DURC in scadenza — ${companies.length} client${companies.length === 1 ? 'e' : 'i'} da rinnovare`,
    html: layout('Alert DURC clienti', body),
  });
}

// ─── Email: Avviso meteo estremo (ondata calore / neve / temporale) ────────────

/**
 * @param {{ companyId: string, alerts: Array<{siteName, date, type, tempMax, description}> }} opts
 */
async function sendWeatherExtremeAlert({ companyId, alerts }) {
  const supabase = require('../lib/supabase');
  const { filterUserIdsByChannel } = require('../lib/notificationPrefs');

  const { data: adminUsers } = await supabase
    .from('company_users')
    .select('user_id')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin']);

  if (!adminUsers?.length) return;

  const enabledIds = await filterUserIdsByChannel(companyId, adminUsers.map(u => u.user_id), 'email');
  if (!enabledIds.length) return;

  const adminEmails = [];
  for (const uid of enabledIds) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(uid);
      if (user?.email) adminEmails.push(user.email);
    } catch { /* ignora */ }
  }
  if (!adminEmails.length) return;

  const LABELS = { heat: 'Ondata di calore', snow: 'Neve prevista', thunderstorm: 'Temporale' };
  const ICONS  = { heat: '&#x1F321;', snow: '&#x2744;', thunderstorm: '&#x26C8;' };

  // Raggruppa alert per cantiere
  const bySite = new Map();
  for (const a of alerts) {
    if (!bySite.has(a.siteName)) bySite.set(a.siteName, []);
    bySite.get(a.siteName).push(a);
  }

  let siteRows = '';
  for (const [siteName, siteAlerts] of bySite) {
    const tableRows = siteAlerts.map(a => {
      const dateIt = new Date(a.date + 'T00:00:00').toLocaleDateString('it-IT', {
        weekday: 'short', day: 'numeric', month: 'short',
      });
      const label  = LABELS[a.type]  || a.type;
      const icon   = ICONS[a.type]   || '&#x26A0;';
      const temp   = a.tempMax != null ? ` &mdash; max ${a.tempMax}&deg;C` : '';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;">${icon} ${esc(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#6b7280;">${esc(dateIt)}${temp}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#6b7280;">${esc(a.description)}</td>
      </tr>`;
    }).join('');

    siteRows += `
      <p style="margin:20px 0 6px;font-size:13px;font-weight:700;color:#1a1a1a;">&#x1F4CD; ${esc(siteName)}</p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;margin-bottom:4px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;">Evento</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;">Data</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;">Condizione</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  }

  const uniqueTypes  = [...new Set(alerts.map(a => a.type))];
  const subjectTypes = uniqueTypes.map(t => LABELS[t] || t).join(' · ');
  const nSites       = bySite.size;
  const subject      = `Allerta meteo — ${subjectTypes} (${nSites} cantier${nSites === 1 ? 'e' : 'i'})`;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:18px;font-weight:800;color:#1a1a1a;">Condizioni meteo critiche in arrivo</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Nei prossimi 3 giorni sono previste condizioni potenzialmente pericolose per i seguenti cantieri.
      Valuta misure di protezione per i lavoratori e, se necessario, la sospensione delle attività.
    </p>
    ${siteRows}
    ${btn('Vai ai cantieri &#x2192;', `${APP_URL}/`)}
    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px;">
      Previsioni fornite da Open-Meteo (aggiornate ogni mattina alle 07:00).
      Per allerta ufficiale consulta il bollettino della Protezione Civile.<br/>
      Le soglie di avviso sono configurabili nelle impostazioni di ogni cantiere.
    </p>
  `;

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return getResend().emails.send({
    from: FROM,
    to:   adminEmails,
    subject,
    html: layout('Allerta meteo estremo', bodyHtml),
  });
}

// ─── Email: Credito Anthropic esaurito (interno — a chi gestisce la piattaforma) ──

/**
 * @param {{ detail?: string }} opts
 */
async function sendAiCreditExhaustedAlert({ detail } = {}) {
  const to = process.env.ADMIN_EMAIL || 'palladiaofficial@gmail.com';
  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:18px;font-weight:800;color:#1a1a1a;">Il credito Anthropic è esaurito</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Ladia (l'assistente AI) ha smesso di rispondere a tutti i clienti perché l'account Anthropic
      non ha più credito disponibile. Ricarica il saldo su console.anthropic.com per ripristinare il servizio.
    </p>
    ${detail ? `<p style="margin:0 0 24px;font-size:12px;color:#9ca3af;font-family:monospace;">${detail}</p>` : ''}
  `;
  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Palladia — Credito Anthropic esaurito, Ladia è offline',
    html: layout('Credito AI esaurito', bodyHtml),
  });
}
