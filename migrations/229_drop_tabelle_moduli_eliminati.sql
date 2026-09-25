-- F-229 (AUDIT.md, 2026-09-25) — Inventario Palladia, voce "Tabelle vuote".
-- Il titolare ha autorizzato la cancellazione delle tabelle vuote che non
-- servono più a nulla. Ne restano solo 3 che soddisfano TUTTE le condizioni:
--   * 0 righe (conteggio esatto il 2026-09-25);
--   * lette/scritte solo da moduli ELIMINATI (non congelati) — rotte già
--     smontate da routes/v1/index.js, cron già tolti da server.js;
--   * nessuna FK in ingresso, nessuna vista, nessuna funzione che le nomini
--     tranne delete_company_cascade (riscritta qui sotto senza pimus_documents).
--   * punch_atomic e le tabelle delle timbrature non le usano.
--   pimus_documents     → generatore PIMUS (eliminato)
--   site_phase_workers  → fasi di "Ladia In Cantiere" (eliminato)
--   attendance          → vecchia tabella presenze pre-presence_logs, letta
--                         solo da services/safetyCopilotCron.js (eliminato)
-- Le altre 29 tabelle vuote restano: le usa codice vivo o un modulo congelato
-- (che si romperebbe alla riattivazione). DROP senza CASCADE di proposito:
-- se una dipendenza sfuggita esistesse, la migrazione si ferma invece di
-- portarsela via.

CREATE OR REPLACE FUNCTION delete_company_cascade(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Foglie formazione
  DELETE FROM provider_reviews      WHERE company_id = p_company_id;
  DELETE FROM course_reviews        WHERE company_id = p_company_id;
  DELETE FROM expiry_notifications  WHERE company_id = p_company_id;
  DELETE FROM course_bookings       WHERE company_id = p_company_id;
  DELETE FROM course_quote_requests WHERE company_id = p_company_id;

  -- Studio CDL
  DELETE FROM studio_document_requests WHERE company_id = p_company_id;

  -- Notifiche / messaging
  DELETE FROM notification_preferences WHERE company_id = p_company_id;
  DELETE FROM notifications            WHERE company_id = p_company_id;
  DELETE FROM push_subscriptions       WHERE company_id = p_company_id;
  DELETE FROM telegram_link_tokens     WHERE company_id = p_company_id;
  DELETE FROM telegram_users           WHERE company_id = p_company_id;
  DELETE FROM chat_messages WHERE conversation_id IN (
    SELECT id FROM chat_conversations WHERE company_id = p_company_id
  );
  DELETE FROM chat_conversations WHERE company_id = p_company_id;

  -- Dati operativi
  DELETE FROM ladia_proactive_log    WHERE company_id = p_company_id;
  DELETE FROM worker_documents       WHERE company_id = p_company_id;
  DELETE FROM worker_device_sessions WHERE company_id = p_company_id;
  DELETE FROM worksite_workers       WHERE company_id = p_company_id;
  DELETE FROM pos_acknowledgments    WHERE company_id = p_company_id;
  DELETE FROM equipment_documents    WHERE company_id = p_company_id;
  DELETE FROM equipment              WHERE company_id = p_company_id;
  DELETE FROM subcontractor_documents WHERE company_id = p_company_id;
  DELETE FROM subcontractors         WHERE company_id = p_company_id;
  DELETE FROM company_expenses        WHERE company_id = p_company_id;
  DELETE FROM pos_documents          WHERE company_id = p_company_id;
  DELETE FROM dvr_documents          WHERE company_id = p_company_id;
  -- pimus_documents: tabella rimossa (F-229)
  DELETE FROM company_documents      WHERE company_id = p_company_id;

  -- Entità principali (cascade elimina tutte le figlie: site_*, worker_certificates, ecc.)
  DELETE FROM workers WHERE company_id = p_company_id;
  DELETE FROM sites   WHERE company_id = p_company_id;

  -- Company root (cascade: company_users, company_invites)
  DELETE FROM companies WHERE id = p_company_id;
END;
$$;

DROP TABLE IF EXISTS public.pimus_documents;
DROP TABLE IF EXISTS public.site_phase_workers;
DROP TABLE IF EXISTS public.attendance;
