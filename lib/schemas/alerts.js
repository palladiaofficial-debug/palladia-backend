'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /alerts/check-missing-exits
const checkMissingExitsSchema = z.object({
  date:   z.string().regex(DATE_RE, 'date obbligatorio (YYYY-MM-DD)'),
  siteId: z.string().uuid().nullable().optional(),
  notify: z.boolean().optional(),
});

module.exports = { checkMissingExitsSchema };
