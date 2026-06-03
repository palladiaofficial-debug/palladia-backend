'use strict';
const { z } = require('zod');

const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /bookings/checkout
const checkoutBookingSchema = z.object({
  session_id:  z.string().uuid('UUID non valido'),
  worker_ids:  z.array(z.string().uuid('UUID non valido')).min(1).max(50),
  site_id:     z.string().uuid('UUID non valido').nullable().optional(),
  notes:       z.string().trim().max(1000).nullable().optional(),
});

// POST /bookings/:id/review
const reviewBookingSchema = z.object({
  rating:  z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).nullable().optional(),
});

module.exports = {
  checkoutBookingSchema,
  reviewBookingSchema,
};
