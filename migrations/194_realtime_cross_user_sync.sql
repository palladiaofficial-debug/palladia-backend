-- 194_realtime_cross_user_sync.sql
--
-- F-124 (AUDIT.md): l'unico meccanismo che permette a una schermata già aperta
-- di aggiornarsi da sola (ladiaEvents, src/lib/ladiaEvents.ts) scatta solo
-- quando è Ladia a scrivere — non quando scrive un utente da un modulo
-- normale, e non quando scrive un COLLEGA da un altro dispositivo sulla
-- stessa azienda. Verificato: Supabase Realtime nel frontend copre solo
-- company_expenses (134) e pos_drafts (126) su tutta la piattaforma.
--
-- Questa migrazione abilita la pubblicazione realtime sulle tabelle che
-- alimentano le viste multi-utente più usate (Organico, Documenti, Diario,
-- Economia, Formazione) — il frontend (GlobalDataSync, nuovo componente)
-- si sottoscrive e ridispatcha lo stesso evento ladiaEvents.dataChanged già
-- ascoltato da OrganicoTab/DiarioTab/DocumentiTab/EconomiaTab/Risorse/
-- Dashboard/SiteDiary, così nessuno di quei listener esistenti va riscritto.
--
-- Idempotente: ALTER PUBLICATION fallisce se la tabella è già membro, quindi
-- ogni ADD è guardato con un controllo su pg_publication_tables.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workers', 'worksite_workers', 'equipment', 'subcontractors',
    'site_documents', 'site_notes', 'site_diary_entries',
    'site_costs', 'site_economia_voci', 'site_sal_history',
    'worker_certificates'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
