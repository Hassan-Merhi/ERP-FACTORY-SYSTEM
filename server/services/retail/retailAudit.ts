/** Retail stock-integrity and sale/return audit, unchanged read-only SQL. */
import { pool } from "../../db";

export interface RetailAuditIssue {
  code: string;
  severity: "error" | "warning";
  count: number;
  message: string;
  sample: unknown[];
}

export async function runRetailAudit(companyId: number): Promise<{
  ready: boolean;
  errors: number;
  warnings: number;
  issues: RetailAuditIssue[];
}> {
  const [
    duplicateBarcodes,
    negativeQuantities,
    orphanVariants,
    productsWithoutVariants,
    saleDeductions,
    returnRestoration,
    transferPairs,
    inventoryTotals,
    chainBreaks,
  ] = await Promise.all([
    pool.query(
      `SELECT barcode, COUNT(*)::int AS count
       FROM retail_product_variants
       WHERE company_id = $1
       GROUP BY barcode
       HAVING COUNT(*) > 1
       ORDER BY count DESC, barcode
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT i.id, i.variant_id, i.location_id, i.quantity
       FROM retail_variant_inventory i
       WHERE i.company_id = $1 AND i.quantity < 0
       ORDER BY i.quantity ASC
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT v.id AS variant_id, v.product_id, v.company_id, p.company_id AS product_company_id
       FROM retail_product_variants v
       LEFT JOIN retail_products p ON p.id = v.product_id
       WHERE v.company_id = $1
         AND (p.id IS NULL OR p.company_id <> v.company_id)
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT p.id AS product_id, p.code, p.name
       FROM retail_products p
       LEFT JOIN retail_product_variants v
         ON v.product_id = p.id
        AND v.company_id = p.company_id
        AND v.active = true
       WHERE p.company_id = $1 AND p.active = true
       GROUP BY p.id, p.code, p.name
       HAVING COUNT(v.id) = 0
       ORDER BY p.name
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT
         si.id AS sale_item_id,
         si.sale_id,
         si.variant_id,
         si.quantity AS sold_quantity,
         COUNT(m.id)::int AS movement_count,
         COALESCE(SUM(m.quantity_delta), 0) AS movement_delta
       FROM retail_pos_sale_items si
       LEFT JOIN retail_stock_movements m
         ON m.company_id = si.company_id
        AND m.movement_type = 'sale'
        AND NULLIF(m.metadata->>'saleItemId', '')::integer = si.id
       WHERE si.company_id = $1
       GROUP BY si.id, si.sale_id, si.variant_id, si.quantity
       HAVING COUNT(m.id) <> 1
          OR ABS(COALESCE(SUM(m.quantity_delta), 0) + si.quantity) > 0.000001
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT
         ri.id AS return_item_id,
         ri.return_id,
         ri.sale_item_id,
         ri.variant_id,
         ri.quantity AS returned_quantity,
         COUNT(m.id)::int AS movement_count,
         COALESCE(SUM(m.quantity_delta), 0) AS movement_delta
       FROM retail_pos_return_items ri
       LEFT JOIN retail_stock_movements m
         ON m.company_id = ri.company_id
        AND m.movement_type = 'return'
        AND m.reference_type = 'retail_pos_return'
        AND m.reference_id = ri.return_id::text
        AND NULLIF(m.metadata->>'saleItemId', '')::integer = ri.sale_item_id
       WHERE ri.company_id = $1
       GROUP BY ri.id, ri.return_id, ri.sale_item_id, ri.variant_id, ri.quantity
       HAVING COUNT(m.id) <> 1
          OR ABS(COALESCE(SUM(m.quantity_delta), 0) - CASE WHEN ri.restocked THEN ri.quantity ELSE 0 END) > 0.000001
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `SELECT
         reference_id,
         COUNT(*)::int AS movement_count,
         COUNT(DISTINCT location_id)::int AS location_count,
         COALESCE(SUM(quantity_delta), 0) AS net_delta,
         COALESCE(SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END), 0) AS source_quantity,
         COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0) AS destination_quantity
       FROM retail_stock_movements
       WHERE company_id = $1 AND reference_type = 'retail_transfer'
       GROUP BY reference_id
       HAVING COUNT(*) <> 2
          OR COUNT(DISTINCT location_id) <> 2
          OR ABS(COALESCE(SUM(quantity_delta), 0)) > 0.000001
          OR ABS(
            COALESCE(SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0)
          ) > 0.000001
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (variant_id, location_id)
           variant_id, location_id, quantity_after, id
         FROM retail_stock_movements
         WHERE company_id = $1
         ORDER BY variant_id, location_id, created_at DESC, id DESC
       )
       SELECT i.id AS inventory_id, i.variant_id, i.location_id, i.quantity, latest.quantity_after
       FROM retail_variant_inventory i
       JOIN latest
         ON latest.variant_id = i.variant_id
        AND latest.location_id = i.location_id
       WHERE i.company_id = $1
         AND ABS(i.quantity - latest.quantity_after) > 0.000001
       ORDER BY i.id
       LIMIT 25`,
      [companyId]
    ),
    pool.query(
      `WITH ordered AS (
         SELECT
           id,
           variant_id,
           location_id,
           quantity_before,
           quantity_after,
           quantity_delta,
           LAG(quantity_after) OVER (
             PARTITION BY variant_id, location_id
             ORDER BY created_at, id
           ) AS prior_after
         FROM retail_stock_movements
         WHERE company_id = $1
       )
       SELECT id, variant_id, location_id, prior_after, quantity_before, quantity_after, quantity_delta
       FROM ordered
       WHERE ABS(quantity_after - (quantity_before + quantity_delta)) > 0.000001
          OR (prior_after IS NOT NULL AND ABS(quantity_before - prior_after) > 0.000001)
       ORDER BY id
       LIMIT 25`,
      [companyId]
    ),
  ]);

  const issues: RetailAuditIssue[] = [];
  const add = (code: string, severity: "error" | "warning", rows: unknown[], message: string) => {
    if (!rows.length) return;
    issues.push({ code, severity, count: rows.length, message, sample: rows });
  };

  add("duplicate_barcodes", "error", duplicateBarcodes.rows, "Duplicate barcodes exist inside the retail company.");
  add(
    "negative_quantities",
    "warning",
    negativeQuantities.rows,
    "Negative retail quantities exist and require review."
  );
  add("orphan_variants", "error", orphanVariants.rows, "Variants are orphaned or point across company boundaries.");
  add(
    "products_without_valid_variants",
    "warning",
    productsWithoutVariants.rows,
    "Active products exist without an active valid variant."
  );
  add(
    "duplicate_pos_deductions",
    "error",
    saleDeductions.rows,
    "POS sale items do not reconcile one-to-one to their stock deduction."
  );
  add(
    "return_stock_restoration",
    "error",
    returnRestoration.rows,
    "Retail returns do not reconcile to exact stock restoration movements."
  );
  add(
    "transfer_conservation",
    "error",
    transferPairs.rows,
    "Retail transfers do not conserve quantity between source and destination."
  );
  add(
    "incorrect_inventory_totals",
    "error",
    inventoryTotals.rows,
    "Current inventory does not match the latest movement quantity."
  );
  add(
    "movement_chain_break",
    "error",
    chainBreaks.rows,
    "Movement history contains arithmetic or before/after continuity breaks."
  );

  const errors = issues.filter((issue) => issue.severity === "error").reduce((sum, issue) => sum + issue.count, 0);
  const warnings = issues.filter((issue) => issue.severity === "warning").reduce((sum, issue) => sum + issue.count, 0);

  return { ready: errors === 0, errors, warnings, issues };
}
