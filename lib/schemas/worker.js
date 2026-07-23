'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField   = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

const badgeFields = {
  photo_url:               z.string().url('photo_url deve essere un URL valido').nullable().optional(),
  hire_date:               dateField,
  birth_date:              dateField,
  qualification:           nullableStr(),
  role:                    nullableStr(),
  employer_name:           nullableStr(),
  subcontracting_auth:     z.boolean().optional(),
  safety_training_expiry:  dateField,
  health_fitness_expiry:   dateField,
  birth_place:             nullableStr(),
};

// ── POST /api/v1/workers ──────────────────────────────────────────────────────
const createWorkerSchema = z.object({
  full_name:    z.string().trim().min(2, 'full_name: min 2 caratteri').max(200),
  fiscal_code:  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{16}$/, 'fiscal_code: 16 caratteri alfanumerici'),
  tariffa_oraria: z.number().min(0).nullable().optional(),
  ...badgeFields,
});

// ── PATCH /api/v1/workers/:workerId ──────────────────────────────────────────
const patchWorkerSchema = z.object({
  full_name:      z.string().trim().min(2).max(200).optional(),
  is_active:      z.boolean().optional(),
  tariffa_oraria: z.number().min(0).nullable().optional(),
  ...badgeFields,
}).strip();

module.exports = { createWorkerSchema, patchWorkerSchema };
