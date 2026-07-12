'use strict';
const { z } = require('zod');

const connectSdiSchema = z.object({
  fiscal_id: z.string().trim().min(11).max(16), // P.IVA (11) o Codice Fiscale (16)
});

module.exports = { connectSdiSchema };
