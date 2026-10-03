'use strict';
/**
 * lib/psc/contesto.js — F-270. "Il contesto si scrive da solo": dall'indirizzo
 * del cantiere a ciò che c'è intorno (Allegato XV, 2.2.1), da OpenStreetMap.
 *  - Nominatim: indirizzo → coordinate;
 *  - Overpass: strade, fermate, ferrovie, scuole, ospedali, linee elettriche,
 *    corsi d'acqua nel raggio di qualche decina/centinaio di metri;
 *  - pronto soccorso più vicino (ospedale con emergency=yes).
 * Ogni dato porta la sua fonte e la distanza. Quello che la mappa non può
 * sapere (linee aeree non mappate, sottoservizi, stato dei confinanti) va
 * nella lista del primo sopralluogo, non viene mai dato per verificato.
 */
const { CONTESTO, DA_SOPRALLUOGO } = require('./catalog');

const UA = 'Palladia/1.0 (https://palladia.net; info@palladia.net)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocode(address, fetchImpl = fetch) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&addressdetails=1&countrycodes=it&q=${encodeURIComponent(address)}`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`geocoding ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const a = arr[0], ad = a.address || {};
  return {
    lat: Number(a.lat), lon: Number(a.lon),
    comune: ad.city || ad.town || ad.village || ad.municipality || null,
    provincia: ad.county || null,
    display: a.display_name,
  };
}

async function overpass(query, fetchImpl = fetch) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetchImpl(url, {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { lastErr = new Error(`overpass ${r.status}`); continue; }
      const j = await r.json();
      return Array.isArray(j.elements) ? j.elements : [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('overpass non raggiungibile');
}

const coordOf = (el) => (el.center ? [el.center.lat, el.center.lon] : [el.lat, el.lon]);
const nameOf = (el) => (el.tags && (el.tags.name || el.tags.ref)) || null;

/** Dai risultati grezzi di Overpass ai rischi dell'area. Pura (testabile). */
function interpreta(elements, lat, lon) {
  const best = new Map(); // key → {dist, nome}
  const put = (key, el) => {
    const [la, lo] = coordOf(el);
    if (la == null || lo == null) return;
    const dist = Math.round(haversine(lat, lon, la, lo));
    const cur = best.get(key);
    if (!cur || dist < cur.dist) best.set(key, { dist, nome: nameOf(el) });
  };
  let dentroScuola = false, dentroOspedale = false;
  for (const el of elements) {
    const t = el.tags || {};
    if (t.highway && /^(motorway|trunk|primary|secondary)$/.test(t.highway)) put('strada_traffico', el);
    else if (t.highway && /^(tertiary|residential|unclassified|living_street)$/.test(t.highway)) put('strada', el);
    if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && (t.bus === 'yes' || t.tram === 'yes'))) put('fermata_bus', el);
    if (t.railway && /^(rail|light_rail|tram|subway)$/.test(t.railway)) put('ferrovia', el);
    if (t.amenity && /^(school|kindergarten|college)$/.test(t.amenity)) { put('scuola', el); const [la, lo] = coordOf(el); if (la != null && haversine(lat, lon, la, lo) < 40) dentroScuola = true; }
    if (t.amenity && /^(hospital|clinic|nursing_home)$/.test(t.amenity)) { put('ospedale', el); const [la, lo] = coordOf(el); if (la != null && haversine(lat, lon, la, lo) < 40) dentroOspedale = true; }
    if (t.power && /^(line|minor_line)$/.test(t.power)) put('linee_aeree', el);
    if (t.waterway && /^(river|stream|canal)$/.test(t.waterway)) put('corsi_acqua', el);
  }
  // Una strada trafficata assorbe quella "semplice"
  if (best.has('strada_traffico')) best.delete('strada');
  const desc = {
    strada_traffico: (b) => `${b.nome ? `${b.nome}, ` : ''}a ${b.dist} m`,
    strada: (b) => `${b.nome ? `${b.nome}, ` : ''}a ${b.dist} m`,
    fermata_bus: (b) => `a ${b.dist} m${b.nome ? ` (${b.nome})` : ''}`,
    ferrovia: (b) => `a ${b.dist} m`,
    scuola: (b) => `${b.nome || 'Edificio scolastico'} a ${b.dist} m`,
    ospedale: (b) => `${b.nome || 'Struttura sanitaria'} a ${b.dist} m`,
    linee_aeree: (b) => `linea mappata a ${b.dist} m: va verificata al sopralluogo`,
    corsi_acqua: (b) => `${b.nome || 'corso d\'acqua'} a ${b.dist} m`,
  };
  const trovati = [];
  for (const [key, b] of best) {
    const c = CONTESTO[key];
    trovati.push({ key, titolo: c.titolo, dettaglio: desc[key](b), distanza_m: b.dist, fonte: 'OpenStreetMap', attivo: true, misure: c.misure });
  }
  trovati.sort((a, b) => a.distanza_m - b.distanza_m);
  return { trovati, dentroScuola, dentroOspedale };
}

async function prontoSoccorso(lat, lon, fetchImpl = fetch) {
  const q = `[out:json][timeout:25];nwr(around:25000,${lat},${lon})[amenity=hospital][emergency=yes];out tags center 40;`;
  const els = await overpass(q, fetchImpl);
  let best = null;
  for (const el of els) {
    const [la, lo] = coordOf(el);
    if (la == null) continue;
    const d = haversine(lat, lon, la, lo);
    if (!best || d < best.d) best = { d, el };
  }
  if (!best) return null;
  const t = best.el.tags || {};
  // Stima prudente su strada: distanza in linea d'aria × 1,4, 30 km/h in città.
  const km = Math.round((best.d * 1.4) / 100) / 10;
  return {
    nome: t.name || 'Pronto soccorso',
    indirizzo: [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' ') || null,
    distanza_km: km,
    minuti: Math.max(3, Math.round((km / 30) * 60)),
    fonte: 'OpenStreetMap',
  };
}

/**
 * @returns {Promise<object>} contesto da salvare in psc_projects.contesto (più lat/lon/comune)
 */
async function analizza(address, { fetchImpl = fetch, prev = {} } = {}) {
  const geo = await geocode(address, fetchImpl);
  if (!geo) return { ok: false, error: 'INDIRIZZO_NON_TROVATO' };
  const { lat, lon } = geo;
  const q = `[out:json][timeout:25];(
way(around:70,${lat},${lon})[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"];
node(around:150,${lat},${lon})[highway=bus_stop];
node(around:150,${lat},${lon})[public_transport=platform];
way(around:200,${lat},${lon})[railway~"^(rail|light_rail|tram|subway)$"];
nwr(around:200,${lat},${lon})[amenity~"^(school|kindergarten|college)$"];
nwr(around:250,${lat},${lon})[amenity~"^(hospital|clinic|nursing_home)$"];
way(around:120,${lat},${lon})[power~"^(line|minor_line)$"];
way(around:100,${lat},${lon})[waterway~"^(river|stream|canal)$"];
);out tags center 80;`;
  const els = await overpass(q, fetchImpl);
  const { trovati, dentroScuola, dentroOspedale } = interpreta(els, lat, lon);
  let ps = null;
  try { ps = await prontoSoccorso(lat, lon, fetchImpl); } catch { ps = null; }

  // Le risposte già date dal coordinatore restano.
  const domande = { ...(prev.domande || {}) };
  if (!('edificio_in_uso' in domande)) domande.edificio_in_uso = null;
  const trovatiKeys = new Set(trovati.map(t => t.key));
  const daSopr = DA_SOPRALLUOGO.map(d => {
    const old = (prev.da_sopralluogo || []).find(x => x.key === d.key);
    return { key: d.key, titolo: CONTESTO[d.key].titolo, domanda: d.domanda, verificato: old ? !!old.verificato : false, mappata: trovatiKeys.has(d.key) };
  });
  return {
    ok: true, lat, lon, comune: geo.comune, provincia: geo.provincia,
    contesto: {
      analizzato: true, analizzato_at: new Date().toISOString(), fonte: 'OpenStreetMap', indirizzo_trovato: geo.display,
      trovati, domande, da_sopralluogo: daSopr,
      suggerimento_domanda: dentroScuola ? 'scuola' : dentroOspedale ? 'ospedale' : null,
    },
    pronto_soccorso: ps,
  };
}

/** Chiavi di rischio attive (trovati accesi + risposte "sì") — per i costi. */
function chiaviAttive(contesto) {
  const s = new Set();
  for (const t of (contesto && contesto.trovati) || []) if (t.attivo !== false) s.add(t.key);
  const d = (contesto && contesto.domande) || {};
  for (const [k, v] of Object.entries(d)) if (v === true) s.add(k);
  return s;
}

module.exports = { analizza, interpreta, haversine, chiaviAttive, geocode };
