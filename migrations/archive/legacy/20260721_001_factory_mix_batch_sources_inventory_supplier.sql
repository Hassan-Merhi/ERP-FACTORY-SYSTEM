-- V7 Historical Replay: explicit inventory ownership and adjustment valuation basis.
-- Schema only. This migration never executes a historical replay or changes cost values.

BEGIN;

ALTER TABLE factory_mix_batch_sources
  ADD COLUMN IF NOT EXISTS inventory_supplier_id INTEGER;

ALTER TABLE factory_raw_material_adjustments
  ADD COLUMN IF NOT EXISTS valuation_basis VARCHAR(30);

-- Backfill inventory ownership without changing pricing ownership. Company matching is
-- mandatory: suspicious cross-company legacy links remain NULL and block the protected preview.
-- BATCH sources intentionally remain NULL because the upstream batch already consumed raw material.
UPDATE factory_mix_batch_sources AS mbs
SET inventory_supplier_id = mbs.supplier_id
FROM factory_mix_batches AS mb,
     factory_suppliers AS fs
WHERE mbs.mix_batch_id = mb.id
  AND mbs.supplier_id = fs.id
  AND fs.company_id = mb.company_id
  AND mbs.source_batch_id IS NULL
  AND mbs.supplier_id IS NOT NULL
  AND mbs.inventory_supplier_id IS NULL;

UPDATE factory_mix_batch_sources AS mbs
SET inventory_supplier_id = fc.supplier_id
FROM factory_containers AS fc,
     factory_mix_batches AS mb,
     factory_suppliers AS fs
WHERE mbs.mix_batch_id = mb.id
  AND mbs.source_batch_id IS NULL
  AND mbs.supplier_id IS NULL
  AND mbs.container_id = fc.id
  AND fc.company_id = mb.company_id
  AND fc.supplier_id = fs.id
  AND fs.company_id = mb.company_id
  AND fc.supplier_id IS NOT NULL
  AND fc.deleted_at IS NULL
  AND mbs.inventory_supplier_id IS NULL;

-- Quarantine previously-backfilled container rows whose owner does not match the
-- container supplier in the same company. These remain unresolved until reviewed.
UPDATE factory_mix_batch_sources AS mbs
SET inventory_supplier_id = NULL
FROM factory_mix_batches AS mb
WHERE mbs.mix_batch_id = mb.id
  AND mbs.source_batch_id IS NULL
  AND mbs.container_id IS NOT NULL
  AND mbs.inventory_supplier_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM factory_containers AS fc
    WHERE fc.id = mbs.container_id
      AND fc.company_id = mb.company_id
      AND fc.deleted_at IS NULL
      AND fc.supplier_id = mbs.inventory_supplier_id
  );

UPDATE factory_mix_batch_sources
SET inventory_supplier_id = NULL
WHERE source_batch_id IS NOT NULL
  AND inventory_supplier_id IS NOT NULL;

-- Cost-free historical ADD rows are unambiguously quantity-only. Positive-cost historical
-- rows remain NULL and must be explicitly classified in the protected replay workflow.
UPDATE factory_raw_material_adjustments
SET valuation_basis = 'QUANTITY_ONLY'
WHERE UPPER(type) = 'ADD'
  AND COALESCE(cost_per_kg, 0) = 0
  AND valuation_basis IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN LATERAL unnest(c.conkey) AS key(attnum) ON TRUE
    JOIN pg_attribute a
      ON a.attrelid = rel.oid
     AND a.attnum = key.attnum
    WHERE c.contype = 'f'
      AND c.confrelid = 'factory_suppliers'::regclass
      AND nsp.nspname = current_schema()
      AND rel.relname = 'factory_mix_batch_sources'
      AND a.attname = 'inventory_supplier_id'
  ) THEN
    ALTER TABLE factory_mix_batch_sources
      ADD CONSTRAINT factory_mix_batch_sources_inventory_supplier_fk
      FOREIGN KEY (inventory_supplier_id)
      REFERENCES factory_suppliers(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'factory_raw_material_adjustments_valuation_basis_chk'
      AND conrelid = 'factory_raw_material_adjustments'::regclass
  ) THEN
    ALTER TABLE factory_raw_material_adjustments
      ADD CONSTRAINT factory_raw_material_adjustments_valuation_basis_chk
      CHECK (
        valuation_basis IS NULL OR valuation_basis IN (
          'QUANTITY_ONLY', 'VALUED_TRANSFER', 'OPENING_BALANCE'
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS factory_mix_batch_sources_inventory_supplier_idx
  ON factory_mix_batch_sources (inventory_supplier_id, mix_batch_id);

CREATE INDEX IF NOT EXISTS factory_raw_material_adjustments_unclassified_valuation_idx
  ON factory_raw_material_adjustments (company_id, supplier_id, id)
  WHERE deleted_at IS NULL
    AND UPPER(type) = 'ADD'
    AND COALESCE(cost_per_kg, 0) > 0
    AND valuation_basis IS NULL;

CREATE OR REPLACE FUNCTION factory_resolve_mix_source_inventory_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_supplier_id INTEGER;
  source_company_id INTEGER;
  container_supplier_id INTEGER;
BEGIN
  SELECT company_id
    INTO source_company_id
    FROM factory_mix_batches
   WHERE id = NEW.mix_batch_id
     AND deleted_at IS NULL;

  IF source_company_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'MIX_BATCH_COMPANY_UNRESOLVED: source batch is missing or deleted';
  END IF;

  IF NEW.source_batch_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM factory_mix_batches upstream
      WHERE upstream.id = NEW.source_batch_id
        AND upstream.company_id = source_company_id
        AND upstream.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'UPSTREAM_BATCH_COMPANY_MISMATCH: source batch belongs to another company or is missing';
    END IF;
    NEW.inventory_supplier_id := NULL;
    RETURN NEW;
  END IF;

  resolved_supplier_id := NEW.inventory_supplier_id;

  IF resolved_supplier_id IS NULL AND NEW.supplier_id IS NOT NULL THEN
    resolved_supplier_id := NEW.supplier_id;
  END IF;

  IF NEW.container_id IS NOT NULL THEN
    SELECT supplier_id
      INTO container_supplier_id
      FROM factory_containers
     WHERE id = NEW.container_id
       AND company_id = source_company_id
       AND deleted_at IS NULL;

    IF container_supplier_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'CONTAINER_INVENTORY_SUPPLIER_UNRESOLVED: source container is missing, belongs to another company, or has no supplier';
    END IF;

    IF resolved_supplier_id IS NULL THEN
      resolved_supplier_id := container_supplier_id;
    ELSIF resolved_supplier_id <> container_supplier_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'CONTAINER_INVENTORY_SUPPLIER_CONFLICT: source owner does not match the container supplier';
    END IF;
  END IF;

  IF resolved_supplier_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVENTORY_SUPPLIER_UNRESOLVED: non-batch raw-material source has no supplier owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM factory_suppliers
    WHERE id = resolved_supplier_id
      AND company_id = source_company_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVENTORY_SUPPLIER_COMPANY_MISMATCH: supplier owner belongs to another company';
  END IF;

  IF NEW.supplier_id IS NOT NULL AND NEW.supplier_id <> resolved_supplier_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVENTORY_SUPPLIER_CONFLICT: pricing supplier and inventory owner disagree';
  END IF;

  NEW.inventory_supplier_id := resolved_supplier_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_mix_source_inventory_supplier_trg
  ON factory_mix_batch_sources;

CREATE TRIGGER factory_mix_source_inventory_supplier_trg
BEFORE INSERT OR UPDATE OF mix_batch_id, supplier_id, container_id, source_batch_id, inventory_supplier_id
ON factory_mix_batch_sources
FOR EACH ROW
EXECUTE FUNCTION factory_resolve_mix_source_inventory_supplier();

CREATE OR REPLACE FUNCTION factory_default_new_adjustment_valuation_basis()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND UPPER(NEW.type) = 'ADD'
     AND NEW.supplier_id IS NOT NULL
     AND NEW.valuation_basis IS NULL THEN
    NEW.valuation_basis := 'QUANTITY_ONLY';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_adjustment_valuation_basis_trg
  ON factory_raw_material_adjustments;

CREATE TRIGGER factory_adjustment_valuation_basis_trg
BEFORE INSERT OR UPDATE OF type, supplier_id, valuation_basis
ON factory_raw_material_adjustments
FOR EACH ROW
EXECUTE FUNCTION factory_default_new_adjustment_valuation_basis();

COMMIT;
