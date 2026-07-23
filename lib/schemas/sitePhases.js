'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

const VALID_STATI = ['non_iniziata', 'in_corso', 'completata', 'sospesa'];

// ── POST /api/v1/sites/:siteId/phases ────────────────────────────────────────
const createPhaseSchema = z.object({
  nome:                    z.string().trim().min(1, 'nome richiesto').max(200),
  stato:                   z.enum(VALID_STATI).optional(),
  progresso_percentuale:   z.number().min(0).max(100).optional(),
  data_inizio_prevista:    dateField,
  data_fine_prevista:      dateField,
  importo_contratto:       z.number().min(0).nullable().optional(),
  note:                    nullableStr(2000),
  sort_order:              z.number().int().optional(),
});

// ── PATCH /api/v1/sites/:siteId/phases/:phaseId ──────────────────────────────
const patchPhaseSchema = z.object({
  nome:                    z.string().trim().max(200).optional(),
  stato:                   z.enum(VALID_STATI).optional(),
  progresso_percentuale:   z.number().min(0).max(100).optional(),
  data_inizio_prevista:    dateField,
  data_fine_prevista:      dateField,
  data_inizio_reale:       dateField,
  data_fine_reale:         dateField,
  importo_contratto:       z.number().min(0).nullable().optional(),
  importo_maturato:        z.number().min(0).nullable().optional(),
  note:                    nullableStr(2000),
  sort_order:              z.number().int().optional(),
}).strip();

// ── POST /api/v1/sites/:siteId/phases/:phaseId/workers ───────────────────────
const assignWorkersSchema = z.object({
  worker_ids: z.array(z.string().uuid()).min(1).optional(),
  worker_id:  z.string().uuid().optional(),
}).strip().refine(
  (d) => d.worker_ids?.length || d.worker_id,
  { message: 'Specifica worker_id o worker_ids' }
);

module.exports = { createPhaseSchema, patchPhaseSchema, assignWorkersSchema };
