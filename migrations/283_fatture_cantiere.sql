-- 283 — F-510 (AUDIT.md del frontend): le fatture dei fornitori vanno sul cantiere giusto.
-- site_id NULL vuol dire due cose diverse: «non ancora chiesto» oppure «spesa
-- generale, nessun cantiere». Questa colonna segna quando il titolare ha risposto,
-- così una spesa generale non viene richiesta di nuovo.
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS cantiere_scelto_at timestamptz;
