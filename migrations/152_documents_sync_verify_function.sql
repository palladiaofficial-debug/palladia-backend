-- 152_documents_sync_verify_function.sql
-- Fase 2, Scaglione 1 — funzione di verifica ricorrente (non un gate una tantum).
-- Confronto conteggio + riga per riga fatto lato DB (scalabile, non richiede di
-- scaricare tutte le righe in Node) — callable via supabase.rpc(), a differenza
-- di exec_sql che non restituisce risultati di SELECT.

CREATE OR REPLACE FUNCTION verify_documents_sync_tier1()
RETURNS TABLE(
  source_table      text,
  legacy_count      bigint,
  documents_count   bigint,
  mismatched_count  bigint,
  orphaned_count    bigint
) LANGUAGE sql STABLE AS $$

  SELECT
    'site_documents'::text,
    (SELECT count(*) FROM site_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'site_documents'),
    (SELECT count(*) FROM site_documents sd
       LEFT JOIN documents d ON d.source_table = 'site_documents' AND d.legacy_id = sd.id
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM sd.company_id
          OR d.site_id    IS DISTINCT FROM sd.site_id
          OR d.file_path  IS DISTINCT FROM sd.file_path
          OR d.category   IS DISTINCT FROM sd.category),
    (SELECT count(*) FROM documents d
       LEFT JOIN site_documents sd ON sd.id = d.legacy_id
       WHERE d.source_table = 'site_documents' AND sd.id IS NULL)

  UNION ALL

  SELECT
    'company_documents'::text,
    (SELECT count(*) FROM company_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'company_documents'),
    (SELECT count(*) FROM company_documents cd
       LEFT JOIN documents d ON d.source_table = 'company_documents' AND d.legacy_id = cd.id
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM cd.company_id
          OR d.file_path  IS DISTINCT FROM cd.file_path
          OR d.category   IS DISTINCT FROM cd.category),
    (SELECT count(*) FROM documents d
       LEFT JOIN company_documents cd ON cd.id = d.legacy_id
       WHERE d.source_table = 'company_documents' AND cd.id IS NULL)

  UNION ALL

  SELECT
    'worker_documents'::text,
    (SELECT count(*) FROM worker_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'worker_documents'),
    (SELECT count(*) FROM worker_documents wd
       LEFT JOIN documents d ON d.source_table = 'worker_documents' AND d.legacy_id = wd.id
       LEFT JOIN LATERAL extract_storage_ref(wd.file_url) ref ON true
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM wd.company_id
          OR d.worker_id  IS DISTINCT FROM wd.worker_id
          OR d.file_path  IS DISTINCT FROM COALESCE(wd.file_path, ref.object_path)
          OR d.category   IS DISTINCT FROM wd.doc_type
          OR d.expiry_date IS DISTINCT FROM wd.expiry_date),
    (SELECT count(*) FROM documents d
       LEFT JOIN worker_documents wd ON wd.id = d.legacy_id
       WHERE d.source_table = 'worker_documents' AND wd.id IS NULL)

  UNION ALL

  -- worker_certificates: file_path in `documents` è ESTRATTO da pdf_url (spesso
  -- una signed URL), non un confronto diretto — si confrontano i campi di
  -- business che il sync non trasforma.
  SELECT
    'worker_certificates'::text,
    (SELECT count(*) FROM worker_certificates),
    (SELECT count(*) FROM documents WHERE source_table = 'worker_certificates'),
    (SELECT count(*) FROM worker_certificates wc
       LEFT JOIN documents d ON d.source_table = 'worker_certificates' AND d.legacy_id = wc.id
       WHERE d.id IS NULL
          OR d.company_id  IS DISTINCT FROM wc.company_id
          OR d.worker_id   IS DISTINCT FROM wc.worker_id
          OR d.site_id     IS DISTINCT FROM wc.site_id
          OR d.expiry_date IS DISTINCT FROM wc.expiry_date
          OR d.issued_date IS DISTINCT FROM wc.issue_date
          OR d.issuing_body IS DISTINCT FROM wc.issuing_body
          OR d.certificate_number IS DISTINCT FROM wc.certificate_number
          OR d.course_type_id IS DISTINCT FROM wc.course_type_id
          OR d.deleted_at  IS DISTINCT FROM wc.deleted_at),
    (SELECT count(*) FROM documents d
       LEFT JOIN worker_certificates wc ON wc.id = d.legacy_id
       WHERE d.source_table = 'worker_certificates' AND wc.id IS NULL)

$$;
