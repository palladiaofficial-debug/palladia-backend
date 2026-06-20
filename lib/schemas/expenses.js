'use strict';
const Joi = require('joi');

const CATEGORIES = [
  'materiali', 'carburante', 'utenze', 'assicurazioni', 'tasse_contributi',
  'stipendi', 'affitto', 'attrezzature', 'subappalto', 'consulenze',
  'manutenzione', 'trasporti', 'cancelleria', 'vitto_alloggio', 'altro',
];

const PAYMENT_METHODS = [
  'contanti', 'assegno', 'bonifico', 'carta', 'pos', 'altro',
];

const createExpenseSchema = Joi.object({
  amount:            Joi.number().positive().required(),
  description:       Joi.string().min(2).max(500).required(),
  category:          Joi.string().valid(...CATEGORIES).default('altro'),
  payment_method:    Joi.string().valid(...PAYMENT_METHODS).default('contanti'),
  payment_reference: Joi.string().max(100).allow('', null),
  paid_by:           Joi.string().max(100).allow('', null),
  supplier:          Joi.string().max(200).allow('', null),
  expense_date:      Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  site_id:           Joi.string().uuid().allow(null),
  invoice_number:    Joi.string().max(50).allow('', null),
  is_deductible:     Joi.boolean().default(true),
  notes:             Joi.string().max(1000).allow('', null),
});

const updateExpenseSchema = Joi.object({
  amount:            Joi.number().positive(),
  description:       Joi.string().min(2).max(500),
  category:          Joi.string().valid(...CATEGORIES),
  payment_method:    Joi.string().valid(...PAYMENT_METHODS),
  payment_reference: Joi.string().max(100).allow('', null),
  paid_by:           Joi.string().max(100).allow('', null),
  supplier:          Joi.string().max(200).allow('', null),
  expense_date:      Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  site_id:           Joi.string().uuid().allow(null),
  invoice_number:    Joi.string().max(50).allow('', null),
  is_deductible:     Joi.boolean(),
  notes:             Joi.string().max(1000).allow('', null),
}).min(1);

module.exports = { createExpenseSchema, updateExpenseSchema, CATEGORIES, PAYMENT_METHODS };
