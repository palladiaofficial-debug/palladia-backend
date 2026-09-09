#!/usr/bin/env node
/**
 * scripts/backfill-198-rain-threshold-inps.js
 *
 * F-160 (AUDIT.md): applica il nuovo default (1mm, criteri INPS msg.
 * 28336/1998) ai cantieri esistenti che sono ancora sul vecchio default mai
 * personalizzato (weather_rain_mm = 10 esatto) — decisione esplicita
 * dell'utente, 2026-09-09, consapevole che questo fa riemergere giorni di
 * pioggia storici mai valutati con la soglia corretta.
 *
 * Per ogni cantiere aggiornato, ricalcola anche i log storici MAI decisi da
 * un umano (reevaluateUndecidedWeatherLogs — non tocca mai un giorno già
 * confermato/ignorato).
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { reevaluateUndecidedWeatherLogs } = require('../services/weatherThresholdChange');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: sites, error } = await admin
    .from('sites')
    .select('id, name, company_id, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm')
    .eq('weather_rain_mm', 10);
  if (error) throw error;
  console.log(`Cantieri sul vecchio default (weather_rain_mm=10): ${sites.length}`);

  let totalChanged = 0;
  for (const site of sites) {
    const { error: updErr } = await admin.from('sites').update({ weather_rain_mm: 1 }).eq('id', site.id);
    if (updErr) { console.error(`  ERRORE ${site.name}: ${updErr.message}`); continue; }
    const thresholds = {
      rain_mm: 1,
      wind_kmh: site.weather_wind_kmh ?? 50,
      snow: site.weather_snow ?? true,
      thunderstorm: site.weather_thunderstorm ?? true,
    };
    const { changed } = await reevaluateUndecidedWeatherLogs(site.id, site.company_id, site.name, thresholds);
    if (changed > 0) console.log(`  ${site.name}: soglia 10→1mm, ${changed} giorni storici ricalcolati`);
    totalChanged += changed;
  }
  console.log(`\nCompletato: ${sites.length} cantieri aggiornati a 1mm, ${totalChanged} giorni storici ricalcolati in totale.`);
}

main().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
