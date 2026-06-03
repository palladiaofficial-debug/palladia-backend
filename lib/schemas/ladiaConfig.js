'use strict';
const { z } = require('zod');

// Regex HH:MM
const TIME_RE = /^\d{2}:\d{2}$/;

// POST /sites/:siteId/ladia/activate
const activateLadiaSchema = z.object({
  briefing_time: z.string().regex(TIME_RE, 'formato HH:MM').optional(),
});

module.exports = { activateLadiaSchema };
