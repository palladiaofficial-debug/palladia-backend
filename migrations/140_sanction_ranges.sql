-- ─── 140_sanction_ranges.sql ──────────────────────────────────────────────────
-- Layer "proof of value": tabella di riferimento sanzioni D.Lgs 81/2008 usata
-- per calcolare "sanzioni potenziali evitate" nel widget dashboard (Feature 1).
--
-- REGOLA: si usa sempre amount_min_cents nel widget ("fino a €X"), mai il max
-- e mai una stima gonfiata. needs_review=true finché un consulente del lavoro
-- non conferma l'importo — vedi source_note per la provenienza di ogni riga
-- (ricerca incrociata più fonti, 2026-07-28, non sostituisce una verifica legale).
--
-- Non tutte le 17 categorie di company_documents hanno una sanzione diretta e
-- difendibile: document_category_sanction_map mappa esplicitamente quali sì
-- (violation_code valorizzato) e quali no (NULL — restano fuori dal conteggio
-- €, ma continuano a contare come "scadenza gestita" in generale).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sanction_ranges (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_code    text        NOT NULL UNIQUE,
  violation_label   text        NOT NULL,
  legal_reference   text        NOT NULL,
  amount_min_cents  integer     NOT NULL CHECK (amount_min_cents >= 0),
  amount_max_cents  integer     CHECK (amount_max_cents IS NULL OR amount_max_cents >= amount_min_cents),
  source_note       text        NOT NULL,
  needs_review      boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION _sanction_ranges_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_sanction_ranges_updated_at ON sanction_ranges;
CREATE TRIGGER trg_sanction_ranges_updated_at
  BEFORE UPDATE ON sanction_ranges
  FOR EACH ROW EXECUTE FUNCTION _sanction_ranges_set_updated_at();

-- ── Mappa company_documents.category (enum chiuso, migrazione 049) → sanzione ──
CREATE TABLE IF NOT EXISTS document_category_sanction_map (
  category        text PRIMARY KEY,
  violation_code  text REFERENCES sanction_ranges(violation_code) ON DELETE SET NULL
);

-- ── course_types (taxonomy corsi, migrazione 045) → sanzione ──────────────────
ALTER TABLE course_types ADD COLUMN IF NOT EXISTS violation_code text
  REFERENCES sanction_ranges(violation_code) ON DELETE SET NULL;

-- ── Seed: nucleo verificato (fonti incrociate 2026-07-28) ─────────────────────
INSERT INTO sanction_ranges (violation_code, violation_label, legal_reference, amount_min_cents, amount_max_cents, source_note, needs_review) VALUES
  ('dvr_omesso',
   'Omessa redazione del DVR',
   'D.Lgs 81/2008 art. 55 comma 1',
   250000, 640000,
   'Ricerca incrociata 2026-07-28 (2 fonti concordi: arresto 3-6 mesi o ammenda €2.500-6.400). Non sostituisce verifica di un consulente del lavoro.',
   true),
  ('rspp_mancata_nomina',
   'Mancata nomina del Responsabile del Servizio di Prevenzione e Protezione (RSPP)',
   'D.Lgs 81/2008 art. 55 comma 5 lett. a',
   250000, 640000,
   'Ricerca incrociata 2026-07-28 — fonti discordanti sull''importo esatto (range osservato €2.500-6.400 fino a €3.556,60-9.112,57 a seconda della fonte/aggiornamento ISTAT): usato il minimo più basso tra le fonti trovate per prudenza. Richiede verifica di un consulente del lavoro prima di essere considerato definitivo.',
   true),
  ('medico_competente_mancata_nomina',
   'Mancata nomina del medico competente',
   'D.Lgs 81/2008 art. 55 comma 5 lett. d',
   150000, 600000,
   'Ricerca incrociata 2026-07-28 (arresto 2-4 mesi o ammenda €1.500-6.000). Non sostituisce verifica di un consulente del lavoro.',
   true),
  ('sorveglianza_sanitaria_omessa',
   'Omessa sorveglianza sanitaria dei lavoratori',
   'D.Lgs 81/2008 art. 55',
   200000, 400000,
   'Ricerca incrociata 2026-07-28 (ammenda €2.000-4.000, fonte alternativa riporta €2.847,69-5.695,36: usato il minimo più basso). Non sostituisce verifica di un consulente del lavoro.',
   true),
  ('formazione_lavoratori_mancante',
   'Mancata formazione dei lavoratori',
   'D.Lgs 81/2008 art. 37, sanzionato da art. 55 comma 5 lett. c',
   170861, 740396,
   'Ricerca incrociata 2026-07-28 (arresto 2-4 mesi o ammenda €1.708,61-7.403,96; raddoppia se la violazione riguarda più di 5 lavoratori, triplica oltre 10 — non riflesso nel valore minimo qui salvato). Non sostituisce verifica di un consulente del lavoro.',
   true)
ON CONFLICT (violation_code) DO NOTHING;

-- ── Mappatura categorie company_documents ──────────────────────────────────────
-- NULL esplicito = nessuna sanzione diretta D.Lgs 81/2008 difendibile (requisito
-- fiscale/contrattuale, non violazione di sicurezza) o non ancora verificata:
-- il documento resta comunque tracciato come "scadenza gestita", ma non entra
-- mai nella somma "sanzioni evitate".
INSERT INTO document_category_sanction_map (category, violation_code) VALUES
  ('dvr',               'dvr_omesso'),
  ('rspp',               'rspp_mancata_nomina'),
  ('medico_competente',  'medico_competente_mancata_nomina'),
  ('visite_mediche',     'sorveglianza_sanitaria_omessa'),
  ('formazione',         'formazione_lavoratori_mancante'),
  ('rls',                NULL),  -- pending: verifica normativa specifica
  ('preposto',           NULL),  -- pending: verifica normativa specifica
  ('emergenze',          NULL),  -- pending: verifica normativa specifica (art. 43)
  ('primo_soccorso',     NULL),  -- pending: verifica normativa specifica (D.M. 388/2003)
  ('duvri',              NULL),  -- pending: verifica normativa specifica (art. 26)
  ('durc',               NULL),  -- requisito fiscale/contributivo, non violazione D.Lgs 81/2008 diretta
  ('visura',             NULL),  -- requisito camerale, non violazione D.Lgs 81/2008
  ('iso',                NULL),  -- certificazione volontaria, non violazione D.Lgs 81/2008
  ('soa',                NULL),  -- qualificazione contrattuale, non violazione D.Lgs 81/2008 diretta
  ('assicurazione',      NULL),
  ('polizza',            NULL),
  ('f24',                NULL),  -- requisito fiscale, non violazione D.Lgs 81/2008
  ('altro',              NULL)
ON CONFLICT (category) DO NOTHING;

-- ── Mappatura corsi (course_types) ─────────────────────────────────────────────
-- Solo i 3 corsi "Formazione lavoratori" mappano 1:1 all'art. 37: gli altri
-- (primo soccorso, antincendio, ponteggi, lavori in quota, patentini mezzi,
-- dirigente) hanno basi normative diverse (D.M. 388/2003, D.M. antincendio,
-- Allegato XXI, art. 116, Accordi SR) non ancora verificate riga per riga.
UPDATE course_types SET violation_code = 'formazione_lavoratori_mancante'
WHERE name IN (
  'Formazione lavoratori - Rischio Basso',
  'Formazione lavoratori - Rischio Medio',
  'Formazione lavoratori - Rischio Alto'
);

-- ── RLS — lettura per utenti autenticati (dato di riferimento, non sensibile),
--    scrittura solo da service_role (backend/seed) ────────────────────────────
ALTER TABLE sanction_ranges                ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_category_sanction_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sanction_ranges_select_all" ON sanction_ranges;
CREATE POLICY "sanction_ranges_select_all"
  ON sanction_ranges FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "doc_category_sanction_map_select_all" ON document_category_sanction_map;
CREATE POLICY "doc_category_sanction_map_select_all"
  ON document_category_sanction_map FOR SELECT
  TO authenticated
  USING (true);
