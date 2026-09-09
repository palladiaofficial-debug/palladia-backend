-- F-160 (AUDIT.md): il default storico di weather_rain_mm (10mm) non aveva
-- alcuna base normativa — era un numero scelto senza verificare i criteri
-- reali usati da INPS per valutare la Cassa Integrazione Ordinaria edile per
-- eventi meteo (msg. INPS 28336 del 28/07/1998, ripreso da ANCE Enna 2017):
-- 1mm per lavori esterni di intonacatura/verniciatura/pavimentazione/
-- impermeabilizzazione (la voce più vicina a coperture e facciate), 1,5mm
-- per scavi/movimento terra, 2-3mm per costruzione generale. L'utente ha
-- scelto di adottare 1mm come singolo nuovo default (non differenziato per
-- lavorazione) — il valore più cautelativo tra quelli citati dalla fonte.
--
-- Applicato sia al default di colonna (nuovi cantieri) sia ai cantieri
-- esistenti che sono ancora sul vecchio default mai personalizzato (=10) —
-- decisione esplicita dell'utente, consapevole che questo fa emergere di
-- colpo giorni di pioggia storici mai valutati (vedi scripts/backfill-198-*).

ALTER TABLE sites ALTER COLUMN weather_rain_mm SET DEFAULT 1;
