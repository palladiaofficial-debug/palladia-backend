-- Company delete transazionale — tutto in una singola transazione DB.
-- Chiamata da routes/v1/company.js via supabase.rpc('delete_company_cascade', { p_company_id })

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
  DELETE FROM pos_documents          WHERE company_id = p_company_id;
  DELETE FROM dvr_documents          WHERE company_id = p_company_id;
  DELETE FROM pimus_documents        WHERE company_id = p_company_id;
  DELETE FROM company_documents      WHERE company_id = p_company_id;

  -- Entità principali (cascade elimina tutte le figlie: site_*, worker_certificates, ecc.)
  DELETE FROM workers WHERE company_id = p_company_id;
  DELETE FROM sites   WHERE company_id = p_company_id;

  -- Company root (cascade: company_users, company_invites)
  DELETE FROM companies WHERE id = p_company_id;
END;
$$;
