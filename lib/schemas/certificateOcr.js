'use strict';
const { z } = require('zod');

// POST /workers/:workerId/certificates/extract
// Accetta file_url oppure file_base64 (XOR), plus mime_type opzionale
const extractCertificateSchema = z.object({
  file_url:    z.string().url('file_url deve essere un URL valido').max(2000).optional(),
  file_base64: z.string().min(1).optional(),
  mime_type:   z.string().max(100).optional(),
}).strip().refine(
  data => data.file_url || data.file_base64,
  { message: 'Fornire file_url o file_base64' }
);

module.exports = { extractCertificateSchema };
