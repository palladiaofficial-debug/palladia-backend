'use strict';
const { z } = require('zod');

const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /consultant/onboard
const onboardConsultantSchema = z.object({
  company_name:          z.string().trim().min(2).max(200).optional(),
  vat_number:            nullableStr(30),
  registration_number:   nullableStr(50),
  operative_regions:     z.array(z.string().trim().max(100)).optional(),
  bio:                   z.string().trim().max(3000).nullable().optional(),
  photo_url:             nullableStr(500),
  accreditation_bodies:  z.array(z.string().trim().max(200)).optional(),
  years_experience:      z.number().int().min(0).max(70).nullable().optional(),
});

// PUT /consultant/me
const putConsultantProfileSchema = z.object({
  company_name:          z.string().trim().min(2).max(200).optional(),
  vat_number:            nullableStr(30),
  registration_number:   nullableStr(50),
  operative_regions:     z.array(z.string().trim().max(100)).optional(),
  bio:                   z.string().trim().max(3000).nullable().optional(),
  photo_url:             nullableStr(500),
  accreditation_bodies:  z.array(z.string().trim().max(200)).optional(),
  years_experience:      z.number().int().min(0).max(70).nullable().optional(),
}).strip();

// POST /consultant/clients/invite
const inviteClientSchema = z.object({
  company_id:   z.string().uuid('UUID non valido').optional(),
  invite_email: z.string().trim().email('email non valida').max(320).optional(),
}).strip().refine(
  data => data.company_id || data.invite_email,
  { message: 'company_id o invite_email obbligatorio' }
);

// PUT /consultant/clients/:id
const putClientRelationSchema = z.object({
  status:                 z.enum(['pending', 'active', 'inactive']).optional(),
  can_view_workers:       z.boolean().optional(),
  can_view_certificates:  z.boolean().optional(),
  can_view_sites:         z.boolean().optional(),
}).strip();

module.exports = {
  onboardConsultantSchema,
  putConsultantProfileSchema,
  inviteClientSchema,
  putClientRelationSchema,
};
