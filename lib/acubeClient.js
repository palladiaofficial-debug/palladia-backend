'use strict';

/**
 * lib/acubeClient.js
 * Client HTTP per A-Cube (https://acubeapi.com), usato per la consultazione fatture
 * elettroniche via Cassetto Fiscale + Delega Unificata — vedi services/sdiConsultation.js.
 * Meccanismo separato da Openapi/SdI (services/sdiInvoices.js), che invece sposta il
 * Codice Destinatario.
 *
 * ENV richieste:
 *   ACUBE_EMAIL / ACUBE_PASSWORD — credenziali dell'account A-Cube di Palladia
 *   ACUBE_ENV                    — 'sandbox' | 'production' (default 'sandbox')
 *   ACUBE_GOV_IT_BASE_URL        — override manuale dell'host Cassetto Fiscale
 *
 * NOTA DI ONESTÀ TECNICA (stesso trattamento riservato all'auth_header ambiguo di
 * Openapi in services/sdiInvoices.js:26-31): la documentazione pubblica di A-Cube per
 * il prodotto Cassetto Fiscale (docs.acubeapi.com/documentation/italy/gov-it/cassettofiscale)
 * conferma endpoint e flusso di autenticazione (login su common(-sandbox).api.acubeapi.com,
 * JWT valido 24h) ma NON pubblica un host dedicato per il prodotto gov-it senza un
 * account attivo — qui usiamo lo stesso pattern di naming di peppol.api.acubeapi.com,
 * sovrascrivibile via ACUBE_GOV_IT_BASE_URL senza toccare il codice. Da confermare con
 * il supporto A-Cube o la documentazione autenticata prima del primo utilizzo reale.
 */

const AUTH_BASE_URL = {
  sandbox:    'https://common-sandbox.api.acubeapi.com',
  production: 'https://common.api.acubeapi.com',
};

const GOV_IT_BASE_URL = {
  sandbox:    process.env.ACUBE_GOV_IT_BASE_URL || 'https://gov-it-sandbox.api.acubeapi.com',
  production: process.env.ACUBE_GOV_IT_BASE_URL || 'https://gov-it.api.acubeapi.com',
};

function getEnvironment() {
  return process.env.ACUBE_ENV === 'production' ? 'production' : 'sandbox';
}

let cachedToken = null; // { token, expiresAt }

async function login() {
  const email    = process.env.ACUBE_EMAIL;
  const password = process.env.ACUBE_PASSWORD;
  if (!email || !password) throw new Error('ACUBE_EMAIL / ACUBE_PASSWORD non configurate');

  const base = AUTH_BASE_URL[getEnvironment()];
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `A-Cube login error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const token = body?.token || body?.access_token;
  if (!token) throw new Error('A-Cube login: token mancante nella risposta');

  // JWT valido 24h — rinnovato con 30 minuti di margine
  cachedToken = { token, expiresAt: Date.now() + (23.5 * 60 * 60 * 1000) };
  return token;
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  return login();
}

async function acubeRequest(path, options = {}) {
  const token = await getToken();
  const base  = GOV_IT_BASE_URL[getEnvironment()];
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || body?.detail || `A-Cube error ${res.status}`);
    err.status = res.status;
    err.body   = body;
    throw err;
  }
  return body;
}

// Variante per risposte non-JSON (es. XML grezzo di una fattura scaricata).
async function acubeRequestRaw(path, options = {}) {
  const token = await getToken();
  const base  = GOV_IT_BASE_URL[getEnvironment()];
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`A-Cube error ${res.status}`);
    err.status = res.status;
    err.body   = text;
    throw err;
  }
  return text;
}

module.exports = { acubeRequest, acubeRequestRaw, getEnvironment };
