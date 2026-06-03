'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 5000) => z.string().trim().max(max).nullable().optional();

// Snapshot lavoratore nel diario
const workerSnapshotSchema = z.object({
  id:    z.string().optional(),
  name:  z.string().max(200).optional(),
  hours: z.number().nullable().optional(),
}).passthrough();

// Snapshot macchinario nel diario
const machinerySnapshotSchema = z.object({
  id:   z.string().optional(),
  name: z.string().max(200).optional(),
  type: z.string().max(100).optional(),
}).passthrough();

// Snapshot subappaltatore nel diario
const subSnapshotSchema = z.object({
  id:   z.string().optional(),
  name: z.string().max(200).optional(),
}).passthrough();

// ── POST /api/v1/sites/:siteId/diary ──────────────────────────────────────────
const upsertDiarySchema = z.object({
  entry_date:               z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  weather_code:             z.number().int().nullable().optional(),
  weather_desc:             nullableStr(200),
  temp_min:                 z.number().nullable().optional(),
  temp_max:                 z.number().nullable().optional(),
  precipitation_mm:         z.number().min(0).nullable().optional(),
  wind_max_kmh:             z.number().min(0).nullable().optional(),
  activities:               nullableStr(10000),
  issues:                   nullableStr(10000),
  decisions:                nullableStr(10000),
  materials:                nullableStr(10000),
  notes:                    nullableStr(10000),
  workers_snapshot:         z.array(workerSnapshotSchema).optional(),
  machinery_snapshot:       z.array(machinerySnapshotSchema).optional(),
  subcontractors_snapshot:  z.array(subSnapshotSchema).optional(),
  work_hours_total:         z.number().min(0).nullable().optional(),
  photos:                   z.array(z.string()).optional(),
}).strip();

// ── DELETE /api/v1/sites/:siteId/diary/photos ─────────────────────────────────
// Body: { path: string }
const deletePhotoSchema = z.object({
  path: z.string().trim().min(1).max(500),
}).strip();

module.exports = { upsertDiarySchema, deletePhotoSchema };
