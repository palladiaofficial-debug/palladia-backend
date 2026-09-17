-- F-210 (AUDIT.md) — il Registro Caldo Cantiere (migrazione 218, 2026-09-17)
-- usava una stima WBGT calcolata da dati ARPAL come fonte del "bollino
-- rosso". Il titolare ha corretto: Worklimate (INAIL-CNR) è la fonte che le
-- ordinanze comunali/regionali citano esplicitamente per lo stop cantieri
-- — più autorevole legalmente della nostra stima interna, che rischiava di
-- produrre un secondo numero in conflitto con quello ufficiale in sede
-- legale ("niente doppio binario che può confliggere").
--
-- Riverificato dal vivo (2026-09-17, dopo la correzione): esiste
-- archivio.worklimate.it, un archivio storico REALE (non solo le previsioni
-- 3-5gg già escluse in migrations/218) — ma è un portale con login, NESSUNA
-- API pubblica, max 5 ricerche/mese per utente registrato, ciascuna su una
-- finestra di massimo 4 mesi, dati disponibili solo dal 2026. Non è
-- automatizzabile con un cron come si è fatto per ARPAL: il bisogno reale
-- ("imposto inizio/fine per chiedere giorni di proroga") è comunque
-- occasionale per natura, non continuo, quindi il vincolo si adatta a un
-- flusso di CERTIFICAZIONE MANUALE — un tecnico interroga l'archivio
-- Worklimate e Palladia registra esattamente quei giorni, non li calcola.
--
-- Scala ufficiale Worklimate (verificata via ricerca web, 2026-09-17):
-- verde (nullo) / giallo (basso) / arancione (moderato) / rosso (alto) —
-- il "bollino rosso" della domanda del titolare è letteralmente il livello
-- più alto di questa scala, non un concetto informale.
--
-- 543 righe di stime ARPAL esistenti verificate in produzione: 0 confermate
-- (nessuna sospensione reale mai basata su questi dati — l'unico test dal
-- vivo del 2026-09-17 è stato annullato prima di lasciare traccia), quindi
-- sicuro azzerare la tabella invece di migrare dati che non erano mai stati
-- la fonte legale.

TRUNCATE site_heat_logs;

ALTER TABLE site_heat_logs
  DROP COLUMN IF EXISTS temp_max_c,
  DROP COLUMN IF EXISTS humidity_pct,
  DROP COLUMN IF EXISTS solar_radiation_jcm2,
  DROP COLUMN IF EXISTS wbgt_estimate_c,
  DROP COLUMN IF EXISTS threshold_exceeded,
  DROP COLUMN IF EXISTS threshold_reason,
  DROP COLUMN IF EXISTS data_source,
  DROP COLUMN IF EXISTS arpal_station_name,
  DROP COLUMN IF EXISTS arpal_source_path,
  DROP COLUMN IF EXISTS fetched_at;

ALTER TABLE site_heat_logs
  ADD COLUMN risk_level  text        NOT NULL DEFAULT 'rosso'
              CHECK (risk_level IN ('verde', 'giallo', 'arancione', 'rosso')),
  ADD COLUMN comune      text        NOT NULL DEFAULT '',
  ADD COLUMN entered_by  uuid,
  ADD COLUMN entered_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN source_note text;

-- I default sopra servono solo a soddisfare il NOT NULL su una tabella
-- appena svuotata — ogni riga futura li passa esplicitamente (vedi
-- routes/v1/siteHeat.js), quindi li rimuoviamo per non nascondere un
-- inserimento incompleto dietro un default silenzioso.
ALTER TABLE site_heat_logs ALTER COLUMN risk_level DROP DEFAULT;
ALTER TABLE site_heat_logs ALTER COLUMN comune      DROP DEFAULT;

-- La soglia numerica interna (°C) e il toggle di allerta non hanno più
-- alcun effetto: nessun cron la legge, nessun calcolo la usa. Lasciarli nel
-- prodotto sarebbe un controllo apparente che non fa nulla — esattamente il
-- tipo di dato "inventato" che la richiesta del titolare vietava.
ALTER TABLE sites     DROP COLUMN IF EXISTS heat_temp_threshold_c;
ALTER TABLE sites     DROP COLUMN IF EXISTS heat_alert_enabled;
ALTER TABLE companies DROP COLUMN IF EXISTS heat_temp_threshold_c;

COMMENT ON TABLE site_heat_logs IS 'Registro caldo cantiere — giorni di rischio Worklimate (INAIL-CNR) inseriti MANUALMENTE da un utente dopo consultazione di archivio.worklimate.it (nessuna API pubblica, max 5 ricerche/mese, finestra max 4 mesi). risk_level è la classificazione ufficiale letta dal portale, non una stima interna. Vedi migrazione 219 per il perché della sostituzione della stima ARPAL/WBGT (migrazione 218).';
COMMENT ON COLUMN site_heat_logs.risk_level IS 'Livello di rischio ufficiale Worklimate per quel giorno/comune: verde (nullo), giallo (basso), arancione (moderato), rosso (alto = "bollino rosso", stop lavori esposti al sole 12:30-16:00).';
COMMENT ON COLUMN site_heat_logs.comune IS 'Comune usato per la ricerca su Worklimate — può differire lievemente dall''indirizzo del cantiere, tracciato per l''audit trail della relazione tecnica.';
COMMENT ON COLUMN site_heat_logs.entered_by IS 'Utente che ha trascritto il dato dall''archivio Worklimate — nessuna scrittura automatica, sempre un inserimento umano tracciato.';
COMMENT ON COLUMN site_heat_logs.source_note IS 'Riferimento libero alla ricerca Worklimate di provenienza (es. data della ricerca, intervallo interrogato) — utile per giustificare il dato vista la quota di 5 ricerche/mese del portale.';
