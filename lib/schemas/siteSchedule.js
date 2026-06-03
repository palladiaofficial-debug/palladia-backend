'use strict';
const { z } = require('zod');

const VALID_REASONS = ['pioggia', 'vento', 'neve', 'altro'];

// ── POST /api/v1/sites/:siteId/suspension-days ────────────────────────────────
const createSuspensionDaySchema = z.object({
  day:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD'),
  reason: z.enum(VALID_REASONS).optional(),
  notes:  z.string().trim().max(1000).nullable().optional(),
}).strip();

module.exports = { createSuspensionDaySchema };
