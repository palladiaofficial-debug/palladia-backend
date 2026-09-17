-- Motivo uscita (maltempo/malattia/permesso) — richiesta esplicita del
-- titolare (2026-09-17): "come funziona la timbratura [se un lavoratore
-- esce per pioggia]? come segniamo che era a causa della pioggia e non di
-- un malessere?" — con un vincolo esplicito e prioritario: "qualsiasi
-- modifica deve essere un miglioramento, non deve inficiare in minima
-- maniera il funzionamento vitale delle timbrature".
--
-- Per questo NON si tocca presence_logs (append-only, invariante critico —
-- vedi migrations/002/003) e NON si riusa l'annotazione esistente
-- (admin_audit_log action='presence.log_annotation', POST /presence/:id/
-- annotate): quella è letta da lib/presencePairing.js::stripAnnotatedGlitches
-- per FONDERE un'uscita con l'entrata successiva quando è un glitch tecnico
-- (F-184) — riusarla per "motivo: pioggia" fonderebbe silenziosamente ore
-- reali lavorate, l'esatto contrario di quanto richiesto.
--
-- presence_log_reasons è una tabella nuova e completamente separata: pura
-- etichetta informativa su una timbratura già esistente, mai letta dal
-- pairing/calcolo ore (lib/presencePairing.js) — solo dai generatori di
-- report per mostrarla come nota. Stesso pattern append-only degli altri
-- meccanismi di correzione del prodotto (presence_lunch_overrides,
-- admin_audit_log): nessuna UPDATE/DELETE, un ri-tag successivo è una nuova
-- riga, il lettore prende sempre la più recente per presence_log_id.

CREATE TABLE IF NOT EXISTS presence_log_reasons (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  presence_log_id  uuid        NOT NULL REFERENCES presence_logs(id) ON DELETE CASCADE,
  reason           text        NOT NULL CHECK (reason IN ('maltempo', 'malattia', 'permesso')),
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_presence_log_reasons_log
  ON presence_log_reasons (presence_log_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_log_reasons_company
  ON presence_log_reasons (company_id, created_at DESC);

ALTER TABLE presence_log_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "presence_log_reasons_select_own" ON presence_log_reasons;
CREATE POLICY "presence_log_reasons_select_own"
  ON presence_log_reasons FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE/DELETE per authenticated: scritto solo dal
-- backend (service_role), dopo aver verificato ruolo owner/admin — stesso
-- pattern di admin_audit_log e presence_lunch_overrides.

COMMENT ON TABLE presence_log_reasons IS 'Motivo di un''uscita (maltempo/malattia/permesso), applicato da un admin dopo il fatto — pura etichetta, mai letta dal calcolo ore. Vedi lib/presencePairing.js per il motivo per cui non riusa admin_audit_log.presence.log_annotation.';
