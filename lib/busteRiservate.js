'use strict';
/**
 * lib/busteRiservate.js — F-494 (AUDIT.md del frontend, 13/11/2026).
 *
 * Le buste paga (e i prospetti del commercialista, con le paghe di tutti) le
 * vede solo l'ufficio: titolare (owner) e amministratori (admin). Più lo studio
 * del consulente del lavoro collegato (userRole 'cdl'), che le prepara.
 * Mai «tech» (capocantiere) né «viewer». La stessa regola sta nel database
 * (is_company_manager, migrazione 277) per chi legge le tabelle col suo JWT.
 */
const VEDONO_BUSTE = new Set(['owner', 'admin', 'cdl']);

function vedeBuste(role) {
  return VEDONO_BUSTE.has(role);
}

/** Middleware dopo verifySupabaseJwt. */
function soloUfficio(req, res, next) {
  if (vedeBuste(req.userRole)) return next();
  return res.status(403).json({ error: 'SOLO_UFFICIO', message: 'Le buste paga le vedono solo il titolare e gli amministratori.' });
}

/**
 * Per le letture della tabella unificata `documents`: chi non è dell'ufficio
 * non vede le righe delle buste (source_table payslips o categoria busta_paga).
 * `.or` con category nulla: un semplice neq scarterebbe anche i documenti senza categoria.
 */
function senzaBuste(query, role) {
  if (vedeBuste(role)) return query;
  return query.neq('source_table', 'payslips').or('category.is.null,category.neq.busta_paga');
}

module.exports = { vedeBuste, soloUfficio, senzaBuste, VEDONO_BUSTE };
