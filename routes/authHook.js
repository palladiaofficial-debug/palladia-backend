'use strict';
/**
 * routes/authHook.js
 * Supabase "Send Email" Auth Hook — sostituisce le email di sistema Supabase
 * con email branded Palladia inviate tramite Resend.
 *
 * Configurazione Supabase Dashboard:
 *   Authentication → Hooks → Send Email Hook
 *   URL: https://palladia-backend-production.up.railway.app/api/auth/hook/send-email
 *   Secret: valore di SUPABASE_HOOK_SECRET su Railway
 *
 * Tipi gestiti:
 *   signup        — conferma email alla registrazione
 *   recovery      — reset password
 *   magiclink     — accesso senza password
 *   email_change  — conferma cambio indirizzo email
 *   invite        — (ignorato: Palladia usa il proprio flow inviti)
 */

const router = require('express').Router();
const {
  sendConfirmEmail,
  sendPasswordResetEmail,
  sendMagicLinkEmail,
  sendEmailChangeEmail,
} = require('../services/email');

const SUPABASE_URL  = (process.env.SUPABASE_URL  || '').replace(/\/$/, '');
const FRONTEND_URL  = (process.env.FRONTEND_URL  || process.env.APP_BASE_URL || 'https://palladia-kappa.vercel.app').replace(/\/$/, '');
const HOOK_SECRET   = process.env.SUPABASE_HOOK_SECRET || '';

// Costruisce il link di verifica che passa per Supabase (/auth/v1/verify)
// Il token viene validato da Supabase → l'utente viene poi redirectato sul frontend.
function buildVerifyUrl(tokenHash, type, redirectTo) {
  const dest = redirectTo || `${FRONTEND_URL}/login`;
  return `${SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=${type}&redirect_to=${encodeURIComponent(dest)}`;
}

// ── POST /api/auth/hook/send-email ────────────────────────────────────────────
router.post('/auth/hook/send-email', async (req, res) => {
  // 1. Verifica il segreto condiviso
  if (HOOK_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${HOOK_SECRET}`) {
      console.warn('[auth-hook] richiesta con secret errato — IP:', req.ip);
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  }

  const { user, email_data } = req.body || {};

  if (!user?.email || !email_data?.email_action_type) {
    console.error('[auth-hook] payload malformato:', JSON.stringify(req.body).slice(0, 200));
    return res.status(400).json({ error: 'INVALID_PAYLOAD' });
  }

  const { token_hash, token_hash_new, redirect_to, email_action_type } = email_data;
  const to   = user.email;
  const name = user.user_metadata?.full_name || user.user_metadata?.name || null;

  console.log(`[auth-hook] type=${email_action_type} to=${to}`);

  try {
    switch (email_action_type) {

      case 'signup': {
        const confirmUrl = buildVerifyUrl(token_hash, 'signup', redirect_to);
        await sendConfirmEmail({ to, confirmUrl, name });
        break;
      }

      case 'recovery': {
        const resetLink = buildVerifyUrl(token_hash, 'recovery', redirect_to);
        await sendPasswordResetEmail({ to, resetLink });
        break;
      }

      case 'magiclink': {
        const magicUrl = buildVerifyUrl(token_hash, 'magiclink', redirect_to);
        await sendMagicLinkEmail({ to, magicUrl });
        break;
      }

      case 'email_change': {
        // Per email_change vengono inviati due token: uno al vecchio indirizzo, uno al nuovo.
        // token_hash_new è presente solo nella mail al nuovo indirizzo.
        const hash       = token_hash_new || token_hash;
        const changeUrl  = buildVerifyUrl(hash, 'email_change', redirect_to);
        await sendEmailChangeEmail({ to, changeUrl });
        break;
      }

      case 'invite':
        // Palladia usa il proprio sistema di inviti (routes/v1/invites.js).
        // Questo caso non dovrebbe mai arrivare, ma se arriva lo ignoriamo con 200
        // perché Supabase si aspetta 200 per considerare il hook completato.
        console.warn('[auth-hook] tipo "invite" ricevuto — ignorato (Palladia usa inviti custom)');
        break;

      default:
        console.warn('[auth-hook] tipo non gestito:', email_action_type);
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[auth-hook] errore invio email:', err.message);
    // Restituiamo 500 così Supabase sa che il hook è fallito.
    // Supabase NON invia la propria email di fallback — il tentativo viene loggato.
    res.status(500).json({ error: 'EMAIL_SEND_FAILED', detail: err.message });
  }
});

module.exports = router;
