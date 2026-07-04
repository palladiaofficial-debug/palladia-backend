-- Migration 121: pos_documents.content
-- Bug trovato con audit end-to-end: il codice in server.js ("[template-stream]")
-- salva sempre content:aiRisks nell'insert su pos_documents, ma questa colonna non
-- è mai esistita nello schema reale (migration 030 non la includeva) — ogni singolo
-- POS generato dall'AI ha sempre fallito il salvataggio in silenzio (errore
-- catturato e loggato su Sentry, mai mostrato all'utente, che vede comunque il PDF
-- generato correttamente perché /api/generate-pdf è stateless e non dipende dal
-- salvataggio). Pattern identico a dvr_documents/pimus_documents (migration 060/064),
-- che hanno sempre avuto la colonna content e infatti salvano correttamente.

ALTER TABLE pos_documents ADD COLUMN IF NOT EXISTS content TEXT;
