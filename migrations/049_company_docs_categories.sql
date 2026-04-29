-- Migration 049: aggiunge categorie sicurezza D.Lgs. 81/2008 a company_documents

ALTER TABLE company_documents DROP CONSTRAINT IF EXISTS company_docs_category_check;

ALTER TABLE company_documents ADD CONSTRAINT company_docs_category_check CHECK (
  category IN (
    'rspp', 'rls', 'medico_competente', 'visite_mediche',
    'primo_soccorso', 'emergenze', 'preposto',
    'dvr', 'duvri', 'formazione',
    'durc', 'visura', 'iso', 'soa',
    'assicurazione', 'polizza', 'f24',
    'altro'
  )
);
