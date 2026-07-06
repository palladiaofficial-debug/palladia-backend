-- Migration 125: pos_drafts.risks_content — sezione 5 del POS ("Lavorazioni,
-- Rischi e Misure") generabile in chat con Ladia, sezione a sé, invece di
-- un'unica chiamata AI nascosta nell'endpoint di generazione finale.
-- selected_works (già esistente su pos_drafts) funge da "ancora": prima di
-- riusare risks_content già generato, il chiamante verifica che le
-- lavorazioni non siano cambiate nel frattempo (vedi server.js).

ALTER TABLE pos_drafts ADD COLUMN IF NOT EXISTS risks_content      text;
ALTER TABLE pos_drafts ADD COLUMN IF NOT EXISTS risks_generated_at timestamptz;
