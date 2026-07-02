'use strict';
const crypto = require('crypto');

// Registro centrale delle risorse che Ladia può leggere/scrivere tramite i tool
// generici (create_record/update_record/delete_record). È l'UNICO control plane:
// il backend usa la service key di Supabase (lib/supabase.js), quindi RLS non
// protegge nulla qui — ogni campo scrivibile dal modello deve essere elencato
// esplicitamente in `fields`. Tutto ciò che non è elencato è strutturalmente
// irraggiungibile dal modello, incluso `company_id` e la primary key.

function todayRome() {
  return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}

const RESOURCES = {
  workers: {
    table: 'workers',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      full_name:               { type: 'string', required: true,  sensitivity: 'low', createOnly: true },
      fiscal_code:             { type: 'string', required: false, sensitivity: 'low', createOnly: true },
      role:                    { type: 'string', required: false, sensitivity: 'low', createOnly: true },
      qualification:           { type: 'string', required: false, sensitivity: 'low', createOnly: true },
      employer_name:           { type: 'string', required: false, sensitivity: 'low', createOnly: true },
      // Stessa tabella dei campi anagrafici sopra, ma legal-sensitive (D.Lgs 81/2008):
      // update_record le rifiuta strutturalmente (RICHIEDE_CONFERMA) — passano solo
      // via propose_action, mai in autonomia diretta.
      safety_training_expiry:  { type: 'string', required: false, sensitivity: 'medium', updateOnly: true },
      health_fitness_expiry:   { type: 'string', required: false, sensitivity: 'medium', updateOnly: true },
    },
    serverInjected: (companyId) => ({
      company_id: companyId,
      badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
      is_active: true,
    }),
    allow: { create: true, update: true, delete: false },
  },

  worksite_workers: {
    table: 'worksite_workers',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      worker_id: { type: 'string', required: true, sensitivity: 'low' },
      site_id:   { type: 'string', required: true, sensitivity: 'low' },
    },
    serverInjected: (companyId) => ({
      company_id: companyId,
      status: 'active',
      start_date: todayRome(),
    }),
    // Idempotenza: se esiste già un'assegnazione attiva, non duplicarla.
    dedupeCheck: {
      matchFields: ['worker_id', 'site_id'],
      matchExtra: { status: 'active' },
      alreadyMessage: 'Lavoratore già assegnato a questo cantiere.',
    },
    allow: { create: true, update: false, delete: false },
  },

  sites: {
    table: 'sites',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      name:            { type: 'string', required: true,  sensitivity: 'low' },
      address:         { type: 'string', required: false, sensitivity: 'low' },
      start_date:      { type: 'string', required: false, sensitivity: 'low' },
      end_date:        { type: 'string', required: false, sensitivity: 'low' },
      budget_totale:   { type: 'number', required: false, sensitivity: 'low' },
      status:          { type: 'string', required: false, sensitivity: 'low', enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'], updateOnly: true },
      sal_percentuale: { type: 'number', required: false, sensitivity: 'low', updateOnly: true },
    },
    serverInjected: (companyId, op) =>
      op === 'create' ? { company_id: companyId, status: 'attivo' } : { company_id: companyId },
    allow: { create: true, update: true, delete: false },
  },

  site_diary_entries: {
    table: 'site_diary_entries',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      site_id:    { type: 'string', required: true,  sensitivity: 'low' },
      entry_date: { type: 'string', required: false, sensitivity: 'low', default: todayRome },
      activities: { type: 'string', required: false, sensitivity: 'low' },
      notes:      { type: 'string', required: false, sensitivity: 'low' },
      issues:     { type: 'string', required: false, sensitivity: 'low' },
      decisions:  { type: 'string', required: false, sensitivity: 'low' },
      materials:  { type: 'string', required: false, sensitivity: 'low' },
    },
    serverInjected: (companyId, op, userId) => ({
      company_id: companyId,
      created_by: userId || null,
      updated_at: new Date().toISOString(),
    }),
    conflictKey: 'site_id,entry_date',
    allow: { create: true, update: false, delete: false },
  },

  site_bookings: {
    table: 'site_bookings',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      site_id:      { type: 'string', required: true,  sensitivity: 'low' },
      title:        { type: 'string', required: true,  sensitivity: 'low' },
      booking_date: { type: 'string', required: true,  sensitivity: 'low' },
      booking_time: { type: 'string', required: false, sensitivity: 'low' },
      category:     { type: 'string', required: false, sensitivity: 'low', enum: ['consegna', 'visita', 'collaudo', 'sopralluogo', 'fornitura', 'altro'], default: () => 'consegna' },
      supplier:     { type: 'string', required: false, sensitivity: 'low' },
      notes:        { type: 'string', required: false, sensitivity: 'low' },
    },
    serverInjected: (companyId) => ({ company_id: companyId, status: 'programmata' }),
    allow: { create: true, update: false, delete: false },
  },

  site_suspension_days: {
    table: 'site_suspension_days',
    pk: 'id',
    defaultSensitivity: 'low',
    fields: {
      site_id: { type: 'string', required: true,  sensitivity: 'low' },
      day:     { type: 'string', required: true,  sensitivity: 'low' },
      reason:  { type: 'string', required: false, sensitivity: 'low', enum: ['pioggia', 'vento', 'neve', 'altro'], default: () => 'altro' },
      notes:   { type: 'string', required: false, sensitivity: 'low' },
    },
    serverInjected: (companyId, op, userId) => ({ company_id: companyId, created_by: userId || null }),
    conflictKey: 'site_id,day',
    allow: { create: true, update: false, delete: false },
  },
};

// Sanity check a load-time: nessuna risorsa deve elencare company_id/id/pk tra
// i campi scrivibili dal modello — se succede è un bug nel registro, non un
// input malevolo, quindi va rotto subito e rumorosamente.
for (const [name, resource] of Object.entries(RESOURCES)) {
  const forbidden = ['company_id', 'id', resource.pk];
  for (const key of forbidden) {
    if (resource.fields[key]) {
      throw new Error(`[ladiaSchemaRegistry] risorsa "${name}": il campo "${key}" non può essere scrivibile dal modello`);
    }
  }
}

function getResource(name) {
  return RESOURCES[name] || null;
}

const SENSITIVITY_RANK = { low: 0, medium: 1, high: 2 };

function computeSensitivity(resource, payloadKeys) {
  let level = resource.defaultSensitivity || 'low';
  for (const key of payloadKeys) {
    const def = resource.fields[key];
    if (def && def.sensitivity && SENSITIVITY_RANK[def.sensitivity] > SENSITIVITY_RANK[level]) {
      level = def.sensitivity;
    }
  }
  return level;
}

// Whitelist stretta: costruisce il payload pulito iterando SOLO sui campi
// dichiarati nel registro per l'operazione richiesta. Qualunque chiave nel
// rawInput non elencata (incluso company_id/id se il modello li manda) viene
// scartata semplicemente perché non viene mai letta.
function sanitizePayload(resource, rawInput, op) {
  const clean = {};
  const missing = [];
  for (const [key, def] of Object.entries(resource.fields)) {
    if (op === 'create' && def.updateOnly) continue;
    if (op === 'update' && def.createOnly) continue;
    if (Object.prototype.hasOwnProperty.call(rawInput || {}, key) && rawInput[key] !== undefined && rawInput[key] !== null) {
      clean[key] = rawInput[key];
    } else if (typeof def.default === 'function') {
      clean[key] = def.default();
    } else if (def.required && op === 'create') {
      missing.push(key);
    }
  }
  return { clean, missing };
}

module.exports = { RESOURCES, getResource, computeSensitivity, sanitizePayload, todayRome };
