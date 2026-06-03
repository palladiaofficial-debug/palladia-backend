'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional();
const nullableStr = (max = 500) => z.string().trim().max(max).nullable().optional();

// ── POST /api/v1/sites ────────────────────────────────────────────────────────
const createSiteSchema = z.object({
  name:                    z.string().trim().min(2, 'name: min 2 caratteri').max(200),
  address:                 nullableStr(),
  comune:                  nullableStr(200),
  client:                  nullableStr(500),
  status:                  z.enum(['attivo', 'sospeso', 'ultimato', 'chiuso']).optional(),
  start_date:              dateField,
  end_date:                dateField,
  contract_days:           z.number().int().positive().nullable().optional(),
  days_type:               z.enum(['solari', 'lavorativi']).optional(),
  referente_tecnico_id:    z.string().uuid().nullable().optional(),
  suolo_occupazione:       z.boolean().optional(),
  suolo_occupazione_start: nullableStr(),
  suolo_occupazione_end:   nullableStr(),
  suolo_occupazione_notes: nullableStr(2000),
});

// ── PATCH /api/v1/sites/:siteId ───────────────────────────────────────────────
// Tutte le chiavi sono opzionali; le soglie meteo accettano null/"" come reset.
const weatherNum = (min, max) =>
  z.union([
    z.literal(null),
    z.literal(''),
    z.number().min(min).max(max),
  ]).optional();

const patchSiteSchema = z.object({
  name:                    z.string().trim().max(200).optional(),
  address:                 nullableStr(),
  comune:                  nullableStr(200),
  client:                  nullableStr(500),
  status:                  z.enum(['attivo', 'sospeso', 'ultimato', 'chiuso']).optional(),
  start_date:              dateField,
  end_date:                dateField,
  contract_days:           z.number().int().positive().nullable().optional(),
  days_type:               z.enum(['solari', 'lavorativi']).optional(),
  referente_tecnico_id:    z.string().uuid().nullable().optional(),
  suolo_occupazione:       z.boolean().optional(),
  suolo_occupazione_start: nullableStr(),
  suolo_occupazione_end:   nullableStr(),
  suolo_occupazione_notes: nullableStr(2000),
  weather_rain_mm:         weatherNum(1, 200),
  weather_wind_kmh:        weatherNum(10, 200),
  weather_snow:            z.boolean().optional(),
  weather_thunderstorm:    z.boolean().optional(),
}).strip(); // rimuove campi non dichiarati (prevenzione injection)

module.exports = { createSiteSchema, patchSiteSchema };
