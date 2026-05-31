-- Migration 089: riallinea health_fitness_expiry e safety_training_expiry
-- a MAX(expiry_date) dei documenti reali in worker_documents.
--
-- Necessaria perché il vecchio syncWorkerExpiry sovrascriveva il campo con
-- la data dell'ultimo documento caricato invece di prendere il massimo:
-- se un documento vecchio (scadenza bassa) veniva caricato dopo uno nuovo
-- (scadenza alta), il campo rimaneva bloccato sul valore basso.

UPDATE workers w
SET health_fitness_expiry = (
  SELECT MAX(expiry_date)
  FROM worker_documents wd
  WHERE wd.worker_id  = w.id
    AND wd.company_id = w.company_id
    AND wd.doc_type   = 'idoneita_medica'
    AND wd.expiry_date IS NOT NULL
);

UPDATE workers w
SET safety_training_expiry = (
  SELECT MAX(expiry_date)
  FROM worker_documents wd
  WHERE wd.worker_id  = w.id
    AND wd.company_id = w.company_id
    AND wd.doc_type   = 'formazione_sicurezza'
    AND wd.expiry_date IS NOT NULL
);
