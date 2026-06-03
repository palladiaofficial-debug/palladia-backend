'use strict';
/**
 * middleware/validate.js
 *
 * Wrapper Zod → middleware Express.
 * Valida req.body contro uno schema e mette i dati coercizzati/puliti in req.body.
 * In caso di errore restituisce 400 con VALIDATION_ERROR.
 *
 * Uso:
 *   const { validate } = require('../../middleware/validate');
 *   const { z }        = require('zod');
 *
 *   const schema = z.object({ name: z.string().min(2) });
 *   router.post('/foo', verifyJwt, validate(schema), handler);
 */
const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      // Zod v4 usa .issues (v3 usava .errors)
      const issues = result.error.issues ?? result.error.errors ?? [];
      const first  = issues[0] ?? { path: [], message: 'Dati non validi' };
      const field  = first.path?.length ? first.path.join('.') : undefined;
      return res.status(400).json({
        error:   'VALIDATION_ERROR',
        ...(field && { field }),
        message: first.message,
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate, z };
