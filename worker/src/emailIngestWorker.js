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
    const startedAt = Date.now();
    // Tag ogni fase esplicitamente: se il messaggio muore silenziosamente (F-061,
    // 2026-08-21 — 2 email reali su 3 reinviate non hanno mai raggiunto il backend,
    // nessuna riga in nessun log), l'unico modo per capire DOVE si è fermato è
    // `wrangler tail` mentre succede. Senza questi checkpoint, un crash prima del
    // fetch() è indistinguibile da un crash del runtime che salta anche il catch.
    let stage = 'start';
    try {
      console.log(`[email-ingest-worker] ricevuto to=${message.to} from=${message.from} rawSize=${message.rawSize}`);

      stage = 'reading-raw-stream';
      const raw = await streamToUint8Array(message.raw);
      console.log(`[email-ingest-worker] stream letto: ${raw.length} bytes reali (dichiarati rawSize=${message.rawSize}) — +${Date.now() - startedAt}ms`);

      stage = 'parsing-postal-mime';
      const parsed = await PostalMime.parse(raw);
      console.log(`[email-ingest-worker] parsing ok: ${(parsed.attachments || []).length} allegati — +${Date.now() - startedAt}ms`);

      stage = 'building-form-data';
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

      stage = 'posting-to-backend';
      const resp = await fetch(env.BACKEND_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'X-Ingest-Secret': env.INGEST_SHARED_SECRET },
        body: form,
      });

      if (!resp.ok) {
        console.error(`[email-ingest-worker] backend ha risposto ${resp.status}`, await resp.text().catch(() => ''));
      } else {
        console.log(`[email-ingest-worker] consegnato al backend — +${Date.now() - startedAt}ms totali`);
      }
    } catch (err) {
      console.error(`[email-ingest-worker] errore imprevisto durante '${stage}' (+${Date.now() - startedAt}ms):`, err.name, err.message, err.stack);
    }
  },
};

async function streamToUint8Array(stream) {
  // Non ci si fida più di `message.rawSize` per pre-allocare: se il conteggio del
  // runtime differisse anche di un byte dallo stream reale, `Uint8Array.set()` lancia
  // RangeError PRIMA che venga letto tutto lo stream — un crash silenzioso plausibile
  // per email più corpose (zip, doppio allegato), mai riprodotto in locale perché lì
  // lo stream si costruisce da un Blob già noto, non da un vero stream SMTP.
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
