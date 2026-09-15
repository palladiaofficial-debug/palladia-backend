'use strict';
// Scarica UNA VOLTA l'elenco completo delle stazioni ARPAL (tutte le
// province liguri) + le coordinate di ciascuna, per costruire un file di
// riferimento statico (data/arpal_stations.json) usato dal cron di
// automazione — evita di dipendere dal portale ARPAL per la geocodifica ad
// ogni esecuzione, solo per il fetch dei dati.
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BASE = 'https://ambientepub.regione.liguria.it/SiraQualMeteo/script';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dmsToDecimal(str) {
  // "8° 56' 45.276''" -> 8.9459... — separatori non-cifra generici: la
  // pagina ARPAL serve il simbolo di grado in una codifica che arriva
  // mangled se letta come UTF-8, più robusto ignorare cosa sia esattamente.
  const m = str.match(/(-?\d+)\D+(\d+)\D+?([\d.]+)/);
  if (!m) return null;
  const [, deg, min, sec] = m;
  return Number(deg) + Number(min) / 60 + Number(sec) / 3600;
}

async function main() {
  const jar = [];
  const cookieHeader = () => jar.join('; ');
  const fetchOpts = (extra = {}) => ({
    headers: { 'User-Agent': UA, Cookie: cookieHeader() },
    ...extra,
  });

  // Step 1: elenco stazioni (tutte le province in una risposta sola)
  const listRes = await fetch(`${BASE}/PubAccessoDatiMeteo12.asp`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'TipoTema=STAZIONE&Azione=&CodRete=&CodTema=STAZIONE',
  });
  const setCookie = listRes.headers.get('set-cookie');
  if (setCookie) jar.push(setCookie.split(';')[0]);
  const listHtml = await listRes.text();

  const stations = [];
  const re = /<OPTION VALUE="([A-Za-z0-9]+)"(?:\s+SELECTED)?>([^(<]+)\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(listHtml))) {
    stations.push({ code: m[1], name: m[2].trim(), province: m[3].trim() });
  }
  console.log(`Trovate ${stations.length} stazioni.`);

  // Step 2: coordinate per ciascuna (pagina dettaglio annali)
  const out = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    try {
      const res = await fetch(`${BASE}/../script_annali/StazioneCMIRL.asp?stazione=${s.code}`, fetchOpts());
      const html = await res.text();
      const lonM = html.match(/Longitudine[\s\S]{0,120}?Gradi[\s\S]{0,20}?<\/TD>\s*<TD[^>]*>([^<]+)</i);
      const latM = html.match(/Latitudine[\s\S]{0,120}?Gradi[\s\S]{0,20}?<\/TD>\s*<TD[^>]*>([^<]+)</i);
      const lon = lonM ? dmsToDecimal(lonM[1]) : null;
      const lat = latM ? dmsToDecimal(latM[1]) : null;
      if (lat != null && lon != null) {
        out.push({ ...s, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
      } else {
        console.warn(`  [skip] ${s.code} ${s.name}: coordinate non trovate`);
      }
    } catch (err) {
      console.warn(`  [errore] ${s.code} ${s.name}: ${err.message}`);
    }
    if (i % 20 === 0) console.log(`  ${i}/${stations.length}...`);
    await sleep(250); // non martellare il portale
  }

  const outPath = path.join(__dirname, '../data/arpal_stations.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Scritte ${out.length}/${stations.length} stazioni con coordinate in ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
