const { Resend } = require('resend');

const FROM = 'PalladIA <noreply@palladia.it>';

// Inizializzazione lazy: evita crash al boot se RESEND_API_KEY non è impostata.
// Il server.js già gestisce il caso RESEND_API_KEY assente con un warning + risposta 200.
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
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background:#0f172a;padding:28px 32px;">
          <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">PALLADIA</span>
          <span style="color:#94a3b8;font-size:12px;margin-left:12px;">Registro Presenze Digitale</span>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px;">
          ${bodyHtml}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
            PalladIA – Registro Presenze Digitale &middot; info@palladia.it<br />
            Hai ricevuto questa email perché hai un account su PalladIA.
            Se non sei stato tu, ignora questa email o contattaci.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function btn(text, href) {
  return `<a href="${href}" style="display:inline-block;margin-top:24px;padding:12px 28px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">${text}</a>`;
}

// ─── Email: Benvenuto ──────────────────────────────────────────────────────

/**
 * @param {{ to: string, name: string, companyName: string }} opts
 */
async function sendWelcomeEmail({ to, name, companyName }) {
  const firstName = name.split(' ')[0];
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Benvenuto su PalladIA, ${firstName}!</h1>
    <p style="margin:0 0 16px;color:#64748b;font-size:14px;line-height:1.6;">
      Il tuo account e l'azienda <strong style="color:#0f172a;">${companyName}</strong> sono stati configurati con successo.
      Puoi già iniziare a gestire i tuoi cantieri.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:20px 0;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#0f172a;">Cosa puoi fare adesso:</p>
          <ul style="margin:0;padding-left:18px;color:#64748b;font-size:13px;line-height:2;">
            <li>Aggiungere i tuoi cantieri attivi</li>
            <li>Inserire i lavoratori con codice fiscale</li>
            <li>Generare i badge QR per le timbrature</li>
            <li>Produrre il POS in PDF</li>
          </ul>
        </td>
      </tr>
    </table>

    ${btn('Vai alla dashboard', 'https://palladia.it/dashboard')}

    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
      Ricorda: PalladIA supporta la gestione digitale delle presenze ma non sostituisce gli obblighi di legge
      previsti dal D.Lgs.&nbsp;81/2008. L'azienda resta responsabile della corretta applicazione della normativa.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Benvenuto su PalladIA — ${companyName} è pronta`,
    html: layout('Benvenuto su PalladIA', body),
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
      Hai richiesto il reset della password per il tuo account PalladIA.<br />
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
    subject: 'Reimposta la tua password — PalladIA',
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
      Questo alert viene generato automaticamente da PalladIA al termine della giornata lavorativa.
      I dati di presenza sono registrati in modo append-only e non modificabili.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to:   adminEmails,
    subject: `PalladIA — ${missingList.length} uscite mancanti del ${dateDisplay}`,
    html: layout(`Alert uscite mancanti — ${dateDisplay}`, body)
  });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendMissingExitAlert };
