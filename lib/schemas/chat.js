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
const chatExportSchema = z.object({
  format:   z.enum(['pdf', 'excel']),
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).min(1).max(20),
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

// POST /chat/confirm-action/:id
const confirmPendingActionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strip();

module.exports = {
  chatMessageSchema,
  chatExportSchema,
  createConversationSchema,
  patchConversationTitleSchema,
  confirmPendingActionSchema,
};
