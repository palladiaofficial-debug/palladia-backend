-- F-207 (AUDIT.md), seguito: "se poi un cliente chiede e verifica lui
-- stesso, siamo coperti e tutelati dai dati Palladia" — richiesta esplicita
-- del titolare dopo aver verificato dal vivo che i valori certificati ARPAL
-- coincidono col portale ufficiale. Finora certificavamo solo il NUMERO
-- estratto (precipitation_mm) + nome stazione + timestamp — non il
-- documento originale scaricato da ARPAL. Se un cliente contestasse un dato
-- fra qualche anno (o se il portale ARPAL cambiasse formato/sparisse), non
-- avremmo altro che la nostra parola.
--
-- arpal_source_path: percorso nel bucket Storage "arpal-source-archive" del
-- CSV ufficiale ARPAL usato per certificare QUESTA riga — lo stesso file
-- byte per byte che un cliente otterrebbe scaricandolo lui stesso dal
-- portale, non una nostra trascrizione. Un singolo file copre spesso un
-- range di più giorni (una richiesta ARPAL = molti giorni), quindi più
-- righe condividono lo stesso path — normale, non un errore.
-- NULL per le righe certificate PRIMA di questa migrazione (non
-- retro-archiviate in blocco: avrebbe richiesto ri-scaricare l'intero
-- storico di ogni cantiere della piattaforma solo per un file di prova,
-- senza che nessuno l'avesse chiesto).

ALTER TABLE site_weather_logs
  ADD COLUMN IF NOT EXISTS arpal_source_path TEXT;

COMMENT ON COLUMN site_weather_logs.arpal_source_path IS 'Percorso nel bucket Storage arpal-source-archive del CSV ufficiale ARPAL usato per certificare questa riga — il documento originale, non solo il valore estratto. NULL per righe certificate prima della F-207 (2026-09-17) o quando l''upload di archiviazione fallisce (mai bloccante per la certificazione stessa).';
