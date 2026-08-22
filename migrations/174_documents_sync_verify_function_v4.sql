-- 174_documents_sync_verify_function_v4.sql
-- Fase 2, Scaglione 4 — la funzione di verifica ricorrente deve controllare
-- anche equipment_documents. Stesso schema delle versioni precedenti
-- (152/155/158), solo un blocco UNION ALL in più.

CREATE OR REPLACE FUNCTION verify_documents_sync()
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

  UNION ALL

  SELECT
    'subcontractor_documents'::text,
    (SELECT count(*) FROM subcontractor_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'subcontractor_documents'),
    (SELECT count(*) FROM subcontractor_documents scd
       LEFT JOIN documents d ON d.source_table = 'subcontractor_documents' AND d.legacy_id = scd.id
       WHERE d.id IS NULL
          OR d.company_id       IS DISTINCT FROM scd.company_id
          OR d.subcontractor_id IS DISTINCT FROM scd.subcontractor_id
          OR d.file_path        IS DISTINCT FROM scd.file_path
          OR d.category         IS DISTINCT FROM scd.category
          OR d.expiry_date      IS DISTINCT FROM scd.valid_until
          OR d.content_hash     IS DISTINCT FROM scd.content_hash),
    (SELECT count(*) FROM documents d
       LEFT JOIN subcontractor_documents scd ON scd.id = d.legacy_id
       WHERE d.source_table = 'subcontractor_documents' AND scd.id IS NULL)

  UNION ALL

  SELECT
    'payslips'::text,
    (SELECT count(*) FROM payslips),
    (SELECT count(*) FROM documents WHERE source_table = 'payslips'),
    (SELECT count(*) FROM payslips ps
       LEFT JOIN documents d ON d.source_table = 'payslips' AND d.legacy_id = ps.id
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM ps.company_id
          OR d.worker_id  IS DISTINCT FROM ps.worker_id
          OR d.studio_id  IS DISTINCT FROM ps.studio_id
          OR d.file_path  IS DISTINCT FROM ps.file_path
          OR d.period_year  IS DISTINCT FROM ps.period_year
          OR d.period_month IS DISTINCT FROM ps.period_month
          OR d.payslip_status IS DISTINCT FROM ps.status),
    (SELECT count(*) FROM documents d
       LEFT JOIN payslips ps ON ps.id = d.legacy_id
       WHERE d.source_table = 'payslips' AND ps.id IS NULL)

  UNION ALL

  SELECT
    'ladia_document_templates'::text,
    (SELECT count(*) FROM ladia_document_templates),
    (SELECT count(*) FROM documents WHERE source_table = 'ladia_document_templates'),
    (SELECT count(*) FROM ladia_document_templates ldt
       LEFT JOIN documents d ON d.source_table = 'ladia_document_templates' AND d.legacy_id = ldt.id
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM ldt.company_id
          OR d.file_path  IS DISTINCT FROM ldt.storage_path
          OR d.category   IS DISTINCT FROM ldt.document_type),
    (SELECT count(*) FROM documents d
       LEFT JOIN ladia_document_templates ldt ON ldt.id = d.legacy_id
       WHERE d.source_table = 'ladia_document_templates' AND ldt.id IS NULL)

  UNION ALL

  SELECT
    'studio_shared_documents'::text,
    (SELECT count(*) FROM studio_shared_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'studio_shared_documents'),
    (SELECT count(*) FROM studio_shared_documents ssd
       LEFT JOIN documents d ON d.source_table = 'studio_shared_documents' AND d.legacy_id = ssd.id
       WHERE d.id IS NULL
          OR d.company_id IS DISTINCT FROM ssd.company_id
          OR d.studio_id  IS DISTINCT FROM ssd.studio_id
          OR d.file_path  IS DISTINCT FROM ssd.file_path
          OR d.category   IS DISTINCT FROM ssd.category),
    (SELECT count(*) FROM documents d
       LEFT JOIN studio_shared_documents ssd ON ssd.id = d.legacy_id
       WHERE d.source_table = 'studio_shared_documents' AND ssd.id IS NULL)

  UNION ALL

  SELECT
    'studio_document_requests'::text,
    (SELECT count(*) FROM studio_document_requests),
    (SELECT count(*) FROM documents WHERE source_table = 'studio_document_requests'),
    (SELECT count(*) FROM studio_document_requests sdr
       LEFT JOIN documents d ON d.source_table = 'studio_document_requests' AND d.legacy_id = sdr.id
       WHERE d.id IS NULL
          OR d.company_id     IS DISTINCT FROM sdr.company_id
          OR d.studio_id      IS DISTINCT FROM sdr.studio_id
          OR d.category       IS DISTINCT FROM sdr.document_type
          OR d.due_date       IS DISTINCT FROM sdr.due_date
          OR d.request_status IS DISTINCT FROM sdr.status
          OR d.response_url   IS DISTINCT FROM sdr.response_url
          OR d.upload_token   IS DISTINCT FROM sdr.upload_token),
    (SELECT count(*) FROM documents d
       LEFT JOIN studio_document_requests sdr ON sdr.id = d.legacy_id
       WHERE d.source_table = 'studio_document_requests' AND sdr.id IS NULL)

  UNION ALL

  SELECT
    'equipment_documents'::text,
    (SELECT count(*) FROM equipment_documents),
    (SELECT count(*) FROM documents WHERE source_table = 'equipment_documents'),
    (SELECT count(*) FROM equipment_documents ed
       LEFT JOIN documents d ON d.source_table = 'equipment_documents' AND d.legacy_id = ed.id
       WHERE d.id IS NULL
          OR d.company_id   IS DISTINCT FROM ed.company_id
          OR d.equipment_id IS DISTINCT FROM ed.equipment_id
          OR d.file_path    IS DISTINCT FROM ed.file_url
          OR d.category     IS DISTINCT FROM ed.doc_type),
    (SELECT count(*) FROM documents d
       LEFT JOIN equipment_documents ed ON ed.id = d.legacy_id
       WHERE d.source_table = 'equipment_documents' AND ed.id IS NULL)

$$;
