'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'formato YYYY-MM-DD');

// ── POST /api/v1/sites/:siteId/weather-log/fetch ─────────────────────────────
// Body: { dates?: string[] }  — se assente usa ieri
const fetchWeatherSchema = z.object({
  dates: z.array(dateField).max(30).optional(),
}).strip();

// ── POST /api/v1/sites/:siteId/weather-log/:date/confirm ─────────────────────
// Body: { notes?: string }
const confirmSuspensionSchema = z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
}).strip();

module.exports = { fetchWeatherSchema, confirmSuspensionSchema };
