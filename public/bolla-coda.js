/*
 * public/bolla-coda.js — F-500 (AUDIT.md del frontend): le bolle mandate
 * senza rete. Restano nel telefono (IndexedDB: le foto non stanno in
 * localStorage) e partono da sole appena c'è segnale: alla riapertura della
 * pagina della bolla, del badge, o quando torna la rete.
 * Ogni bolla ha il suo client_id: se un invio arriva al server ma la risposta
 * si perde, il nuovo tentativo non crea una seconda bolla (lib/bolleAutisti.js).
 * Incluso anche da badge-punch.html: non tocca nulla della timbratura, e se
 * qualcosa va storto qui non esce dal try/catch.
 */
(function () {
  'use strict';
  var DB = 'palladia_bolle', STORE = 'coda';

  function apri() {
    return new Promise(function (ok, ko) {
      if (!('indexedDB' in window)) return ko(new Error('no idb'));
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'client_id' }); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ko(r.error); };
    });
  }
  function tx(modo, fn) {
    return apri().then(function (db) {
      return new Promise(function (ok, ko) {
        var t = db.transaction(STORE, modo), st = t.objectStore(STORE), out;
        var req = fn(st);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { db.close(); ok(out); };
        t.onerror = function () { db.close(); ko(t.error); };
      });
    });
  }

  /** { client_id, code, site_id, pagine: [{ blob, type, name }], at } */
  function aggiungi(voce) { return tx('readwrite', function (st) { return st.put(voce); }); }
  function togli(id) { return tx('readwrite', function (st) { return st.delete(id); }); }
  function tutte() { return tx('readonly', function (st) { return st.getAll(); }).then(function (x) { return x || []; }); }
  function conta(code) { return tutte().then(function (x) { return x.filter(function (v) { return !code || v.code === code; }).length; }).catch(function () { return 0; }); }

  /** Una bolla al server. Ritorna la risposta (json) o lancia 'rete' se non c'è rete. */
  function manda(voce) {
    var fd = new FormData();
    voce.pagine.forEach(function (p, i) { fd.append('pagine', p.blob, p.name || ('pagina-' + (i + 1) + '.jpg')); });
    if (voce.site_id) fd.append('site_id', voce.site_id);
    fd.append('client_id', voce.client_id);
    return fetch('/api/v1/badge/' + encodeURIComponent(voce.code) + '/bolle', { method: 'POST', body: fd })
      .catch(function () { throw new Error('rete'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return j;
          var e = new Error(j && j.error || ('HTTP ' + r.status)); e.status = r.status; throw e;
        });
      });
  }

  var inCorso = false;
  /** Prova a mandare tutte quelle in attesa. Si ferma alla prima senza rete. */
  function svuota() {
    if (inCorso || (navigator.onLine === false)) return Promise.resolve(0);
    inCorso = true;
    var mandate = 0;
    return tutte().then(function (voci) {
      voci.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
      var i = 0;
      function prossima() {
        if (i >= voci.length) return mandate;
        var v = voci[i++];
        return manda(v).then(function () { mandate++; return togli(v.client_id).then(prossima); }, function (e) {
          // senza rete, server occupato o in errore: riprovo dopo
          if (e.message === 'rete' || e.status === 429 || !e.status || e.status >= 500) return mandate;
          // 4xx (badge revocato, file non valido): non ripartirà mai, la tolgo
          return togli(v.client_id).then(prossima);
        });
      }
      return prossima();
    }).catch(function () { return mandate; }).then(function (n) {
      inCorso = false;
      if (n) try { window.dispatchEvent(new CustomEvent('palladia-bolle-mandate', { detail: n })); } catch (e) { /* */ }
      return n;
    });
  }

  window.PalladiaBolleCoda = { aggiungi: aggiungi, svuota: svuota, conta: conta, manda: manda };
  try {
    window.addEventListener('online', function () { svuota(); });
    if (document.readyState === 'complete') setTimeout(svuota, 1500);
    else window.addEventListener('load', function () { setTimeout(svuota, 1500); });
  } catch (e) { /* mai bloccare la pagina che lo include */ }
})();
