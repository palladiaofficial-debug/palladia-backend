'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField    = z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional();
const nullableStr  = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /formazione/provider/register
const registerProviderSchema = z.object({
  email:                z.string().trim().email('email non valida').max(320),
  name:                 z.string().trim().min(2).max(200),
  city:                 z.string().trim().min(1).max(100),
  province:             z.string().trim().min(1).max(10),
  phone:                nullableStr(30),
  website:              nullableStr(300),
  accreditation_code:   nullableStr(100),
  accreditation_region: nullableStr(100),
});

// POST /formazione/provider/request-link
const requestLinkSchema = z.object({
  email: z.string().trim().email('email non valida').max(320),
});

// PATCH /formazione/provider/:token/profile
const patchProviderProfileSchema = z.object({
  name:                 z.string().trim().min(2).max(200).optional(),
  phone:                nullableStr(30),
  website:              nullableStr(300),
  address:              nullableStr(300),
  bio:                  z.string().trim().max(2000).nullable().optional(),
  logo_url:             nullableStr(500),
  accreditation_code:   nullableStr(100),
  accreditation_region: nullableStr(100),
  location_city:        z.string().trim().max(100).nullable().optional(),
  location_province:    z.string().trim().max(10).nullable().optional(),
}).strip();

// POST /formazione/provider/:token/courses
const createProviderCourseSchema = z.object({
  title:                   z.string().trim().min(3).max(200),
  course_type_id:          z.string().uuid('UUID non valido'),
  price_cents:             z.number().int().min(0),
  description:             z.string().trim().max(2000).nullable().optional(),
  delivery_mode:           z.enum(['in_aula', 'online', 'blended']).optional(),
  location_city:           nullableStr(100),
  duration_hours:          z.number().int().min(1).optional(),
  max_participants:        z.number().int().min(1).nullable().optional(),
  includes_exam:           z.boolean().optional(),
  certificate_issued_days: z.number().int().min(1).optional(),
});

// PUT /formazione/provider/:token/courses/:courseId
const putProviderCourseSchema = z.object({
  title:                   z.string().trim().min(3).max(200).optional(),
  description:             z.string().trim().max(2000).nullable().optional(),
  price_cents:             z.number().int().min(0).optional(),
  delivery_mode:           z.enum(['in_aula', 'online', 'blended']).optional(),
  location_city:           nullableStr(100),
  duration_hours:          z.number().int().min(1).optional(),
  max_participants:        z.number().int().min(1).nullable().optional(),
  includes_exam:           z.boolean().optional(),
  certificate_issued_days: z.number().int().min(1).optional(),
}).strip();

// POST /formazione/provider/:token/courses/:courseId/sessions
const createProviderSessionSchema = z.object({
  start_date:        z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  end_date:          dateField,
  available_spots:   z.number().int().min(1).optional(),
  notes:             z.string().trim().max(500).nullable().optional(),
  location_override: nullableStr(200),
});

// PATCH /formazione/provider/:token/courses/:courseId/sessions/:sessionId
const patchProviderSessionSchema = z.object({
  start_date:        z.string().regex(DATE_RE, 'formato YYYY-MM-DD').optional(),
  end_date:          dateField,
  available_spots:   z.number().int().min(1).optional(),
  notes:             z.string().trim().max(500).nullable().optional(),
  location_override: nullableStr(200),
}).strip();

// PATCH /formazione/provider/:token/bookings/:bookingId/complete
const completeProviderBookingSchema = z.object({
  certificate_number: nullableStr(100),
  notes:              z.string().trim().max(1000).nullable().optional(),
}).strip();

module.exports = {
  registerProviderSchema,
  requestLinkSchema,
  patchProviderProfileSchema,
  createProviderCourseSchema,
  putProviderCourseSchema,
  createProviderSessionSchema,
  patchProviderSessionSchema,
  completeProviderBookingSchema,
};
