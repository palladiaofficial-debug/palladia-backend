'use strict';
const { z } = require('zod');

const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /marketplace/courses/:id/request-quote (impresa)
const requestQuoteSchema = z.object({
  participants_count: z.number().int().min(1).max(200),
  site_address:       z.string().trim().min(1).max(300),
  preferred_dates:    nullableStr(300),
  notes:              z.string().trim().max(2000).nullable().optional(),
});

// PATCH /consultant/quotes/:id/respond (consulente)
const respondQuoteSchema = z.object({
  quoted_price_cents: z.number().int().min(100),
  quoted_message:     z.string().trim().max(2000).nullable().optional(),
}).strip();

module.exports = {
  requestQuoteSchema,
  respondQuoteSchema,
};
