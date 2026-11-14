-- 280 — F-500 (AUDIT.md del frontend): le bolle dei nostri autisti.
-- Una sola strada per tutte le bolle: anche quelle fotografate dal badge
-- finiscono qui (prima andavano in site_costs tipo ddt e non le vedeva
-- nessuno: né le Bolle del cantiere né il confronto con la fattura).
--  - worker_id: l'autista che l'ha portata (dal badge)
--  - pagine: tutte le foto [{path, mime}] (file_path resta la prima pagina)
--  - stato: da_controllare | a_posto | scartata («Non è una bolla»: nascosta, non cancellata)
--  - dubbi: i campi letti male ['numero', 'fornitore', 'cantiere', …]
--  - cantiere_da: come si è capito il cantiere
--  - site_id facoltativo: «Non lo so: decide l'ufficio»
--  - client_id: lo stesso invio ripetuto senza rete non crea due bolle
ALTER TABLE bolle ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS pagine jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS stato text NOT NULL DEFAULT 'a_posto'
  CHECK (stato IN ('da_controllare', 'a_posto', 'scartata'));
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS dubbi jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS cantiere_da text
  CHECK (cantiere_da IS NULL OR cantiere_da IN ('timbratura', 'bolla', 'autista', 'ufficio', 'carica'));
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS client_id text CHECK (client_id IS NULL OR char_length(client_id) <= 64);
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS controllata_at timestamptz;
ALTER TABLE bolle ADD COLUMN IF NOT EXISTS controllata_by uuid;
CREATE UNIQUE INDEX IF NOT EXISTS bolle_client_id ON bolle (company_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bolle_da_controllare ON bolle (company_id, created_at DESC) WHERE stato = 'da_controllare';
