-- F-428 (AUDIT.md del frontend): la sicurezza di un cantiere mandata al coordinatore.
-- Un link senza registrazione con il tuo POS e i POS delle imprese già controllati
-- (F-427), fermati al momento dell'invio (contenuto); il coordinatore li apre e li
-- scarica in un PDF solo. aperto_at dice al titolare se l'ha aperto.
CREATE TABLE IF NOT EXISTS pacchetti_sicurezza (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id       uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  token_hash    text        NOT NULL UNIQUE,
  destinatario  text,
  contenuto     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  in_attesa     text[]      NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  aperto_at     timestamptz,
  spento_at     timestamptz
);
CREATE INDEX IF NOT EXISTS pacchetti_sicurezza_cantiere ON pacchetti_sicurezza (company_id, site_id, created_at DESC);
ALTER TABLE pacchetti_sicurezza ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
