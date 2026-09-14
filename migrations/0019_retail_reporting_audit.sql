-- Retail Wave 3: stable COGS snapshots + reporting/audit indexes.

ALTER TABLE retail_pos_sale_items
  ADD COLUMN IF NOT EXISTS unit_cost numeric(20, 6) NOT NULL DEFAULT 0;

-- Existing Wave 2 rows predate sale-time cost snapshots. Use the variant cost as
-- the only available historical source so those rows remain reportable. New
-- rows are snapshotted by the trigger below and never move when variant cost is
-- edited later.
UPDATE retail_pos_sale_items AS sale_item
SET unit_cost = COALESCE(variant.cost, 0)
FROM retail_product_variants AS variant
WHERE sale_item.variant_id = variant.id
  AND sale_item.unit_cost = 0;

CREATE OR REPLACE FUNCTION retail_snapshot_sale_item_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_cost numeric(20, 6);
BEGIN
  SELECT cost
    INTO resolved_cost
  FROM retail_product_variants
  WHERE id = NEW.variant_id
    AND company_id = NEW.company_id;

  IF resolved_cost IS NULL THEN
    RAISE EXCEPTION 'Retail variant % does not belong to company %', NEW.variant_id, NEW.company_id;
  END IF;

  NEW.unit_cost := resolved_cost;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS retail_pos_sale_items_snapshot_cost ON retail_pos_sale_items;
CREATE TRIGGER retail_pos_sale_items_snapshot_cost
BEFORE INSERT ON retail_pos_sale_items
FOR EACH ROW
EXECUTE FUNCTION retail_snapshot_sale_item_cost();

CREATE INDEX IF NOT EXISTS retail_pos_sales_company_created_idx
  ON retail_pos_sales (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retail_pos_sales_company_location_created_idx
  ON retail_pos_sales (company_id, location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retail_pos_sale_items_company_variant_idx
  ON retail_pos_sale_items (company_id, variant_id);
CREATE INDEX IF NOT EXISTS retail_pos_returns_company_created_idx
  ON retail_pos_returns (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retail_pos_return_items_company_variant_idx
  ON retail_pos_return_items (company_id, variant_id);
CREATE INDEX IF NOT EXISTS retail_variant_inventory_company_location_variant_idx
  ON retail_variant_inventory (company_id, location_id, variant_id);
CREATE INDEX IF NOT EXISTS retail_stock_movements_company_variant_location_created_idx
  ON retail_stock_movements (company_id, variant_id, location_id, created_at, id);
CREATE INDEX IF NOT EXISTS retail_stock_movements_company_reference_idx
  ON retail_stock_movements (company_id, reference_type, reference_id);
