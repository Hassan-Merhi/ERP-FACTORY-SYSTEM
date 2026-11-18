-- 0006_retire_retail_catalog_cost_snapshot_trigger.sql
--
-- REQUIRES OWNER SIGN-OFF (accounting behaviour). See the PR description.
--
-- Retire the legacy retail_pos_sale_items_snapshot_cost trigger (from the
-- archived migrations/archive/legacy/0019_retail_reporting_audit.sql). It
-- overwrites every retail sale line's unit_cost with the variant's *catalog*
-- cost (retail_product_variants.cost), discarding the moving-average cost that
-- the current retail accounting computes for value-exact stock and COGS
-- journals (Wave 17d). With the trigger, a sale-and-cancel cycle leaves stock
-- valued at catalog cost (e.g. 69.33 instead of 70.00) and the retail
-- sub-ledger drifts from RETAIL-INVENTORY in the general ledger.
--
-- The deployed databases have it; the repository's runtime code has never
-- installed or relied on it, and its tests assume it is absent. Production has
-- 1 retail sale line in total (read-only check, 2026-11-17).
--
-- Removes the trigger and its function only. No row is read or changed:
-- historical sale lines keep the unit_cost they were stored with.

DROP TRIGGER IF EXISTS retail_pos_sale_items_snapshot_cost ON public.retail_pos_sale_items;
DROP FUNCTION IF EXISTS public.retail_snapshot_sale_item_cost();
