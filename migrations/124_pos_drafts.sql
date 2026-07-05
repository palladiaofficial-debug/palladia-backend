-- Migration 124: pos_drafts — bozza POS viva, compilata da Ladia in chat
-- sezione per sezione (Fase "Cursor per Palladia" — POS agentico). Diversa da
-- pos_documents (POS generato/emesso, revisionato, immutabile nella sostanza):
-- questa è una bozza di lavoro, riscrivibile liberamente, che il wizard
-- /pos/nuovo consuma per precompilarsi. Una colonna reale per campo (non un
-- blob jsonb unico) per riusare integralmente create_record/update_record
-- generici e la card diff/undo già esistenti (lib/ladiaSchemaRegistry.js).

CREATE TABLE IF NOT EXISTS pos_drafts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id               uuid        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  created_by            uuid,

  site_address          text,
  client_name           text,
  cf_committente        text,
  tipo_appalto          text,
  work_type             text,
  budget                text,
  start_date            text,
  end_date              text,

  company_name          text,
  company_vat           text,

  responsabile_lavori   text,
  csp                   text,
  cse                   text,
  cse_tel               text,
  cse_email             text,
  cse_cf                text,
  rspp                  text,
  rspp_tel              text,
  rspp_email            text,
  rspp_cf               text,
  rls                   text,
  rls_tel               text,
  medico                text,
  medico_tel            text,
  primo_soccorso        text,
  primo_soccorso_tel    text,
  antincendio           text,
  antincendio_tel       text,
  direttore_tecnico     text,
  preposto              text,

  ore_lavorative        text,
  inizio_turno          text,
  pausa_pranzo          text,
  turno_notturno        boolean,

  workers               jsonb,
  subappaltatori        jsonb,
  fasi                  jsonb,
  rischi_specifici      jsonb,
  opere_provvisionali   jsonb,
  impianti_cantiere     jsonb,
  selected_works        jsonb,
  note_aggiuntive       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_drafts_site    ON pos_drafts(site_id);
CREATE INDEX IF NOT EXISTS idx_pos_drafts_company ON pos_drafts(company_id, created_at DESC);

CREATE OR REPLACE FUNCTION _pos_drafts_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_drafts_updated_at ON pos_drafts;
CREATE TRIGGER trg_pos_drafts_updated_at
  BEFORE UPDATE ON pos_drafts
  FOR EACH ROW EXECUTE FUNCTION _pos_drafts_set_updated_at();
