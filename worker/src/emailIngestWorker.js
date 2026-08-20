/**
 * worker/src/emailIngestWorker.js
 *
 * Cloudflare Email Worker: riceve l'email grezza dalla regola catch-all della zona
 * palladia.net (Email Routing), la fa passare per postal-mime per estrarre allegati e
 * header, e la ripubblica come multipart/form-data verso il webhook del backend
 * (routes/v1/emailIngest.js), con gli stessi nomi campo già usati per Mailgun Routes
 * (sender/recipient/subject/message-headers/attachment-N) — così la logica del
 * backend (services/emailIngestWebhook.js) resta identica e già testata, cambia solo
 * il meccanismo di autenticazione (header X-Ingest-Secret invece di firma HMAC).
 *
 * Nessun umano legge la posta scartata qui: ogni ramo del backend scrive comunque una
 * riga in email_ingest_log, quindi il Worker può limitarsi a loggare in console (visibile
 * in `wrangler tail`) senza logica di quarantena propria.
 */

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    try {
      const raw = await streamToUint8Array(message.raw, message.rawSize);
      const parsed = await PostalMime.parse(raw);

      const headerPairs = [];
      for (const [key, value] of message.headers) headerPairs.push([key, value]);

      const form = new FormData();
      form.append('recipient', message.to);
      form.append('sender', message.from);
      form.append('from', message.from);
      form.append('subject', parsed.subject || '');
      form.append('message-headers', JSON.stringify(headerPairs));

      let i = 0;
      for (const att of parsed.attachments || []) {
        i += 1;
        const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
        form.append(`attachment-${i}`, new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }), att.filename || `allegato-${i}`);
      }

      const resp = await fetch(env.BACKEND_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'X-Ingest-Secret': env.INGEST_SHARED_SECRET },
        body: form,
      });

      if (!resp.ok) {
        console.error(`[email-ingest-worker] backend ha risposto ${resp.status}`, await resp.text().catch(() => ''));
      }
    } catch (err) {
      console.error('[email-ingest-worker] errore imprevisto:', err.message, err.stack);
    }
  },
};

async function streamToUint8Array(stream, size) {
  const reader = stream.getReader();
  const result = new Uint8Array(size);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
