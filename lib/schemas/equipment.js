'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional();
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /equipment
const createEquipmentSchema = z.object({
  type:                 z.string().trim().min(1, 'type obbligatorio').max(200),
  model:                nullableStr(200),
  plateOrSerial:        nullableStr(100),
  ownership:            z.string().trim().max(100).optional(),
  purchaseDate:         dateField,
  inspectionDate:       dateField,
  insuranceExpiry:      dateField,
  maintenanceDate:      dateField,
  notes:                nullableStr(1000),
  colore:               nullableStr(100),
  annoImmatricolazione: nullableStr(10),
  numeroTelaio:         nullableStr(50),
});

// PATCH /equipment/:id
const patchEquipmentSchema = z.object({
  type:                 z.string().trim().min(1).max(200).optional(),
  model:                nullableStr(200),
  plateOrSerial:        nullableStr(100),
  ownership:            nullableStr(100),
  purchaseDate:         dateField,
  inspectionDate:       dateField,
  insuranceExpiry:      dateField,
  maintenanceDate:      dateField,
  notes:                nullableStr(1000),
  colore:               nullableStr(100),
  annoImmatricolazione: nullableStr(10),
  numeroTelaio:         nullableStr(50),
}).strip();

// POST /sites/:siteId/equipment
const assignEquipmentSchema = z.object({
  equipment_id: z.string().uuid('equipment_id deve essere UUID'),
});

module.exports = { createEquipmentSchema, patchEquipmentSchema, assignEquipmentSchema };
