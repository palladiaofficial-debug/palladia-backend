-- 249 — F-337 (AUDIT.md del frontend): presenze in cantiere degli operai delle
-- imprese subappaltatrici.
--
-- Tabelle SEPARATE da workers/presence_logs, per costruzione: nessuna delle
-- letture esistenti di `workers` (ore, foglio ore, buste paga, push, assenze,
-- "chi non ha timbrato", lavagna) può vedere queste persone, e punch_atomic
-- non viene toccato. Le timbrature dei dipendenti restano identiche.
--
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy
-- (stesso schema di lavagna_righe, migrazione 245).

-- Persone delle imprese subappaltatrici, viste da UN'impresa affidataria.
CREATE TABLE IF NOT EXISTS sub_workers (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id    uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  full_name           text        NOT NULL CHECK (char_length(btrim(full_name)) >= 2),
  fiscal_code         text        CHECK (fiscal_code IS NULL OR fiscal_code ~ '^[A-Z0-9]{16}$'),
  added_via           text        NOT NULL CHECK (added_via IN ('qr', 'squadra', 'ufficio')),
  informativa_version text,
  informativa_at      timestamptz,
  deactivated_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_workers_cf_unico
  ON sub_workers (company_id, fiscal_code) WHERE fiscal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS sub_workers_sub_idx ON sub_workers (company_id, subcontractor_id);

-- Link della squadra: uno per coppia cantiere × impresa, nel DB solo l'hash.
CREATE TABLE IF NOT EXISTS sub_squad_links (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id          uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subcontractor_id uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  token_hash       text        NOT NULL UNIQUE,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  last_used_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_squad_links_uno_attivo
  ON sub_squad_links (site_id, subcontractor_id) WHERE revoked_at IS NULL;

-- Entrate e uscite. Solo aggiunte: un errore si annulla (annullata_at), non si cancella.
CREATE TABLE IF NOT EXISTS sub_presenze (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subcontractor_id  uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  sub_worker_id     uuid        NOT NULL REFERENCES sub_workers(id) ON DELETE CASCADE,
  event             text        NOT NULL CHECK (event IN ('entrata', 'uscita')),
  at                timestamptz NOT NULL DEFAULT now(),
  source            text        NOT NULL CHECK (source IN ('qr', 'squadra', 'ufficio')),
  recorded_by_user  uuid,
  squad_link_id     uuid        REFERENCES sub_squad_links(id) ON DELETE SET NULL,
  latitude          double precision,
  longitude         double precision,
  distance_m        integer,
  gps_accuracy_m    integer,
  client_request_id text,
  annullata_at      timestamptz,
  annullata_da      uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_presenze_richiesta_unica
  ON sub_presenze (sub_worker_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sub_presenze_sito_giorno ON sub_presenze (site_id, at);
CREATE INDEX IF NOT EXISTS sub_presenze_persona ON sub_presenze (sub_worker_id, at);

-- Persone che dicono di lavorare per un'impresa NON assegnata al cantiere
-- ("La mia impresa non c'è"): entrano, e al titolare arriva un avviso rosso.
CREATE TABLE IF NOT EXISTS sub_impresa_ignota (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id       uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  full_name     text        NOT NULL,
  fiscal_code   text,
  impresa_nome  text        NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  chiusa_at     timestamptz,
  chiusa_come   text        CHECK (chiusa_come IS NULL OR chiusa_come IN ('assegnata', 'non_nostra')),
  chiusa_da     uuid
);
CREATE INDEX IF NOT EXISTS sub_impresa_ignota_sito ON sub_impresa_ignota (site_id, at);

ALTER TABLE sub_workers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_squad_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_presenze       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_impresa_ignota ENABLE ROW LEVEL SECURITY;
