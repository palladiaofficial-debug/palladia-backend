-- 189_economia_moltiplicatore_costo_azienda.sql
-- BLOCCO 2 — moltiplicatore costo-azienda della manodopera.
-- La tariffa oraria nuda (workers.tariffa_oraria) sottostima il costo reale
-- del lavoratore per l'azienda del ~40-45%: contributi INPS/INAIL a carico
-- datore, TFR, ferie/permessi/malattia maturati e non lavorati, tredicesima.
-- Configurabile per azienda (non tutte le imprese hanno lo stesso CCNL/livello
-- contributivo), mai nascosto nel calcolo — va sempre mostrato accanto al
-- costo manodopera che genera (vincolo esplicito dell'utente).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS moltiplicatore_costo_manodopera numeric(4,2) NOT NULL DEFAULT 1.45
    CHECK (moltiplicatore_costo_manodopera >= 1.00 AND moltiplicatore_costo_manodopera <= 2.50);

COMMENT ON COLUMN companies.moltiplicatore_costo_manodopera IS
  'Moltiplicatore applicato a workers.tariffa_oraria per stimare il costo aziendale reale della manodopera (contributi, TFR, ferie, malattia, tredicesima). Default 1,45, tipico CCNL edile. Sempre mostrato in chiaro nella UI, mai un valore implicito nel calcolo.';
