BEGIN;

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS company_id INTEGER;

-- The first version of this migration assigned every legacy supplier whose
-- company_id was NULL to the configured parent company. Before supplier rows
-- became company-owned, however, supplier identities were global and the
-- company context lived in the surrounding ERP activity/audit trail. That means
-- a supplier created inside another ERP company could be incorrectly stamped as
-- the configured parent and then disappear as soon as strict company scoping was
-- enabled.
--
-- Repair only when we have authoritative, unambiguous ownership evidence:
--   1. exactly one company recorded the supplier CREATE audit event; or
--   2. no CREATE audit owner exists, but the supplier is linked to a stock group
--      that belongs to one company.
-- This block is idempotent and also repairs rows that were already misassigned
-- by an earlier production run of this migration.
DO $$
DECLARE
  repaired_from_audit INTEGER := 0;
  repaired_from_stock_group INTEGER := 0;
BEGIN
  WITH unique_create_owner AS (
    SELECT record_id AS supplier_id,
           MIN(company_id)::INTEGER AS company_id
      FROM audit_log
     WHERE table_name = 'suppliers'
       AND action = 'create'
       AND record_id IS NOT NULL
       AND company_id IS NOT NULL
     GROUP BY record_id
    HAVING COUNT(DISTINCT company_id) = 1
  )
  UPDATE suppliers AS s
     SET company_id = owner.company_id
    FROM unique_create_owner AS owner
   WHERE s.id = owner.supplier_id
     AND s.company_id IS DISTINCT FROM owner.company_id;

  GET DIAGNOSTICS repaired_from_audit = ROW_COUNT;

  WITH unique_create_owner AS (
    SELECT record_id AS supplier_id
      FROM audit_log
     WHERE table_name = 'suppliers'
       AND action = 'create'
       AND record_id IS NOT NULL
       AND company_id IS NOT NULL
     GROUP BY record_id
    HAVING COUNT(DISTINCT company_id) = 1
  )
  UPDATE suppliers AS s
     SET company_id = sg.company_id
    FROM stock_groups AS sg
   WHERE s.stock_group_id = sg.id
     AND s.company_id IS DISTINCT FROM sg.company_id
     AND NOT EXISTS (
       SELECT 1
         FROM unique_create_owner AS owner
        WHERE owner.supplier_id = s.id
     );

  GET DIAGNOSTICS repaired_from_stock_group = ROW_COUNT;

  IF repaired_from_audit > 0 OR repaired_from_stock_group > 0 THEN
    RAISE NOTICE
      'Supplier company ownership repaired from historical evidence: audit=%, stock_group=%',
      repaired_from_audit,
      repaired_from_stock_group;
  END IF;
END
$$;

-- Production correction confirmed on 2026-08-10: supplier 28 (HMD BEIRUT)
-- belongs to company 17. The old NULL-company backfill stamped it onto the
-- configured parent instead, which made it disappear from company 17 and made
-- Journal posting fail with "Supplier 28 not found in company 17". Keep the
-- correction guarded by both ID and name so it cannot affect an unrelated row
-- in another database. Skip rather than violate the company/code uniqueness
-- rule if a local duplicate already exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM suppliers
     WHERE id = 28
       AND UPPER(TRIM(legal_name)) = 'HMD BEIRUT'
  )
  AND EXISTS (
    SELECT 1
      FROM companies
     WHERE id = 17
  )
  AND NOT EXISTS (
    SELECT 1
      FROM suppliers AS local_supplier
      JOIN suppliers AS source_supplier ON source_supplier.id = 28
     WHERE local_supplier.company_id = 17
       AND local_supplier.code = source_supplier.code
       AND local_supplier.id <> source_supplier.id
  ) THEN
    UPDATE suppliers
       SET company_id = 17
     WHERE id = 28
       AND UPPER(TRIM(legal_name)) = 'HMD BEIRUT'
       AND company_id IS DISTINCT FROM 17;
  END IF;
END
$$;

DO $$
DECLARE
  configured_parent_id INTEGER;
  fallback_parent_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM suppliers
     WHERE company_id IS NULL
  ) THEN
    SELECT CASE
             WHEN value ~ '^[1-9][0-9]*$' THEN value::INTEGER
             ELSE NULL
           END
      INTO configured_parent_id
      FROM system_settings
     WHERE key = 'parentCompanyId'
     LIMIT 1;

    IF configured_parent_id IS NULL THEN
      SELECT COUNT(*)::INTEGER
        INTO fallback_parent_count
        FROM companies
       WHERE active = TRUE
         AND company_type = 'erp'
         AND parent_company_id IS NULL;

      IF fallback_parent_count = 1 THEN
        SELECT id
          INTO configured_parent_id
          FROM companies
         WHERE active = TRUE
           AND company_type = 'erp'
           AND parent_company_id IS NULL
         LIMIT 1;
      ELSE
        RAISE EXCEPTION
          'Cannot backfill suppliers.company_id: configure system_settings.parentCompanyId first (found % eligible ERP parent companies)',
          fallback_parent_count;
      END IF;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = configured_parent_id) THEN
      RAISE EXCEPTION
        'Cannot backfill suppliers.company_id: configured parent company % does not exist',
        configured_parent_id;
    END IF;

    UPDATE suppliers
       SET company_id = configured_parent_id
     WHERE company_id IS NULL;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION assign_supplier_company_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_company_id INTEGER;
  fallback_parent_count INTEGER;
BEGIN
  IF NEW.company_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT CASE
           WHEN value ~ '^[1-9][0-9]*$' THEN value::INTEGER
           ELSE NULL
         END
    INTO resolved_company_id
    FROM system_settings
   WHERE key = 'parentCompanyId'
   LIMIT 1;

  IF resolved_company_id IS NULL THEN
    SELECT COUNT(*)::INTEGER
      INTO fallback_parent_count
      FROM companies
     WHERE active = TRUE
       AND company_type = 'erp'
       AND parent_company_id IS NULL;

    IF fallback_parent_count = 1 THEN
      SELECT id
        INTO resolved_company_id
        FROM companies
       WHERE active = TRUE
         AND company_type = 'erp'
         AND parent_company_id IS NULL
       LIMIT 1;
    ELSE
      RAISE EXCEPTION
        'Supplier company ownership is required; configure system_settings.parentCompanyId';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = resolved_company_id) THEN
    RAISE EXCEPTION 'Configured supplier parent company % does not exist', resolved_company_id;
  END IF;

  NEW.company_id := resolved_company_id;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS suppliers_assign_company_id ON suppliers;
CREATE TRIGGER suppliers_assign_company_id
BEFORE INSERT ON suppliers
FOR EACH ROW
EXECUTE FUNCTION assign_supplier_company_id();

ALTER TABLE suppliers
  ALTER COLUMN company_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'suppliers_company_id_fkey'
       AND conrelid = 'suppliers'::regclass
  ) THEN
    ALTER TABLE suppliers
      ADD CONSTRAINT suppliers_company_id_fkey
      FOREIGN KEY (company_id)
      REFERENCES companies(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

ALTER TABLE suppliers
  DROP CONSTRAINT IF EXISTS suppliers_code_unique;

CREATE INDEX IF NOT EXISTS suppliers_company_idx
  ON suppliers(company_id);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_company_code_unique
  ON suppliers(company_id, code);

ALTER TABLE factory_raw_stock
  DROP CONSTRAINT IF EXISTS factory_raw_stock_company_container_unique;

DROP INDEX IF EXISTS factory_raw_stock_company_container_unique;
CREATE UNIQUE INDEX factory_raw_stock_company_container_unique
  ON factory_raw_stock(company_id, container_id)
  WHERE deleted_at IS NULL;

ALTER TABLE factory_mix_batches
  ALTER COLUMN total_weight_kg SET DEFAULT 0,
  ALTER COLUMN total_cost SET DEFAULT 0,
  ALTER COLUMN cost_per_kg TYPE NUMERIC(20, 7)
    USING cost_per_kg::NUMERIC(20, 7);

COMMIT;
