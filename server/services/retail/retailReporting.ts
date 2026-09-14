import { pool } from "../../db";

export interface RetailReportFilters {
  companyId: number;
  from: Date;
  to: Date;
  locationId?: number;
  slowMovingDays?: number;
  limit?: number;
}

export interface RetailAuditIssue {
  code: string;
  severity: "error" | "warning";
  count: number;
  message: string;
  sample: unknown[];
}

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const mapNumericFields = <T extends Record<string, unknown>>(row: T, fields: string[]): T => {
  const next = { ...row };
  for (const field of fields) {
    (next as Record<string, unknown>)[field] = numberValue(row[field]);
  }
  return next;
};

function locationPredicate(alias: string, locationId?: number): { text: string; params: unknown[] } {
  if (!locationId) return { text: "", params: [] };
  return { text: ` AND ${alias}.location_id = $4`, params: [locationId] };
}

export async function getRetailDashboard(filters: RetailReportFilters) {
  const slowMovingDays = Math.min(Math.max(filters.slowMovingDays ?? 60, 1), 3650);
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);
  const financialLocation = locationPredicate("m", filters.locationId);
  const inventoryLocation = filters.locationId ? " AND i.location_id = $2" : "";
  const inventoryParams: unknown[] = filters.locationId
    ? [filters.companyId, filters.locationId]
    : [filters.companyId];
  const financialParams: unknown[] = [filters.companyId, filters.from, filters.to, ...financialLocation.params];

  const [inventorySummaryResult, financialSummaryResult, rankingsResult, lowStockResult, outOfStockResult, slowMovingResult] =
    await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(i.quantity), 0) AS inventory_quantity,
           COALESCE(SUM(i.quantity * i.average_cost), 0) AS inventory_value,
           COUNT(DISTINCT p.id) AS product_count,
           COUNT(DISTINCT v.id) AS variant_count
         FROM retail_variant_inventory i
         JOIN retail_product_variants v
           ON v.id = i.variant_id AND v.company_id = i.company_id
         JOIN retail_products p
           ON p.id = v.product_id AND p.company_id = v.company_id
         WHERE i.company_id = $1${inventoryLocation}`,
        inventoryParams
      ),
      pool.query(
        `WITH financial_moves AS (
           SELECT
             m.id,
             m.location_id,
             m.variant_id,
             m.movement_type,
             (-m.quantity_delta) AS net_quantity,
             (-m.quantity_delta) * si.unit_price AS revenue,
             (-m.quantity_delta) * si.unit_cost AS cogs
           FROM retail_stock_movements m
           JOIN retail_pos_sale_items si
             ON si.company_id = m.company_id
            AND si.id = NULLIF(m.metadata->>'saleItemId', '')::integer
           WHERE m.company_id = $1
             AND m.created_at >= $2
             AND m.created_at < $3
             AND m.movement_type IN ('sale', 'return', 'cancellation')${financialLocation.text}
         )
         SELECT
           COALESCE(SUM(revenue), 0) AS revenue,
           COALESCE(SUM(cogs), 0) AS cogs,
           COALESCE(SUM(revenue - cogs), 0) AS gross_profit,
           COALESCE(SUM(net_quantity), 0) AS units_sold,
           COUNT(DISTINCT id) FILTER (WHERE movement_type = 'sale') AS sale_lines
         FROM financial_moves`,
        financialParams
      ),
      pool.query(
        `WITH financial_moves AS (
           SELECT
             m.location_id,
             m.variant_id,
             (-m.quantity_delta) AS net_quantity,
             (-m.quantity_delta) * si.unit_price AS revenue,
             (-m.quantity_delta) * si.unit_cost AS cogs
           FROM retail_stock_movements m
           JOIN retail_pos_sale_items si
             ON si.company_id = m.company_id
            AND si.id = NULLIF(m.metadata->>'saleItemId', '')::integer
           WHERE m.company_id = $1
             AND m.created_at >= $2
             AND m.created_at < $3
             AND m.movement_type IN ('sale', 'return', 'cancellation')${financialLocation.text}
         ), enriched AS (
           SELECT
             fm.*,
             p.id AS product_id,
             p.name AS product_name,
             p.code AS product_code,
             v.size,
             COALESCE(b.name, 'Other / No Brand') AS brand_name,
             l.name AS location_name
           FROM financial_moves fm
           JOIN retail_product_variants v ON v.id = fm.variant_id
           JOIN retail_products p ON p.id = v.product_id
           LEFT JOIN retail_brands b ON b.id = p.brand_id
           JOIN locations l ON l.id = fm.location_id
         ), product_rank AS (
           SELECT product_id, product_name, product_code,
                  SUM(net_quantity) AS quantity,
                  SUM(revenue) AS revenue,
                  SUM(cogs) AS cogs,
                  SUM(revenue - cogs) AS profit
           FROM enriched GROUP BY product_id, product_name, product_code
           ORDER BY quantity DESC, revenue DESC LIMIT ${limit}
         ), brand_rank AS (
           SELECT brand_name AS name,
                  SUM(net_quantity) AS quantity,
                  SUM(revenue) AS revenue,
                  SUM(cogs) AS cogs,
                  SUM(revenue - cogs) AS profit
           FROM enriched GROUP BY brand_name
           ORDER BY quantity DESC, revenue DESC LIMIT ${limit}
         ), size_rank AS (
           SELECT size AS name,
                  SUM(net_quantity) AS quantity,
                  SUM(revenue) AS revenue
           FROM enriched GROUP BY size
           ORDER BY quantity DESC, revenue DESC LIMIT ${limit}
         ), location_rank AS (
           SELECT location_id, location_name AS name,
                  SUM(net_quantity) AS quantity,
                  SUM(revenue) AS revenue,
                  SUM(revenue - cogs) AS profit
           FROM enriched GROUP BY location_id, location_name
           ORDER BY revenue DESC LIMIT ${limit}
         )
         SELECT jsonb_build_object(
           'products', COALESCE((SELECT jsonb_agg(to_jsonb(product_rank)) FROM product_rank), '[]'::jsonb),
           'brands', COALESCE((SELECT jsonb_agg(to_jsonb(brand_rank)) FROM brand_rank), '[]'::jsonb),
           'sizes', COALESCE((SELECT jsonb_agg(to_jsonb(size_rank)) FROM size_rank), '[]'::jsonb),
           'locations', COALESCE((SELECT jsonb_agg(to_jsonb(location_rank)) FROM location_rank), '[]'::jsonb)
         ) AS rankings`,
        financialParams
      ),
      pool.query(
        `SELECT
           p.id AS product_id,
           p.code,
           p.name,
           COALESCE(b.name, 'Other / No Brand') AS brand,
           v.id AS variant_id,
           v.size,
           v.barcode,
           l.id AS location_id,
           l.name AS location_name,
           i.quantity,
           v.low_stock_threshold AS threshold
         FROM retail_variant_inventory i
         JOIN retail_product_variants v ON v.id = i.variant_id AND v.company_id = i.company_id
         JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
         LEFT JOIN retail_brands b ON b.id = p.brand_id
         JOIN locations l ON l.id = i.location_id
         WHERE i.company_id = $1
           AND i.quantity > 0
           AND i.quantity <= v.low_stock_threshold${inventoryLocation}
         ORDER BY (v.low_stock_threshold - i.quantity) DESC, p.name, v.size
         LIMIT ${limit}`,
        inventoryParams
      ),
      pool.query(
        `SELECT
           p.id AS product_id,
           p.code,
           p.name,
           COALESCE(b.name, 'Other / No Brand') AS brand,
           v.id AS variant_id,
           v.size,
           v.barcode,
           COALESCE(SUM(i.quantity), 0) AS quantity
         FROM retail_product_variants v
         JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
         LEFT JOIN retail_brands b ON b.id = p.brand_id
         LEFT JOIN retail_variant_inventory i
           ON i.variant_id = v.id
          AND i.company_id = v.company_id${filters.locationId ? " AND i.location_id = $2" : ""}
         WHERE v.company_id = $1
           AND v.active = true
           AND p.active = true
         GROUP BY p.id, p.code, p.name, b.name, v.id, v.size, v.barcode
         HAVING COALESCE(SUM(i.quantity), 0) <= 0
         ORDER BY p.name, v.size
         LIMIT ${limit}`,
        inventoryParams
      ),
      pool.query(
        `SELECT
           p.id AS product_id,
           p.code,
           p.name,
           COALESCE(b.name, 'Other / No Brand') AS brand,
           v.id AS variant_id,
           v.size,
           v.barcode,
           COALESCE(SUM(i.quantity), 0) AS quantity,
           MAX(m.created_at) FILTER (WHERE m.movement_type = 'sale') AS last_sale_at
         FROM retail_product_variants v
         JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
         LEFT JOIN retail_brands b ON b.id = p.brand_id
         LEFT JOIN retail_variant_inventory i
           ON i.variant_id = v.id
          AND i.company_id = v.company_id${filters.locationId ? " AND i.location_id = $2" : ""}
         LEFT JOIN retail_stock_movements m
           ON m.company_id = v.company_id
          AND m.variant_id = v.id
          AND m.movement_type = 'sale'${filters.locationId ? " AND m.location_id = $2" : ""}
         WHERE v.company_id = $1
           AND v.active = true
           AND p.active = true
         GROUP BY p.id, p.code, p.name, b.name, v.id, v.size, v.barcode
         HAVING COALESCE(SUM(i.quantity), 0) > 0
            AND (MAX(m.created_at) FILTER (WHERE m.movement_type = 'sale') IS NULL
                 OR MAX(m.created_at) FILTER (WHERE m.movement_type = 'sale') < NOW() - ($${filters.locationId ? 3 : 2}::text || ' days')::interval)
         ORDER BY last_sale_at NULLS FIRST, quantity DESC
         LIMIT ${limit}`,
        filters.locationId ? [filters.companyId, filters.locationId, slowMovingDays] : [filters.companyId, slowMovingDays]
      ),
    ]);

  const inventorySummary = mapNumericFields(inventorySummaryResult.rows[0] ?? {}, [
    "inventory_quantity",
    "inventory_value",
    "product_count",
    "variant_count",
  ]);
  const financialSummary = mapNumericFields(financialSummaryResult.rows[0] ?? {}, [
    "revenue",
    "cogs",
    "gross_profit",
    "units_sold",
    "sale_lines",
  ]);
  const rankings = (rankingsResult.rows[0]?.rankings ?? { products: [], brands: [], sizes: [], locations: [] }) as Record<
    string,
    Array<Record<string, unknown>>
  >;

  for (const group of ["products", "brands", "sizes", "locations"]) {
    rankings[group] = (rankings[group] ?? []).map((row) =>
      mapNumericFields(row, ["product_id", "location_id", "quantity", "revenue", "cogs", "profit"])
    );
  }

  return {
    period: { from: filters.from.toISOString(), to: filters.to.toISOString(), locationId: filters.locationId ?? null },
    summary: { ...inventorySummary, ...financialSummary },
    bestSellingProducts: rankings.products,
    bestSellingBrands: rankings.brands,
    bestSellingSizes: rankings.sizes,
    salesByLocation: rankings.locations,
    lowStock: lowStockResult.rows.map((row) => mapNumericFields(row, ["product_id", "variant_id", "location_id", "quantity", "threshold"])),
    outOfStock: outOfStockResult.rows.map((row) => mapNumericFields(row, ["product_id", "variant_id", "quantity"])),
    slowMoving: slowMovingResult.rows.map((row) => mapNumericFields(row, ["product_id", "variant_id", "quantity"])),
    profitByProduct: rankings.products,
    profitByBrand: rankings.brands,
  };
}

export async function runRetailAudit(companyId: number): Promise<{
  ready: boolean;
  errors: number;
  warnings: number;
  issues: RetailAuditIssue[];
}> {
  const [duplicateBarcodes, negativeQuantities, orphanVariants, productsWithoutVariants, saleDeductions, returnRestoration, transferPairs, inventoryTotals, chainBreaks] =
    await Promise.all([
      pool.query(
        `SELECT barcode, COUNT(*)::int AS count
         FROM retail_product_variants
         WHERE company_id = $1
         GROUP BY barcode HAVING COUNT(*) > 1
         ORDER BY count DESC, barcode LIMIT 25`,
        [companyId]
      ),
      pool.query(
        `SELECT i.id, i.variant_id, i.location_id, i.quantity
         FROM retail_variant_inventory i
         WHERE i.company_id = $1 AND i.quantity < 0
         ORDER BY i.quantity ASC LIMIT 25`,
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
           ON v.product_id = p.id AND v.company_id = p.company_id AND v.active = true
         WHERE p.company_id = $1 AND p.active = true
         GROUP BY p.id, p.code, p.name
         HAVING COUNT(v.id) = 0
         ORDER BY p.name LIMIT 25`,
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
         HAVING COUNT(m.id) <> 1 OR ABS(COALESCE(SUM(m.quantity_delta), 0) + si.quantity) > 0.000001
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
         HAVING COUNT(m.id) <> 1 OR ABS(COALESCE(SUM(m.quantity_delta), 0) - ri.quantity) > 0.000001
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
            OR ABS(COALESCE(SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END), 0)
                 - COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0)) > 0.000001
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
         JOIN latest ON latest.variant_id = i.variant_id AND latest.location_id = i.location_id
         WHERE i.company_id = $1
           AND ABS(i.quantity - latest.quantity_after) > 0.000001
         ORDER BY i.id LIMIT 25`,
        [companyId]
      ),
      pool.query(
        `WITH ordered AS (
           SELECT
             id, variant_id, location_id, quantity_before, quantity_after, quantity_delta,
             LAG(quantity_after) OVER (PARTITION BY variant_id, location_id ORDER BY created_at, id) AS prior_after
           FROM retail_stock_movements
           WHERE company_id = $1
         )
         SELECT id, variant_id, location_id, prior_after, quantity_before, quantity_after, quantity_delta
         FROM ordered
         WHERE ABS(quantity_after - (quantity_before + quantity_delta)) > 0.000001
            OR (prior_after IS NOT NULL AND ABS(quantity_before - prior_after) > 0.000001)
         ORDER BY id LIMIT 25`,
        [companyId]
      ),
    ]);

  const issues: RetailAuditIssue[] = [];
  const add = (code: string, severity: "error" | "warning", rows: unknown[], message: string) => {
    if (!rows.length) return;
    issues.push({ code, severity, count: rows.length, message, sample: rows });
  };

  add("duplicate_barcodes", "error", duplicateBarcodes.rows, "Duplicate barcodes exist inside the retail company.");
  add("negative_quantities", "warning", negativeQuantities.rows, "Negative retail quantities exist and require review.");
  add("orphan_variants", "error", orphanVariants.rows, "Variants are orphaned or point across company boundaries.");
  add("products_without_valid_variants", "warning", productsWithoutVariants.rows, "Active products exist without an active valid variant.");
  add("duplicate_pos_deductions", "error", saleDeductions.rows, "POS sale items do not reconcile one-to-one to their stock deduction.");
  add("return_stock_restoration", "error", returnRestoration.rows, "Retail returns do not reconcile to exact stock restoration movements.");
  add("transfer_conservation", "error", transferPairs.rows, "Retail transfers do not conserve quantity between source and destination.");
  add("incorrect_inventory_totals", "error", inventoryTotals.rows, "Current inventory does not match the latest movement quantity.");
  add("movement_chain_break", "error", chainBreaks.rows, "Movement history contains arithmetic or before/after continuity breaks.");

  const errors = issues.filter((issue) => issue.severity === "error").reduce((sum, issue) => sum + issue.count, 0);
  const warnings = issues.filter((issue) => issue.severity === "warning").reduce((sum, issue) => sum + issue.count, 0);
  return { ready: errors === 0, errors, warnings, issues };
}
