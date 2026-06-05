-- Migration 092: checklist di preparazione cantiere generata da AI
-- Generata automaticamente dopo la creazione di un POS, mostra in-app cosa manca.

CREATE TABLE IF NOT EXISTS site_setup_checklist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid        NOT NULL REFERENCES sites(id)         ON DELETE CASCADE,
  company_id  uuid        NOT NULL,
  pos_id      uuid                    REFERENCES pos_documents(id) ON DELETE SET NULL,
  category    text        NOT NULL DEFAULT 'logistica',   -- logistica | burocrazia | sicurezza | ambiente
  title       text        NOT NULL,
  description text,
  priority    text        NOT NULL DEFAULT 'normal',      -- high | normal
  done        boolean     NOT NULL DEFAULT false,
  done_at     timestamptz,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_setup_checklist_site ON site_setup_checklist(site_id, sort_order);
