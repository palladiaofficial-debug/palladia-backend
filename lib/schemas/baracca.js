'use strict';
const { z } = require('zod');

// ── PATCH /api/v1/sites/:siteId/baracca/checklist ────────────────────────────
const patchChecklistSchema = z.object({
  item_key: z.string().trim().min(1).max(200),
  checked:  z.boolean().optional(),
}).strip();

module.exports = { patchChecklistSchema };
