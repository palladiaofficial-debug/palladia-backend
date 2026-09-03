-- 185_economia_movimenti_registro.sql
-- BLOCCO 1 — Controllo Economico: Registro Unico dei Movimenti Economici.
-- Additiva, non distruttiva: solo tabelle nuove. Nessuna sorgente esistente
-- (site_costs, company_expenses, site_computo, site_sal_history) viene
-- alterata. Rollback = DROP delle tabelle create qui (nessun'altra tabella
-- referenzia queste, sono foglie del grafo).
--
-- Il modulo resta dietro feature flag `economia_controllo_v1`
-- (lib/featureFlags.js), attivo solo su MASTER_COMPANY_IDS — vedi AUDIT.md
-- F-119 per il finding che lo motiva.

-- ── Registro unico ────────────────────────────────────────────────────────────
-- Una riga per movimento economico di cantiere, qualunque sia la sorgente.
-- tipo: budget (previsto) | impegnato (contrattualizzato, non ancora costo) |
--       consuntivo (costo reale sostenuto) | ricavo (maturato verso il committente)
CREATE TABLE IF NOT EXISTS site_economia_movimenti (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tipo              text          NOT NULL CHECK (tipo IN ('budget', 'impegnato', 'consuntivo', 'ricavo')),
  categoria         text          NOT NULL CHECK (categoria IN ('manodopera', 'materiali', 'subappalti', 'noleggi', 'altro')),
  importo           numeric(14,2) NOT NULL,
  data_competenza   date          NOT NULL DEFAULT CURRENT_DATE,
  voce_computo_id   uuid          REFERENCES site_computo_voci(id) ON DELETE SET NULL,
  sorgente          text          NOT NULL CHECK (sorgente IN ('computo', 'contratto', 'fattura', 'timbratura', 'sal', 'manuale')),
  source_table      text,         -- tabella di origine; NULL per righe inserite a mano
  source_id         text,         -- id del record di origine nella tabella sorgente
  note              text,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  -- Una sorgente scrive al più una riga per tipo (upsert idempotente via
  -- DELETE+INSERT nei trigger). Righe manuali (source_table/source_id NULL)
  -- non collidono mai: NULL <> NULL in un constraint UNIQUE.
  UNIQUE (sorgente, source_table, source_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_economia_movimenti_site
  ON site_economia_movimenti(site_id, tipo, categoria);
CREATE INDEX IF NOT EXISTS idx_economia_movimenti_company
  ON site_economia_movimenti(company_id);
CREATE INDEX IF NOT EXISTS idx_economia_movimenti_source
  ON site_economia_movimenti(source_table, source_id) WHERE source_table IS NOT NULL;

ALTER TABLE site_economia_movimenti ENABLE ROW LEVEL SECURITY;

CREATE POLICY economia_movimenti_company_member ON site_economia_movimenti
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

CREATE OR REPLACE FUNCTION _economia_movimenti_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_economia_movimenti_updated_at ON site_economia_movimenti;
CREATE TRIGGER trg_economia_movimenti_updated_at
  BEFORE UPDATE ON site_economia_movimenti
  FOR EACH ROW EXECUTE FUNCTION _economia_movimenti_set_updated_at();

-- ── Log dei fallimenti di sincronizzazione ───────────────────────────────────
-- Stesso pattern di document_sync_failures (migrazione 150): la sync non deve
-- mai far fallire la scrittura sulla tabella sorgente, nemmeno se anche il
-- logging del fallimento stesso fallisce (vedi doppio EXCEPTION nei trigger,
-- migrazione 186). Solo service_role vi accede (nessuna policy = deny-all).
CREATE TABLE IF NOT EXISTS economia_sync_failures (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table   text        NOT NULL,
  source_id      text,
  operation      text        NOT NULL,
  error_message  text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_economia_sync_failures_unresolved
  ON economia_sync_failures(source_table, occurred_at) WHERE resolved_at IS NULL;
ALTER TABLE economia_sync_failures ENABLE ROW LEVEL SECURITY;

-- ── Contratti di subappalto per cantiere (BLOCCO 2) ──────────────────────────
-- Oggi `subcontractors` è solo anagrafica compliance (DURC, polizza, SOA) —
-- nessun campo importo/cantiere. Questa tabella introduce il concetto di
-- "contratto emesso con importo pattuito", che genera in automatico la riga
-- impegnato nel registro (trigger in migrazione 186). È la parte che nessun
-- gestionale mostra e che serve per il costo a finire.
CREATE TABLE IF NOT EXISTS site_subcontracts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subcontractor_id  uuid          REFERENCES subcontractors(id) ON DELETE SET NULL,
  descrizione       text          NOT NULL,
  importo_pattuito  numeric(14,2) NOT NULL CHECK (importo_pattuito > 0),
  data_emissione    date          NOT NULL DEFAULT CURRENT_DATE,
  stato             text          NOT NULL DEFAULT 'emesso' CHECK (stato IN ('bozza', 'emesso', 'chiuso', 'annullato')),
  note              text,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_subcontracts_site ON site_subcontracts(site_id);
CREATE INDEX IF NOT EXISTS idx_site_subcontracts_company ON site_subcontracts(company_id);
CREATE INDEX IF NOT EXISTS idx_site_subcontracts_sub ON site_subcontracts(subcontractor_id);

ALTER TABLE site_subcontracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_subcontracts_company_member ON site_subcontracts
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

DROP TRIGGER IF EXISTS trg_site_subcontracts_updated_at ON site_subcontracts;
CREATE TRIGGER trg_site_subcontracts_updated_at
  BEFORE UPDATE ON site_subcontracts
  FOR EACH ROW EXECUTE FUNCTION _economia_movimenti_set_updated_at();

-- ── SAL ricevuti dal subappaltatore ───────────────────────────────────────────
-- Ogni SAL del subappaltatore converte una quota dell'impegnato in consuntivo
-- (trigger in migrazione 186). Il residuo impegnato si calcola a query-time
-- (impegnato del contratto − somma dei SAL collegati), niente decremento
-- distruttivo del valore contrattuale originale.
CREATE TABLE IF NOT EXISTS site_subcontract_sal (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  subcontract_id    uuid          NOT NULL REFERENCES site_subcontracts(id) ON DELETE CASCADE,
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  importo           numeric(14,2) NOT NULL CHECK (importo > 0),
  data              date          NOT NULL DEFAULT CURRENT_DATE,
  note              text,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_subcontract_sal_contract ON site_subcontract_sal(subcontract_id);
CREATE INDEX IF NOT EXISTS idx_site_subcontract_sal_site ON site_subcontract_sal(site_id);

ALTER TABLE site_subcontract_sal ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_subcontract_sal_company_member ON site_subcontract_sal
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));
