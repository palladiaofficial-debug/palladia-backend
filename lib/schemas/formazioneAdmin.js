'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /admin/providers
const createAdminProviderSchema = z.object({
  name:                  z.string().trim().min(2).max(200),
  email:                 z.string().trim().email('email non valida').max(320),
  location_city:         z.string().trim().min(1).max(100),
  location_province:     z.string().trim().min(1).max(10),
  description:           z.string().trim().max(2000).nullable().optional(),
  logo_url:              nullableStr(500),
  address:               nullableStr(300),
  phone:                 nullableStr(30),
  website:               nullableStr(300),
  accreditation_code:    nullableStr(100),
  accreditation_region:  nullableStr(100),
  is_featured:           z.boolean().optional(),
  commission_rate:       z.number().min(0).max(100).optional(),
});

// PUT /admin/providers/:id
const putAdminProviderSchema = z.object({
  name:                  z.string().trim().min(2).max(200).optional(),
  email:                 z.string().trim().email('email non valida').max(320).optional(),
  description:           z.string().trim().max(2000).nullable().optional(),
  logo_url:              nullableStr(500),
  location_city:         z.string().trim().max(100).nullable().optional(),
  location_province:     z.string().trim().max(10).nullable().optional(),
  address:               nullableStr(300),
  phone:                 nullableStr(30),
  website:               nullableStr(300),
  accreditation_code:    nullableStr(100),
  accreditation_region:  nullableStr(100),
  is_featured:           z.boolean().optional(),
  is_active:             z.boolean().optional(),
  commission_rate:       z.number().min(0).max(100).optional(),
  rating:                z.number().min(0).max(5).nullable().optional(),
  total_reviews:         z.number().int().min(0).optional(),
}).strip();

// POST /admin/providers/:id/courses
const createAdminCourseSchema = z.object({
  course_type_id:          z.string().uuid('UUID non valido'),
  title:                   z.string().trim().min(2).max(200),
  price_cents:             z.number().int().min(0),
  duration_hours:          z.number().int().min(1),
  description:             z.string().trim().max(2000).nullable().optional(),
  delivery_mode:           z.enum(['in_aula', 'online', 'blended']).optional(),
  location_city:           nullableStr(100),
  location_address:        nullableStr(300),
  max_participants:        z.number().int().min(1).nullable().optional(),
  includes_exam:           z.boolean().optional(),
  certificate_issued_days: z.number().int().min(1).optional(),
  is_featured:             z.boolean().optional(),
});

// PUT /admin/courses/:id
const putAdminCourseSchema = z.object({
  title:                   z.string().trim().min(2).max(200).optional(),
  description:             z.string().trim().max(2000).nullable().optional(),
  price_cents:             z.number().int().min(0).optional(),
  delivery_mode:           z.enum(['in_aula', 'online', 'blended']).optional(),
  location_city:           nullableStr(100),
  location_address:        nullableStr(300),
  duration_hours:          z.number().int().min(1).optional(),
  max_participants:        z.number().int().min(1).nullable().optional(),
  includes_exam:           z.boolean().optional(),
  certificate_issued_days: z.number().int().min(1).optional(),
  is_featured:             z.boolean().optional(),
  is_active:               z.boolean().optional(),
  course_type_id:          z.string().uuid('UUID non valido').optional(),
}).strip();

// POST /admin/courses/:id/sessions
const createAdminSessionSchema = z.object({
  start_date:        z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  end_date:          z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  available_spots:   z.number().int().min(1),
  location_override: nullableStr(300),
  notes:             z.string().trim().max(1000).nullable().optional(),
});

// PATCH /admin/bookings/:id/complete
const completeAdminBookingSchema = z.object({
  issue_date:         z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  issuing_body:       z.string().trim().min(1).max(200),
  certificate_number: nullableStr(100),
  pdf_url:            nullableStr(500),
}).strip();

module.exports = {
  createAdminProviderSchema,
  putAdminProviderSchema,
  createAdminCourseSchema,
  putAdminCourseSchema,
  createAdminSessionSchema,
  completeAdminBookingSchema,
};
