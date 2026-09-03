-- 186_economia_movimenti_sync_triggers.sql
-- BLOCCO 1 — trigger di sincronizzazione verso site_economia_movimenti +
-- backfill una tantum. Stesso pattern delle migrazioni 151/154 (unificazione
-- documentale): DELETE+INSERT idempotente invece di ON CONFLICT puro, perché
-- qui la "chiave naturale" della riga sorgente (site_id, categoria, importo)
-- può cambiare in un UPDATE (es. rimappatura fattura su un altro cantiere) —
-- DELETE+INSERT gestisce correttamente lo spostamento senza lasciare righe
-- orfane sotto il vecchio site_id. Ogni funzione è avvolta in EXCEPTION WHEN
-- OTHERS a due livelli: la sync non deve MAI far fallire la scrittura sulla
-- tabella sorgente, nemmeno se il logging del fallimento stesso fallisce.

-- ── Helper: categoria canonica da testo libero ───────────────────────────────
-- site_costs.categoria e company_expenses.category sono testo libero (vedi
-- migrazioni 041/107) — qui si riducono alle 4 categorie del registro.
-- Volutamente conservativa: tutto ciò che non riconosce va in 'altro'
-- piuttosto che indovinare — è la stessa scelta della riga di affidabilità
-- del Blocco 3 (mai un numero senza dichiarare cosa non sa).
CREATE OR REPLACE FUNCTION economia_categoria_da_testo(p_testo text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_testo IS NULL THEN 'altro'
    WHEN p_testo ILIKE '%subappalt%' THEN 'subappalti'
    WHEN p_testo ILIKE '%manodopera%' THEN 'manodopera'
    WHEN p_testo ILIKE '%nolo%' OR p_testo ILIKE '%noleggi%' OR p_testo ILIKE '%attrezzatur%' THEN 'noleggi'
    WHEN p_testo ILIKE '%material%' OR p_testo ILIKE '%forniture%' THEN 'materiali'
    ELSE 'altro'
  END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. company_expenses (site_id valorizzato) → consuntivo
--    Il ponte fatture→margine: priorità di questo blocco. Una fattura
--    fornitore attribuita a un cantiere (via Importazione Intelligente, SdI,
--    o manuale) oggi non entra nel margine — dopo questa migrazione sì.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_company_expenses_to_economia_movimenti() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'fattura' AND source_table = 'company_expenses' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'fattura' AND source_table = 'company_expenses' AND source_id = NEW.id::text;
      IF NEW.site_id IS NOT NULL THEN
        INSERT INTO site_economia_movimenti (
          company_id, site_id, tipo, categoria, importo, data_competenza,
          sorgente, source_table, source_id, note, created_by, created_at, updated_at
        ) VALUES (
          NEW.company_id, NEW.site_id, 'consuntivo', economia_categoria_da_testo(NEW.category),
          NEW.amount, NEW.expense_date, 'fattura', 'company_expenses', NEW.id::text,
          NEW.description, NEW.created_by, NEW.created_at, now()
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('company_expenses', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_company_expenses_economia ON company_expenses;
CREATE TRIGGER trg_sync_company_expenses_economia
  AFTER INSERT OR UPDATE OR DELETE ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION sync_company_expenses_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- 2. site_costs → consuntivo
--    Flusso "Aggiungi spesa" nativo del tab Economia (manuale + OCR).
--    ATTENZIONE (annotato anche in AUDIT.md F-119): una stessa fattura può
--    finire sia qui sia in company_expenses se l'utente usa entrambi i
--    flussi — il registro le somma entrambe. Non deduplicato in questo
--    blocco: la riga di affidabilità del Blocco 3 mostra sempre la sorgente
--    per riga, quindi il doppio conteggio è visibile e verificabile, non
--    nascosto. Da riconciliare quando i due flussi verranno unificati.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_site_costs_to_economia_movimenti() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'fattura' AND source_table = 'site_costs' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'fattura' AND source_table = 'site_costs' AND source_id = NEW.id::text;
      INSERT INTO site_economia_movimenti (
        company_id, site_id, tipo, categoria, importo, data_competenza,
        sorgente, source_table, source_id, note, created_at, updated_at
      ) VALUES (
        NEW.company_id, NEW.site_id, 'consuntivo', economia_categoria_da_testo(NEW.categoria),
        NEW.importo, COALESCE(NEW.data_documento, NEW.created_at::date),
        'fattura', 'site_costs', NEW.id::text, NEW.descrizione, NEW.created_at, now()
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('site_costs', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_costs_economia ON site_costs;
CREATE TRIGGER trg_sync_site_costs_economia
  AFTER INSERT OR UPDATE OR DELETE ON site_costs
  FOR EACH ROW EXECUTE FUNCTION sync_site_costs_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- 3. site_computo (tipo='base' o variante approvata) → budget
--    Stessa logica additiva già usata da calcPnl() in economia.js: contratto
--    base + somma delle varianti con stato='approvata'. Qui si ottiene lo
--    stesso risultato con più righe budget invece di un pre-calcolo, così
--    il registro resta la fonte unica anche per il budget.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_site_computo_to_economia_movimenti() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'computo' AND source_table = 'site_computo' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'computo' AND source_table = 'site_computo' AND source_id = NEW.id::text;
      IF NEW.totale_contratto IS NOT NULL AND (
           NEW.tipo = 'base' OR (NEW.tipo = 'variante' AND NEW.stato = 'approvata')
         ) THEN
        INSERT INTO site_economia_movimenti (
          company_id, site_id, tipo, categoria, importo, data_competenza,
          sorgente, source_table, source_id, note, created_by, created_at, updated_at
        ) VALUES (
          NEW.company_id, NEW.site_id, 'budget', 'altro', NEW.totale_contratto, NEW.created_at::date,
          'computo', 'site_computo', NEW.id::text,
          CASE WHEN NEW.tipo = 'variante' THEN 'Variante approvata — ' || NEW.nome ELSE NEW.nome END,
          NEW.created_by, NEW.created_at, now()
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('site_computo', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_computo_economia ON site_computo;
CREATE TRIGGER trg_sync_site_computo_economia
  AFTER INSERT OR UPDATE OR DELETE ON site_computo
  FOR EACH ROW EXECUTE FUNCTION sync_site_computo_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- 4. site_subcontracts (stato emesso/chiuso) → impegnato
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_site_subcontracts_to_economia_movimenti() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'contratto' AND source_table = 'site_subcontracts' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'contratto' AND source_table = 'site_subcontracts' AND source_id = NEW.id::text;
      IF NEW.stato IN ('emesso', 'chiuso') THEN
        INSERT INTO site_economia_movimenti (
          company_id, site_id, tipo, categoria, importo, data_competenza,
          sorgente, source_table, source_id, note, created_by, created_at, updated_at
        ) VALUES (
          NEW.company_id, NEW.site_id, 'impegnato', 'subappalti', NEW.importo_pattuito, NEW.data_emissione,
          'contratto', 'site_subcontracts', NEW.id::text, NEW.descrizione, NEW.created_by, NEW.created_at, now()
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('site_subcontracts', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_subcontracts_economia ON site_subcontracts;
CREATE TRIGGER trg_sync_site_subcontracts_economia
  AFTER INSERT OR UPDATE OR DELETE ON site_subcontracts
  FOR EACH ROW EXECUTE FUNCTION sync_site_subcontracts_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- 5. site_subcontract_sal → consuntivo (converte impegnato in consuntivo)
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_site_subcontract_sal_to_economia_movimenti() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'sal' AND source_table = 'site_subcontract_sal' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'sal' AND source_table = 'site_subcontract_sal' AND source_id = NEW.id::text;
      INSERT INTO site_economia_movimenti (
        company_id, site_id, tipo, categoria, importo, data_competenza,
        sorgente, source_table, source_id, note, created_by, created_at, updated_at
      ) VALUES (
        NEW.company_id, NEW.site_id, 'consuntivo', 'subappalti', NEW.importo, NEW.data,
        'sal', 'site_subcontract_sal', NEW.id::text, NEW.note, NEW.created_by, NEW.created_at, now()
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('site_subcontract_sal', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_subcontract_sal_economia ON site_subcontract_sal;
CREATE TRIGGER trg_sync_site_subcontract_sal_economia
  AFTER INSERT OR UPDATE OR DELETE ON site_subcontract_sal
  FOR EACH ROW EXECUTE FUNCTION sync_site_subcontract_sal_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- 6. site_sal_history → ricavo (delta vs SAL precedente dello stesso cantiere)
--    site_sal_history.importo_maturato è un valore CUMULATIVO al momento
--    dell'emissione (stessa logica di calcPnl in economia.js), non un
--    incremento — il ricavo del periodo è la differenza rispetto al SAL
--    precedente (0 se è il primo).
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_site_sal_history_to_economia_movimenti() RETURNS TRIGGER AS $$
DECLARE
  v_prev  numeric(14,2);
  v_delta numeric(14,2);
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'sal' AND source_table = 'site_sal_history' AND source_id = OLD.id::text;
    ELSE
      DELETE FROM site_economia_movimenti
        WHERE sorgente = 'sal' AND source_table = 'site_sal_history' AND source_id = NEW.id::text;
      IF NEW.importo_maturato IS NOT NULL THEN
        SELECT importo_maturato INTO v_prev
          FROM site_sal_history
          WHERE site_id = NEW.site_id AND sal_number < NEW.sal_number
          ORDER BY sal_number DESC LIMIT 1;
        v_delta := NEW.importo_maturato - COALESCE(v_prev, 0);
        IF v_delta <> 0 THEN
          INSERT INTO site_economia_movimenti (
            company_id, site_id, tipo, categoria, importo, data_competenza,
            sorgente, source_table, source_id, note, created_by, created_at, updated_at
          ) VALUES (
            NEW.company_id, NEW.site_id, 'ricavo', 'altro', v_delta, NEW.data_emissione,
            'sal', 'site_sal_history', NEW.id::text, 'SAL N.' || NEW.sal_number, NULL, NEW.created_at, now()
          );
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO economia_sync_failures (source_table, source_id, operation, error_message)
      VALUES ('site_sal_history', COALESCE(NEW.id, OLD.id)::text, TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_sal_history_economia ON site_sal_history;
CREATE TRIGGER trg_sync_site_sal_history_economia
  AFTER INSERT OR UPDATE OR DELETE ON site_sal_history
  FOR EACH ROW EXECUTE FUNCTION sync_site_sal_history_to_economia_movimenti();

-- ══════════════════════════════════════════════════════════════════════════
-- Backfill una tantum — idempotente (ON CONFLICT DO NOTHING sulla UNIQUE
-- (sorgente, source_table, source_id, tipo)). Scrive direttamente nel
-- registro, non passa dai trigger (nessuna scrittura sulle tabelle sorgente).
-- ══════════════════════════════════════════════════════════════════════════

INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_by, created_at, updated_at
)
SELECT company_id, site_id, 'consuntivo', economia_categoria_da_testo(category),
       amount, expense_date, 'fattura', 'company_expenses', id::text, description, created_by, created_at, now()
FROM company_expenses
WHERE site_id IS NOT NULL
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;

INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_at, updated_at
)
SELECT company_id, site_id, 'consuntivo', economia_categoria_da_testo(categoria),
       importo, COALESCE(data_documento, created_at::date), 'fattura', 'site_costs', id::text, descrizione, created_at, now()
FROM site_costs
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;

INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_by, created_at, updated_at
)
SELECT company_id, site_id, 'budget', 'altro', totale_contratto, created_at::date,
       'computo', 'site_computo', id::text,
       CASE WHEN tipo = 'variante' THEN 'Variante approvata — ' || nome ELSE nome END,
       created_by, created_at, now()
FROM site_computo
WHERE totale_contratto IS NOT NULL
  AND (tipo = 'base' OR (tipo = 'variante' AND stato = 'approvata'))
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;

INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_by, created_at, updated_at
)
SELECT company_id, site_id, 'impegnato', 'subappalti', importo_pattuito, data_emissione,
       'contratto', 'site_subcontracts', id::text, descrizione, created_by, created_at, now()
FROM site_subcontracts
WHERE stato IN ('emesso', 'chiuso')
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;

INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_by, created_at, updated_at
)
SELECT company_id, site_id, 'consuntivo', 'subappalti', importo, data,
       'sal', 'site_subcontract_sal', id::text, note, created_by, created_at, now()
FROM site_subcontract_sal
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;

-- SAL committente: delta calcolato in ordine cronologico per cantiere.
INSERT INTO site_economia_movimenti (
  company_id, site_id, tipo, categoria, importo, data_competenza,
  sorgente, source_table, source_id, note, created_at, updated_at
)
SELECT company_id, site_id, 'ricavo', 'altro', delta, data_emissione,
       'sal', 'site_sal_history', id::text, 'SAL N.' || sal_number, created_at, now()
FROM (
  SELECT id, company_id, site_id, sal_number, data_emissione, created_at,
         importo_maturato - COALESCE(
           LAG(importo_maturato) OVER (PARTITION BY site_id ORDER BY sal_number), 0
         ) AS delta
  FROM site_sal_history
  WHERE importo_maturato IS NOT NULL
) x
WHERE delta <> 0
ON CONFLICT (sorgente, source_table, source_id, tipo) DO NOTHING;
