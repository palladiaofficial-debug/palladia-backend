'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /subcontractors
const createSubcontractorSchema = z.object({
  company_name:    z.string().trim().min(1, 'company_name obbligatorio').max(200),
  piva:            nullableStr(20),
  legal_address:   nullableStr(300),
  contact_person:  nullableStr(150),
  phone:           nullableStr(30),
  email:           z.string().trim().email().max(150).nullable().optional(),
  durc_expiry:     dateField,
  visura_date:     dateField,
  insurance_expiry: dateField,
  soa_expiry:      dateField,
  f24_quarter:     nullableStr(20),
  notify_expiry:   z.boolean().optional(),
  notes:           nullableStr(1000),
});

// PATCH /subcontractors/:id
const patchSubcontractorSchema = z.object({
  company_name:    z.string().trim().min(1).max(200).optional(),
  piva:            nullableStr(20),
  legal_address:   nullableStr(300),
  contact_person:  nullableStr(150),
  phone:           nullableStr(30),
  email:           z.string().trim().email().max(150).nullable().optional(),
  durc_expiry:     dateField,
  visura_date:     dateField,
  insurance_expiry: dateField,
  soa_expiry:      dateField,
  f24_quarter:     nullableStr(20),
  notify_expiry:   z.boolean().nullable().optional(),
  notes:           nullableStr(1000),
  is_active:       z.boolean().nullable().optional(),
}).strip();

// POST /sites/:siteId/subcontractors
const assignSubcontractorSchema = z.object({
  subcontractor_id: z.string().uuid('subcontractor_id deve essere UUID'),
  role:             z.string().trim().max(100).nullable().optional(),
});

// PATCH /workers/:workerId/subcontractor
const linkSubcontractorSchema = z.object({
  subcontractor_id: z.string().uuid().nullable().optional(),
}).strip();

module.exports = {
  createSubcontractorSchema,
  patchSubcontractorSchema,
  assignSubcontractorSchema,
  linkSubcontractorSchema,
};
