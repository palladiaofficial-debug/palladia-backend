'use strict';
// F-179 (AUDIT.md): il bucket worker-photos era pubblico — qualunque URL
// finito in una risposta JSON (visibile con F12) restava raggiungibile per
// sempre, senza login. Ora è privato: workers.photo_url salva solo il path
// nel bucket, mai un URL. Questo modulo intercetta OGNI risposta JSON di
// /api/v1/* e sostituisce ogni photo_url-path con un URL firmato a
// scadenza, generato al momento — un solo punto di innesto invece di
// modificare ogni singola route che espone un lavoratore (workers.js,
// badgePunch.js, workerDocs.js, certificates.js, consultantProfile.js...).

const BUCKET = 'worker-photos';
const SIGNED_URL_TTL_SECS = 3600; // 1h — rigenerato ad ogni risposta, non serve di più

// Un photo_url già pieno (es. foto pubblica esterna di un consulente,
// consultant_profiles.photo_url) inizia sempre con http(s) e va lasciato
// intoccato — solo un path grezzo nel nostro bucket va firmato.
function looksLikeStoragePath(value) {
  return typeof value === 'string' && value.length > 0 && !/^https?:\/\//i.test(value);
}

function collectPaths(value, paths) {
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, paths);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'photo_url' && looksLikeStoragePath(v)) paths.add(v);
      else collectPaths(v, paths);
    }
  }
}

function applyMap(value, map) {
  if (Array.isArray(value)) return value.map(v => applyMap(v, map));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = (k === 'photo_url' && looksLikeStoragePath(v)) ? (map.get(v) ?? null) : applyMap(v, map);
    }
    return out;
  }
  return value;
}

async function resolvePhotoUrlsInBody(supabase, body) {
  const paths = new Set();
  collectPaths(body, paths);
  if (paths.size === 0) return body;

  const pathList = [...paths];
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(pathList, SIGNED_URL_TTL_SECS);
  if (error) {
    console.error('[workerPhotoUrl] createSignedUrls fallito (foto non mostrate, risposta non bloccata):', error.message);
    return body;
  }
  const map = new Map(pathList.map((p, i) => [p, data[i]?.signedUrl || null]));
  return applyMap(body, map);
}

// Middleware Express: da montare presto in routes/v1/index.js, prima di
// qualunque route. Fail-open — se la firma fallisce, la risposta parte
// comunque (con il path grezzo invece di un URL funzionante: un'immagine
// rotta è preferibile a bloccare l'intera risposta API).
function resolveWorkerPhotoUrlsMiddleware(supabase) {
  return function (req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      resolvePhotoUrlsInBody(supabase, body)
        .then(resolved => originalJson(resolved))
        .catch(e => {
          console.error('[workerPhotoUrl] middleware fallito, invio risposta originale:', e.message);
          originalJson(body);
        });
      return res;
    };
    next();
  };
}

module.exports = { resolveWorkerPhotoUrlsMiddleware, resolvePhotoUrlsInBody, BUCKET, SIGNED_URL_TTL_SECS };
