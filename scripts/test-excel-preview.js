'use strict';
require('dotenv').config();

// Mock supabase before requiring the service
const Module = require('module');
const origLoad = Module._load;
Module._load = function(req, ...args) {
  if (req === '../lib/supabase' || req === '../../lib/supabase') {
    return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({}) }) }) }) };
  }
  return origLoad.call(this, req, ...args);
};

const { generateWorkerHoursXlsx } = require('../services/workerHoursReport');
const fs = require('fs');
const path = require('path');

const now = new Date().toISOString();

const fakeData = {
  site:    { id: 'test', name: 'Cantiere Via Roma 14, Milano', address: 'Via Roma 14, 20100 Milano MI' },
  company: { name: 'Edil Rossi S.r.l.' },
  period:  { from: '2026-05-01', to: '2026-05-31', formatted: '01/05/2026 — 31/05/2026' },
  generated_at: now,
  totals: {
    workers_count:          3,
    grand_total_minutes:    3240,
    grand_total_str:        '54h 00m',
    grand_overtime_minutes: 120,
    grand_overtime_str:     '2h 00m',
  },
  workers: [
    {
      id: 'w1', full_name: 'Luigi Esposito', fiscal_code: 'SPSLGU85M10F839X',
      total_days: 10, total_minutes: 1440, total_hours: 24.00, total_hours_str: '24h 00m',
      overtime_minutes: 120, overtime_str: '2h 00m', overtime_days: 2,
      days: [
        {
          date_key: '2026-05-02', date_formatted: '02/05/2026', weekday: 'Ven',
          entries: [{ entry_time: '07:58', exit_time: '17:02', minutes: 544, hours_str: '9h 04m', anomaly: null }],
          day_total_minutes: 544, day_total_str: '9h 04m', has_anomaly: false,
          is_overtime: true, overtime_minutes: 64,
        },
        {
          date_key: '2026-05-05', date_formatted: '05/05/2026', weekday: 'Lun',
          entries: [{ entry_time: '08:01', exit_time: '17:00', minutes: 539, hours_str: '8h 59m', anomaly: null }],
          day_total_minutes: 539, day_total_str: '8h 59m', has_anomaly: false,
          is_overtime: true, overtime_minutes: 59,
        },
        {
          date_key: '2026-05-06', date_formatted: '06/05/2026', weekday: 'Mar',
          entries: [{ entry_time: '08:10', exit_time: null, minutes: 0, hours_str: '—', anomaly: 'Uscita non registrata' }],
          day_total_minutes: 0, day_total_str: '—', has_anomaly: true,
          is_overtime: false, overtime_minutes: 0,
        },
        {
          date_key: '2026-05-07', date_formatted: '07/05/2026', weekday: 'Mer',
          entries: [
            { entry_time: '07:55', exit_time: '12:30', minutes: 275, hours_str: '4h 35m', anomaly: null },
            { entry_time: '13:30', exit_time: '17:00', minutes: 210, hours_str: '3h 30m', anomaly: null },
          ],
          day_total_minutes: 485, day_total_str: '8h 05m', has_anomaly: false,
          is_overtime: true, overtime_minutes: 5,
        },
      ],
    },
    {
      id: 'w2', full_name: 'Marco Ricci', fiscal_code: 'RCCMRC90D15H501Z',
      total_days: 8, total_minutes: 1080, total_hours: 18.00, total_hours_str: '18h 00m',
      overtime_minutes: 0, overtime_str: null, overtime_days: 0,
      days: [
        {
          date_key: '2026-05-05', date_formatted: '05/05/2026', weekday: 'Lun',
          entries: [{ entry_time: '08:00', exit_time: '16:00', minutes: 480, hours_str: '8h 00m', anomaly: null }],
          day_total_minutes: 480, day_total_str: '8h 00m', has_anomaly: false,
          is_overtime: false, overtime_minutes: 0,
        },
        {
          date_key: '2026-05-08', date_formatted: '08/05/2026', weekday: 'Gio',
          entries: [{ entry_time: '08:15', exit_time: '14:15', minutes: 360, hours_str: '6h 00m', anomaly: null }],
          day_total_minutes: 360, day_total_str: '6h 00m', has_anomaly: false,
          is_overtime: false, overtime_minutes: 0,
        },
      ],
    },
    {
      id: 'w3', full_name: 'Ahmed Hassan', fiscal_code: 'HSSMHD88C20Z330P',
      total_days: 12, total_minutes: 720, total_hours: 12.00, total_hours_str: '12h 00m',
      overtime_minutes: 0, overtime_str: null, overtime_days: 0,
      days: [
        {
          date_key: '2026-05-02', date_formatted: '02/05/2026', weekday: 'Ven',
          entries: [{ entry_time: '07:45', exit_time: '15:45', minutes: 480, hours_str: '8h 00m', anomaly: null }],
          day_total_minutes: 480, day_total_str: '8h 00m', has_anomaly: false,
          is_overtime: false, overtime_minutes: 0,
        },
        {
          date_key: '2026-05-09', date_formatted: '09/05/2026', weekday: 'Ven',
          entries: [{ entry_time: '07:50', exit_time: '11:50', minutes: 240, hours_str: '4h 00m', anomaly: null }],
          day_total_minutes: 240, day_total_str: '4h 00m', has_anomaly: false,
          is_overtime: false, overtime_minutes: 0,
        },
      ],
    },
  ],
};

(async () => {
  const buf = await generateWorkerHoursXlsx(fakeData);
  const outPath = path.join('C:/Users/ricka/Desktop', 'palladia-preview-ore.xlsx');
  fs.writeFileSync(outPath, buf);
  console.log('File salvato:', outPath);
})();
