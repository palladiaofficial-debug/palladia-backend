-- 237 — Palladia per coordinatori: PSC, imprese e POS, verbali (F-270, AUDIT.md)
-- Modulo nuovo e separato. Non tocca nessuna tabella esistente tranne il
-- CHECK su companies.account_type (nuovo tipo 'coordinatore').
-- Tutte le tabelle: RLS attiva senza policy → leggibili/scrivibili solo dal
-- backend (service role), che filtra sempre per company_id.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_account_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_account_type_check
  CHECK (account_type IN ('impresa', 'studio_cdl', 'provider', 'consulente', 'coordinatore'));

-- Inviti alla prova per i coordinatori (prima dell'apertura al pubblico)
CREATE TABLE IF NOT EXISTS psc_beta_invites (
  code        text        PRIMARY KEY,
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_by_company uuid    REFERENCES companies(id) ON DELETE SET NULL,
  used_at     timestamptz,
  revoked     boolean     NOT NULL DEFAULT false
);
ALTER TABLE psc_beta_invites ENABLE ROW LEVEL SECURITY;

-- Il cantiere del coordinatore = un PSC (con le sue revisioni)
CREATE TABLE IF NOT EXISTS psc_projects (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by    uuid,
  title         text        NOT NULL,
  status        text        NOT NULL DEFAULT 'bozza' CHECK (status IN ('bozza', 'firmato', 'archiviato')),
  revision      integer     NOT NULL DEFAULT 0,
  source        text        CHECK (source IN ('indirizzo', 'progetto', 'copia', 'importato')),
  copied_from   uuid,
  address       text,
  comune        text,
  provincia     text,
  lat           double precision,
  lon           double precision,
  descrizione   text,
  tipo_opera    text,
  start_date    date,
  end_date      date,
  importo_lavori numeric(14,2),
  soggetti      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  contesto      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  organizzazione jsonb      NOT NULL DEFAULT '{}'::jsonb,
  uso_comune    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  emergenze     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  coordinamento jsonb       NOT NULL DEFAULT '{}'::jsonb,
  procedure     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  testi         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  layout_path   text,
  layout_name   text,
  computo       jsonb,
  signed_at     timestamptz,
  signed_by     text,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_projects_company ON psc_projects (company_id, deleted_at);
ALTER TABLE psc_projects ENABLE ROW LEVEL SECURITY;

-- Imprese del cantiere (affidataria, esecutrici, lavoratori autonomi)
CREATE TABLE IF NOT EXISTS psc_imprese (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ragione_sociale text      NOT NULL,
  piva          text,
  email         text,
  telefono      text,
  referente     text,
  ruolo         text        NOT NULL DEFAULT 'esecutrice' CHECK (ruolo IN ('affidataria', 'esecutrice', 'autonomo')),
  color         text,
  invite_token  text        UNIQUE,
  invited_at    timestamptz,
  opened_at     timestamptz,
  pos_due_date  date,
  pos_status    text        NOT NULL DEFAULT 'da_richiedere'
                CHECK (pos_status IN ('da_richiedere', 'richiesto', 'ricevuto', 'idoneo', 'da_integrare')),
  pos_path      text,
  pos_name      text,
  pos_received_at timestamptz,
  linked_company_id uuid    REFERENCES companies(id) ON DELETE SET NULL,
  linked_site_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_imprese_project ON psc_imprese (project_id);
ALTER TABLE psc_imprese ENABLE ROW LEVEL SECURITY;

-- Lavorazioni del PSC: rischi e misure, ognuna con la sua fonte e approvazione
CREATE TABLE IF NOT EXISTS psc_lavorazioni (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ordine        integer     NOT NULL DEFAULT 0,
  nome          text        NOT NULL,
  descrizione   text,
  scheda_id     text,
  area          text,
  impresa_id    uuid        REFERENCES psc_imprese(id) ON DELETE SET NULL,
  start_date    date,
  end_date      date,
  addetti       integer,
  uomini_giorno numeric(8,1),
  fasi          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rischi        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  misure        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  dpi           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  apprestamenti jsonb       NOT NULL DEFAULT '[]'::jsonb,
  voci_computo  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_lavorazioni_project ON psc_lavorazioni (project_id, ordine);
ALTER TABLE psc_lavorazioni ENABLE ROW LEVEL SECURITY;

-- Interferenze decise dal coordinatore (quelle aperte si ricalcolano dal cronoprogramma)
CREATE TABLE IF NOT EXISTS psc_interferenze (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lav_a         uuid        NOT NULL REFERENCES psc_lavorazioni(id) ON DELETE CASCADE,
  lav_b         uuid        NOT NULL REFERENCES psc_lavorazioni(id) ON DELETE CASCADE,
  soluzione     text        NOT NULL CHECK (soluzione IN ('temporale', 'spaziale', 'misure')),
  testo         text        NOT NULL,
  rischio       text,
  decided_by    uuid,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lav_a, lav_b)
);
ALTER TABLE psc_interferenze ENABLE ROW LEVEL SECURITY;

-- Costi della sicurezza (Allegato XV, punto 4)
CREATE TABLE IF NOT EXISTS psc_costi (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ordine        integer     NOT NULL DEFAULT 0,
  categoria     text        NOT NULL CHECK (categoria IN ('a', 'b', 'c', 'd', 'e', 'f', 'g')),
  codice        text,
  descrizione   text        NOT NULL,
  um            text,
  quantita      numeric(14,3) NOT NULL DEFAULT 0,
  prezzo        numeric(14,2) NOT NULL DEFAULT 0,
  prezzo_fonte  text        NOT NULL DEFAULT 'manuale' CHECK (prezzo_fonte IN ('manuale', 'libreria', 'indicativo', 'prezzario')),
  impresa_id    uuid        REFERENCES psc_imprese(id) ON DELETE SET NULL,
  lavorazione_id uuid       REFERENCES psc_lavorazioni(id) ON DELETE SET NULL,
  origine       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_costi_project ON psc_costi (project_id, ordine);
ALTER TABLE psc_costi ENABLE ROW LEVEL SECURITY;

-- Revisioni firmate: fotografia del PSC e PDF
CREATE TABLE IF NOT EXISTS psc_revisions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision      integer     NOT NULL,
  motivo        text        NOT NULL,
  snapshot      jsonb       NOT NULL,
  pdf_path      text,
  signed_path   text,
  signed_name   text,
  signer        text,
  open_points   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);
ALTER TABLE psc_revisions ENABLE ROW LEVEL SECURITY;

-- Verifiche di idoneità dei POS
CREATE TABLE IF NOT EXISTS psc_pos_checks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  impresa_id    uuid        NOT NULL REFERENCES psc_imprese(id) ON DELETE CASCADE,
  pos_path      text,
  num_pages     integer,
  checks        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  esito         text        CHECK (esito IN ('idoneo', 'da_integrare')),
  messaggio     text,
  sent_at       timestamptz,
  decided_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_pos_checks_impresa ON psc_pos_checks (impresa_id, created_at DESC);
ALTER TABLE psc_pos_checks ENABLE ROW LEVEL SECURITY;

-- Verbali di sopralluogo / riunione di coordinamento
CREATE TABLE IF NOT EXISTS psc_verbali (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  numero        integer     NOT NULL,
  tipo          text        NOT NULL DEFAULT 'sopralluogo' CHECK (tipo IN ('sopralluogo', 'riunione')),
  data          timestamptz NOT NULL DEFAULT now(),
  presenti      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  checklist     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  osservazioni  text,
  status        text        NOT NULL DEFAULT 'bozza' CHECK (status IN ('bozza', 'firmato')),
  signature_path text,
  signed_name   text,
  signed_at     timestamptz,
  sent_to       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pdf_path      text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, numero)
);
ALTER TABLE psc_verbali ENABLE ROW LEVEL SECURITY;

-- Non conformità: aperte nel verbale, chiuse dall'impresa con una foto
CREATE TABLE IF NOT EXISTS psc_nc (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  verbale_id    uuid        REFERENCES psc_verbali(id) ON DELETE SET NULL,
  impresa_id    uuid        REFERENCES psc_imprese(id) ON DELETE SET NULL,
  descrizione   text        NOT NULL,
  gravita       text        NOT NULL DEFAULT 'media' CHECK (gravita IN ('bassa', 'media', 'alta')),
  sospensione   boolean     NOT NULL DEFAULT false,
  scadenza      date,
  photo_paths   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status        text        NOT NULL DEFAULT 'aperta' CHECK (status IN ('aperta', 'segnalata_chiusa', 'chiusa')),
  close_token   text        UNIQUE,
  close_note    text,
  close_photo_paths jsonb   NOT NULL DEFAULT '[]'::jsonb,
  closed_reported_at timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_nc_project ON psc_nc (project_id, status);
ALTER TABLE psc_nc ENABLE ROW LEVEL SECURITY;

-- La libreria del coordinatore: le sue frasi, misure, lavorazioni e prezzi
CREATE TABLE IF NOT EXISTS psc_library (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('misura', 'frase', 'lavorazione', 'costo')),
  sezione       text,
  scheda_id     text,
  titolo        text,
  testo         text        NOT NULL,
  data          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source_name   text,
  source_import uuid,
  source_project uuid,
  uses          integer     NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_library_company ON psc_library (company_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS psc_library_dedup ON psc_library (company_id, kind, coalesce(scheda_id, ''), coalesce(sezione, ''), md5(testo));
ALTER TABLE psc_library ENABLE ROW LEVEL SECURITY;

-- File caricati per la libreria (vecchi PSC)
CREATE TABLE IF NOT EXISTS psc_imports (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_name     text        NOT NULL,
  storage_path  text,
  mime_type     text,
  size_bytes    integer,
  status        text        NOT NULL DEFAULT 'in_coda' CHECK (status IN ('in_coda', 'in_lettura', 'letto', 'da_guardare', 'errore')),
  num_pages     integer,
  result        jsonb,
  error         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX IF NOT EXISTS psc_imports_company ON psc_imports (company_id, created_at DESC);
ALTER TABLE psc_imports ENABLE ROW LEVEL SECURITY;
