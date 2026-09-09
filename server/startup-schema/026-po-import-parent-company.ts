/**
 * Repair the production company relationships required by PO Import.
 *
 * HMD KINSHASA and MALI are ERP children of HADI L'SHI. Supplier inheritance
 * and the parent-side intercompany supplier posting both depend on that explicit
 * relationship. Keep this repair name-based and guarded so it remains safe if
 * company IDs differ between environments, and never overwrite an existing
 * parent assignment.
 */
export const poImportParentCompany = [
  `DO $$
DECLARE
  parent_id INTEGER;
BEGIN
  SELECT id
    INTO parent_id
    FROM companies
   WHERE UPPER(TRIM(name)) = 'HADI L''SHI'
     AND company_type = 'erp'
     AND active = TRUE
   ORDER BY id
   LIMIT 1;

  IF parent_id IS NOT NULL THEN
    UPDATE companies
       SET parent_company_id = parent_id
     WHERE UPPER(TRIM(name)) IN ('HMD KINSHASA', 'MALI')
       AND company_type = 'erp'
       AND active = TRUE
       AND id <> parent_id
       AND parent_company_id IS NULL;
  END IF;
END $$`,
];
