'use strict';
/**
 * lib/errorBuffer.js
 * Ring buffer in memoria per gli ultimi N errori del server.
 * Alimentato dall'error handler Express in server.js.
 * Letto dal pannello owner Telegram con /errori.
 */

const MAX = 20;
const _buf = [];

function push(err, req) {
  _buf.unshift({
    ts:      new Date().toISOString(),
    message: err.message || String(err),
    stack:   (err.stack || '').split('\n').slice(0, 3).join(' | '),
    path:    req ? `${req.method} ${req.path}` : null,
    status:  err.status || 500,
  });
  if (_buf.length > MAX) _buf.pop();
}

function recent(n = 10) {
  return _buf.slice(0, n);
}

function clear() {
  _buf.length = 0;
}

module.exports = { push, recent, clear };
