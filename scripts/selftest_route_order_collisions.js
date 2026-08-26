'use strict';
/**
 * BLOCCO 2 — pattern F-082/F-084: una route con segmento dinamico (es. /workers/:id)
 * registrata PRIMA di una route con segmento statico più specifico sullo stesso
 * prefisso (es. /workers/export) la intercetta silenziosamente — Express ferma
 * il matching alla prima route compatibile nell'ordine di registrazione.
 *
 * Questo script ricostruisce l'ordine GLOBALE di registrazione (tutti i router
 * in routes/v1/ sono montati a '/' da routes/v1/index.js, nello stesso ordine
 * dei require) e verifica, per ogni coppia di route con lo stesso metodo HTTP,
 * che nessuna route dinamica registrata prima possa intercettare una route
 * registrata dopo di lei.
 */
const fs = require('fs');
const path = require('path');
const { pathToRegexp } = require('path-to-regexp');

const ROUTES_DIR = path.join(__dirname, '..', 'routes', 'v1');
const INDEX_FILE = path.join(ROUTES_DIR, 'index.js');

function extractRequireOrder(indexSrc) {
  const re = /router\.use\(\s*(['"`])\/\1\s*,\s*require\(\s*(['"`])\.\/([\w-]+)\2\s*\)\s*\)/g;
  const files = [];
  let m;
  while ((m = re.exec(indexSrc))) files.push(m[3]);
  return files;
}

function extractRoutes(fileSrc, fileName) {
  const re = /router\.(get|post|put|patch|delete|all)\(\s*(['"`])((?:(?!\2).)*)\2/g;
  const routes = [];
  let m;
  while ((m = re.exec(fileSrc))) {
    const method = m[1].toUpperCase();
    const routePath = m[3];
    if (!routePath.startsWith('/')) continue; // ignora path-param stringhe non-URL passate per errore
    const lineNo = fileSrc.slice(0, m.index).split('\n').length;
    routes.push({ method, routePath, file: fileName, line: lineNo });
  }
  return routes;
}

function instancePath(routePath) {
  // sostituisce ogni :param con un token statico plausibile, per testare
  // se una route dinamica precedente la intercetterebbe.
  return routePath.replace(/:[\w]+/g, '__PROBE__');
}

function findCollisions(globalRoutes) {
  const collisions = [];
  const byMethod = new Map();
  for (const r of globalRoutes) {
    if (!byMethod.has(r.method)) byMethod.set(r.method, []);
    byMethod.get(r.method).push(r);
  }
  for (const [, routes] of byMethod) {
    for (let i = 0; i < routes.length; i++) {
      const earlier = routes[i];
      if (!earlier.routePath.includes(':')) continue; // solo route dinamiche possono "rubare" richieste
      let regexp;
      try {
        ({ regexp } = pathToRegexp(earlier.routePath));
      } catch {
        continue;
      }
      for (let j = i + 1; j < routes.length; j++) {
        const later = routes[j];
        if (later.routePath === earlier.routePath) continue; // duplicato esatto, non oggetto di questo controllo
        const probe = instancePath(later.routePath);
        if (regexp.test(probe)) {
          collisions.push({ earlier, later });
        }
      }
    }
  }
  return collisions;
}

function main() {
  const indexSrc = fs.readFileSync(INDEX_FILE, 'utf8');
  const fileOrder = extractRequireOrder(indexSrc);
  if (fileOrder.length < 50) {
    console.error(`[route-order] atteso ordine di require con decine di file, trovati solo ${fileOrder.length} — il pattern di parsing di routes/v1/index.js potrebbe essere cambiato.`);
    process.exit(1);
  }

  const globalRoutes = [];
  for (const f of fileOrder) {
    const filePath = path.join(ROUTES_DIR, `${f}.js`);
    if (!fs.existsSync(filePath)) continue;
    const src = fs.readFileSync(filePath, 'utf8');
    globalRoutes.push(...extractRoutes(src, `${f}.js`));
  }

  if (globalRoutes.length < 200) {
    console.error(`[route-order] atteso ordine globale con centinaia di route, trovate solo ${globalRoutes.length} — il parsing regex di router.METHOD(...) potrebbe essere cambiato.`);
    process.exit(1);
  }

  const collisions = findCollisions(globalRoutes);

  if (collisions.length > 0) {
    console.error(`[route-order] ${collisions.length} collisione/i di ordinamento route trovate (route dinamica registrata prima di una route più specifica che intercetta):\n`);
    for (const { earlier, later } of collisions) {
      console.error(
        `  ${later.method} ${later.routePath} (${later.file}:${later.line}) è INTERCETTATA da ` +
        `${earlier.method} ${earlier.routePath} (${earlier.file}:${earlier.line}), registrata prima nell'ordine globale di routes/v1/index.js`
      );
    }
    console.error(`\nSposta la route più specifica prima di quella dinamica (stesso pattern di fix di F-082/F-084), oppure riordina i require in routes/v1/index.js.`);
    process.exit(1);
  }

  console.log(`[route-order] OK — ${globalRoutes.length} route su ${fileOrder.length} file, nessuna collisione di ordinamento trovata.`);
}

main();
