-- 231 — "Prenotata" sulle righe di Da fare (F-243)
-- Una scadenza già gestita (visita prenotata, corso fissato, rinnovo richiesto)
-- esce dalle urgenze fino a `torna_il`; poi, se il documento nuovo non è
-- arrivato, torna da sola. item_id è l'id stabile della riga in lib/daFare.js
-- (es. "doc:<uuid>", "worker:<uuid>:idoneita").
CREATE TABLE IF NOT EXISTS da_fare_prenotazioni (
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id     text        NOT NULL,
  torna_il    date        NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_id)
);
ALTER TABLE da_fare_prenotazioni ENABLE ROW LEVEL SECURITY;
