'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));

// POST /worker-invite-links
const createInviteLinkSchema = z.object({
  site_id:         z.string().uuid().nullable().optional(),
  expires_in_days: z.number().int().min(1).max(30).default(7),
  max_uses:        z.number().int().min(1).max(50).default(1),
}).strip();

// PATCH /workers/:id/approve
const approveWorkerSchema = z.object({
  action: z.enum(['approve', 'reject']),
}).strip();

// POST /onboard/:token
const onboardWorkerSchema = z.object({
  full_name:     z.string().trim().min(1, 'full_name obbligatorio').max(200),
  fiscal_code:   z.string().trim().min(1, 'fiscal_code obbligatorio').max(20),
  phone:         z.string().trim().max(30).nullable().optional(),
  qualification: z.string().trim().max(200).nullable().optional(),
  hire_date:     dateField,
  photo_base64:  z.string().nullable().optional(),
}).strip();

module.exports = { createInviteLinkSchema, approveWorkerSchema, onboardWorkerSchema };
