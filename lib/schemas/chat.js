'use strict';
const { z } = require('zod');

const CONTEXT_TYPES = ['azienda', 'cantiere'];

// POST /chat
const chatMessageSchema = z.object({
  message:         z.string().trim().min(1).max(4000),
  conversation_id: z.string().uuid().optional(),
  context_type:    z.enum(CONTEXT_TYPES).optional(),
  context_id:      z.string().uuid().nullable().optional(),
  history:         z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(20).optional(),
});

// POST /chat/export
// Nota: il handler tronca già a slice(-10) messaggi e 4000 char ciascuno
// prima di usarli — questo schema valida solo la forma, non duplica quei
// limiti (altrimenti una conversazione/risposta lunga viene rifiutata con
// 400 invece di essere troncata in sicurezza dall'handler).
const chatExportSchema = z.object({
  format:   z.enum(['pdf', 'excel']),
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string().max(50000),
  })).min(1).max(200),
});

// POST /chat/export-contract
// Il contratto è dati strutturati, non prosa: niente riformattazione via LLM.
// Campi FLAT (stessi nomi dell'input_schema del tool draft_subappalto_contract
// in routes/v1/chat.js) così l'handler riusa la stessa funzione di validazione
// e calcolo (incidenza %, penali) usata per la preview in chat — mai due
// implementazioni dello stesso calcolo che potrebbero disallinearsi.
const contractExportSchema = z.object({
  // Se presente, il PDF generato viene archiviato nei Documenti del cantiere
  // (site_documents) invece di restare solo un download — vedi POST /chat/export-contract.
  site_id:                                z.string().uuid().optional(),
  affidataria_ragione_sociale:           z.string().trim().min(1).max(150),
  affidataria_sede:                      z.string().trim().min(1).max(200),
  affidataria_piva:                      z.string().trim().min(8).max(20),
  affidataria_legale_rappresentante:     z.string().trim().min(1).max(120),
  subappaltatrice_ragione_sociale:       z.string().trim().min(1).max(150),
  subappaltatrice_sede:                  z.string().trim().min(1).max(200),
  subappaltatrice_piva:                  z.string().trim().min(8).max(20),
  subappaltatrice_legale_rappresentante: z.string().trim().min(1).max(120),
  luogo_sottoscrizione:       z.string().trim().min(1).max(80),
  oggetto_lavorazione:        z.string().trim().min(1).max(2000),
  data_inizio:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  data_fine:                  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  importo_appalto_principale: z.number().positive(),
  // Uno tra importo_subappalto (totale unico) e voci (prezzo unitario ×
  // quantità, ricalcolato sempre server-side) — mai fidarsi di un totale già
  // sommato dal modello quando ha anche le voci: vedi computeContractDraft.
  importo_subappalto:         z.number().positive().optional(),
  voci: z.array(z.object({
    label:           z.string().trim().min(1).max(200),
    quantita:        z.number().positive(),
    unita_misura:    z.string().trim().max(20).optional(),
    prezzo_unitario: z.number().positive(),
  })).max(30).optional(),
  modalita_pagamento:         z.string().trim().max(1000).optional(),
  lavori_in_quota:                z.boolean().optional(),
  interferenze_altre_lavorazioni: z.boolean().optional(),
  dpi_specifici:               z.string().trim().max(500).optional(),
  foro_competente:              z.string().trim().max(80).optional(),
  allegati:                     z.array(z.string().trim().max(200)).max(10).optional(),
  autorizzazione_committente_confermata: z.boolean().optional(),
});

// POST /chat/conversations
const createConversationSchema = z.object({
  title:        z.string().trim().max(100).optional(),
  context_type: z.enum(CONTEXT_TYPES).optional(),
  context_id:   z.string().uuid().nullable().optional(),
});

// PATCH /chat/conversations/:id/title
const patchConversationTitleSchema = z.object({
  title: z.string().trim().min(1).max(100),
}).strip();

// PATCH /chat/conversations/:id/folder
const patchConversationFolderSchema = z.object({
  folder_id: z.string().uuid().nullable(),
}).strip();

// POST /chat/folders
const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(60),
}).strip();

// PATCH /chat/folders/:id
const patchFolderSchema = z.object({
  name: z.string().trim().min(1).max(60),
}).strip();

// POST /chat/confirm-action/:id
const confirmPendingActionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strip();

module.exports = {
  chatMessageSchema,
  chatExportSchema,
  contractExportSchema,
  createConversationSchema,
  patchConversationTitleSchema,
  patchConversationFolderSchema,
  createFolderSchema,
  patchFolderSchema,
  confirmPendingActionSchema,
};
