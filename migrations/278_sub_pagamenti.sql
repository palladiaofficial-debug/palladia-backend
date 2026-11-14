-- 278 — F-497 (AUDIT.md del frontend): Subappaltatori, lavori e pagamenti.
-- Un accordo per impresa e cantiere (a corpo, a ore, a giornata), i pagamenti
-- con il modo (contanti, assegno, bonifico, altro), le giornate segnate a mano
-- (quelle dal QR si leggono da sub_presenze), il lavoro a quarti con le foto.
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy.

CREATE TABLE IF NOT EXISTS sub_accordi (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id  uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  site_id           uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tipo              text        NOT NULL CHECK (tipo IN ('corpo', 'ore', 'giornata')),
  importo           numeric(12,2) CHECK (importo IS NULL OR importo > 0),
  tariffa           numeric(10,2) CHECK (tariffa IS NULL OR tariffa > 0),
  ore_giornata      numeric(4,2) NOT NULL DEFAULT 8 CHECK (ore_giornata > 0 AND ore_giornata <= 24),
  fatto_quarti      smallint    NOT NULL DEFAULT 0 CHECK (fatto_quarti BETWEEN 0 AND 4),
  fatto_at          timestamptz,
  contratto_path    text,
  contratto_nome    text,
  data_accordo      date,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sub_accordi_cifra CHECK ((tipo = 'corpo' AND importo IS NOT NULL) OR (tipo <> 'corpo' AND tariffa IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_accordi_uno ON sub_accordi (company_id, subcontractor_id, site_id);

CREATE TABLE IF NOT EXISTS sub_pagamenti (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  accordo_id   uuid        NOT NULL REFERENCES sub_accordi(id) ON DELETE CASCADE,
  importo      numeric(12,2) NOT NULL CHECK (importo > 0),
  modo         text        NOT NULL CHECK (modo IN ('contanti', 'assegno', 'bonifico', 'altro')),
  riferimento  text        CHECK (riferimento IS NULL OR char_length(riferimento) <= 120),
  data         date        NOT NULL,
  prova_path   text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_pagamenti_accordo ON sub_pagamenti (accordo_id, data DESC);
CREATE INDEX IF NOT EXISTS sub_pagamenti_company ON sub_pagamenti (company_id, data DESC);

-- Giornate segnate a mano: vincono su quelle del QR (0 = quel giorno non ha lavorato)
CREATE TABLE IF NOT EXISTS sub_giorni (
  accordo_id  uuid        NOT NULL REFERENCES sub_accordi(id) ON DELETE CASCADE,
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  giorno      date        NOT NULL,
  giornate    numeric(4,1) NOT NULL CHECK (giornate >= 0 AND giornate <= 50),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (accordo_id, giorno)
);

CREATE TABLE IF NOT EXISTS sub_lavori (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  accordo_id  uuid        NOT NULL REFERENCES sub_accordi(id) ON DELETE CASCADE,
  nome        text        NOT NULL CHECK (char_length(btrim(nome)) BETWEEN 1 AND 80),
  quarti      smallint    NOT NULL DEFAULT 0 CHECK (quarti BETWEEN 0 AND 4),
  ordine      integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_lavori_accordo ON sub_lavori (accordo_id, ordine);

CREATE TABLE IF NOT EXISTS sub_foto (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  accordo_id  uuid        NOT NULL REFERENCES sub_accordi(id) ON DELETE CASCADE,
  path        text        NOT NULL,
  quarti      smallint    CHECK (quarti IS NULL OR quarti BETWEEN 0 AND 4),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_foto_accordo ON sub_foto (accordo_id, created_at DESC);

ALTER TABLE sub_accordi   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_pagamenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_giorni    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_lavori    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_foto      ENABLE ROW LEVEL SECURITY;
