'use strict';
const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { computeAndStoreValueMetrics } = require('./valueMetrics');

async function runDailyStats() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD

  let companies;
  try {
    const { data, error } = await supabase.from('companies').select('id');
    if (error) throw error;
    companies = data ?? [];
  } catch (e) {
    console.error('[dailyStats] errore caricamento companies:', e.message);
    return;
  }

  let ok = 0;
  let okValueMetrics = 0;
  for (const { id } of companies) {
    try {
      const { error } = await supabase.rpc('compute_company_daily_stats', {
        p_company_id: id,
        p_date: dateStr,
      });
      if (error) throw error;
      ok++;
    } catch (e) {
      console.error('[dailyStats] company', id, 'errore:', e.message);
    }

    // Layer "proof of value" — indipendente dal calcolo sopra: un fallimento
    // qui non deve bloccare le daily stats esistenti, e viceversa.
    try {
      await computeAndStoreValueMetrics(id);
      okValueMetrics++;
    } catch (e) {
      console.error('[dailyStats] value-metrics company', id, 'errore:', e.message);
    }
  }

  console.log(`[dailyStats] ${ok}/${companies.length} companies aggiornate per ${dateStr}, value-metrics ${okValueMetrics}/${companies.length}`);
}

function startDailyStatsCron() {
  // Ogni notte alle 00:15 (Europe/Rome) — dopo la mezzanotte per avere tutti i dati del giorno
  cron.schedule('15 0 * * *', runDailyStats, { timezone: 'Europe/Rome' });
}

module.exports = { startDailyStatsCron };
