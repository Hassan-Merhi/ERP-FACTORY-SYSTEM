/**
 * Historical Replay V7 data backfill (DML only).
 *
 * The V7 schema (factory_mix_batch_sources.inventory_supplier_id,
 * factory_raw_material_adjustments.valuation_basis, their foreign key / CHECK
 * constraints and indexes, and the factory_resolve_mix_source_inventory_supplier /
 * factory_default_new_adjustment_valuation_basis triggers) is defined by the
 * schema migrations (migrations/). This is the idempotent backfill that used to
 * run with that schema at startup: it sets the inventory owner of legacy mix
 * sources, quarantines mismatched owners and classifies zero-cost ADD
 * adjustments. No business cost values are changed and the historical replay
 * is never executed.
 */
export const FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL = `
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

-- Quarantine any legacy or previously-backfilled container source whose stored owner
-- does not match the container's supplier in the same company. The preview must show
-- and block these rows; migration code never guesses which historical link was intended.
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

UPDATE factory_raw_material_adjustments
SET valuation_basis = 'QUANTITY_ONLY'
WHERE UPPER(type) = 'ADD'
  AND COALESCE(cost_per_kg, 0) = 0
  AND valuation_basis IS NULL;
`;
