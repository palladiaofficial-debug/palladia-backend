'use strict';
const { z } = require('zod');

const CATEGORIES = [
  'materiali', 'carburante', 'utenze', 'assicurazioni', 'tasse_contributi',
  'stipendi', 'affitto', 'attrezzature', 'subappalto', 'consulenze',
  'manutenzione', 'trasporti', 'cancelleria', 'vitto_alloggio', 'altro',
];

const PAYMENT_METHODS = [
  'contanti', 'assegno', 'bonifico', 'carta', 'pos', 'altro',
];

const createExpenseSchema = z.object({
  amount:            z.number().positive(),
  description:       z.string().min(2).max(500),
  category:          z.enum(CATEGORIES).default('altro'),
  payment_method:    z.enum(PAYMENT_METHODS).default('contanti'),
  payment_reference: z.string().max(100).nullish(),
  paid_by:           z.string().max(100).nullish(),
  supplier:          z.string().max(200).nullish(),
  expense_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  site_id:           z.string().uuid().nullish(),
  invoice_number:    z.string().max(50).nullish(),
  is_deductible:     z.boolean().default(true),
  notes:             z.string().max(1000).nullish(),
});

const updateExpenseSchema = z.object({
  amount:            z.number().positive().optional(),
  description:       z.string().min(2).max(500).optional(),
  category:          z.enum(CATEGORIES).optional(),
  payment_method:    z.enum(PAYMENT_METHODS).optional(),
  payment_reference: z.string().max(100).nullish(),
  paid_by:           z.string().max(100).nullish(),
  supplier:          z.string().max(200).nullish(),
  expense_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  site_id:           z.string().uuid().nullish(),
  invoice_number:    z.string().max(50).nullish(),
  is_deductible:     z.boolean().optional(),
  notes:             z.string().max(1000).nullish(),
});

module.exports = { createExpenseSchema, updateExpenseSchema, CATEGORIES, PAYMENT_METHODS };
