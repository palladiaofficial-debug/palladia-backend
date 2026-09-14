-- ================================================================
-- Migration 209 — rimuove l'overload obsoleto di punch_atomic creato
-- per errore dalla migration 208 (F-184, AUDIT.md)
--
-- Problema: CREATE OR REPLACE FUNCTION con un parametro NUOVO in coda
-- (p_client_request_id, anche se DEFAULT NULL) non sostituisce la
-- funzione esistente a 11 argomenti totali quando ne esisteva già una
-- a 10 — PostgreSQL/PostgREST la trattano come due overload distinti
-- con lo stesso nome. Qualunque chiamata che non specifica
-- ESPLICITAMENTE p_client_request_id (es. la route
-- POST /badge/capocantiere-punch, mai aggiornata perché non è il
-- percorso col bug — e qualunque script/selftest preesistente, tra
-- cui selftest_punch_atomic_global_exit.js/F-172) diventa AMBIGUA per
-- PostgREST ("Could not choose the best candidate function tra i due
-- overload") e fallisce SEMPRE — rottura in produzione scoperta
-- rilanciando il test di F-172 subito dopo aver applicato la 208.
--
-- Fix: elimina esplicitamente il vecchio overload a 10 argomenti,
-- lasciando solo quello a 11 (con p_client_request_id DEFAULT NULL)
-- introdotto dalla 208 — nessuna ambiguità, comportamento invariato
-- per chi non passa il nuovo parametro.
-- ================================================================

DROP FUNCTION IF EXISTS public.punch_atomic(
  uuid, uuid, uuid, uuid,
  double precision, double precision, integer, numeric,
  text, text, text
);
