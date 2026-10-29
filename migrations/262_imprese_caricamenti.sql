-- 262 — F-401 (AUDIT.md del frontend): «Carica documenti» delle imprese in
-- subappalto, tutti in un colpo («i subappaltatori mandano tantissimi documenti
-- disordinati… dovremmo poterli caricare tutti in un solo colpo e averli
-- ordinati, perfetti, analizzati, avere controllo su scadenze», il titolare, 29/10).
--
-- 1. Un caricamento = tutto quello che il titolare butta dentro (PDF, foto, ZIP).
--    Ogni file diventa uno o più documenti (un PDF con più documenti si divide).
--    Ogni documento è letto, attribuito (impresa, operaio, cantiere) e
--    controllato PRIMA di finire nelle tabelle vere: il titolare vede tutto
--    ordinato, corregge e salva.
-- 2. Gli operai delle imprese possono avere anche altri attestati (preposto,
--    primo soccorso, antincendio, PLE, ponteggi…): tipo 'altro' con il titolo.
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy.

CREATE TABLE IF NOT EXISTS imprese_caricamenti (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id  uuid        REFERENCES subcontractors(id) ON DELETE SET NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  salvato_at        timestamptz,
  esito             jsonb
);
CREATE INDEX IF NOT EXISTS imprese_caricamenti_company ON imprese_caricamenti (company_id, created_at DESC);
ALTER TABLE imprese_caricamenti ENABLE ROW LEVEL SECURITY;

-- Un file caricato (prima di essere diviso) o un documento (dopo)
CREATE TABLE IF NOT EXISTS imprese_caricamento_doc (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caricamento_id    uuid        NOT NULL REFERENCES imprese_caricamenti(id) ON DELETE CASCADE,
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  livello           text        NOT NULL CHECK (livello IN ('file', 'documento')),
  file_id           uuid        REFERENCES imprese_caricamento_doc(id) ON DELETE CASCADE,
  stato             text        NOT NULL DEFAULT 'in_coda'
                    CHECK (stato IN ('in_coda', 'in_lettura', 'diviso', 'pronto', 'errore', 'salvato', 'scartato')),
  errore            text,
  lettura_at        timestamptz,
  nome_file         text,
  pagine            text,
  file_path         text NOT NULL,
  mime_type         text,
  content_hash      text,
  letto             jsonb,
  proposta          jsonb,
  ordine            integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS imprese_caricamento_doc_car ON imprese_caricamento_doc (caricamento_id, livello, ordine);
ALTER TABLE imprese_caricamento_doc ENABLE ROW LEVEL SECURITY;

ALTER TABLE sub_worker_documenti DROP CONSTRAINT IF EXISTS sub_worker_documenti_tipo_check;
ALTER TABLE sub_worker_documenti ADD CONSTRAINT sub_worker_documenti_tipo_check CHECK (tipo IN ('idoneita', 'formazione', 'altro'));
ALTER TABLE sub_worker_documenti ADD COLUMN IF NOT EXISTS titolo text;
ALTER TABLE sub_worker_documenti ADD COLUMN IF NOT EXISTS content_hash text;
