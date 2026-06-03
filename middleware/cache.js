'use strict';

/**
 * middleware/cache.js
 * Cache in-memory leggera per GET che non cambiano spesso.
 * Usa un Map con TTL per ogni entry — zero dipendenze extra.
 *
 * Uso:
 *   router.get('/sites', verifyJwt, cache(30), async (req, res) => { ... })
 *
 * La chiave di cache include company_id + query string, quindi ogni company
 * ha la sua cache isolata. Il cache viene invalidato automaticamente alla scadenza.
 *
 * Per invalidare manualmente (es. dopo un PATCH):
 *   const { invalidate } = require('../../middleware/cache');
 *   invalidate(req.companyId, '/sites');
 */

const store = new Map(); // key → { data, expiresAt }

function cache(ttlSeconds = 30) {
  return (req, res, next) => {
    // Cache solo GET autenticati
    if (req.method !== 'GET' || !req.companyId) return next();

    const key    = `${req.companyId}:${req.path}:${JSON.stringify(req.query)}`;
    const cached = store.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    // Intercetta res.json per salvare la risposta in cache
    const _json = res.json.bind(res);
    res.json = function (data) {
      if (res.statusCode === 200) {
        store.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
        // Cleanup automatico delle entry scadute ogni 100 scritture
        if (store.size % 100 === 0) {
          const now = Date.now();
          for (const [k, v] of store) {
            if (v.expiresAt < now) store.delete(k);
          }
        }
      }
      res.setHeader('X-Cache', 'MISS');
      return _json(data);
    };

    next();
  };
}

function invalidate(companyId, pathPrefix) {
  for (const key of store.keys()) {
    if (key.startsWith(`${companyId}:${pathPrefix}`)) {
      store.delete(key);
    }
  }
}

module.exports = { cache, invalidate };
