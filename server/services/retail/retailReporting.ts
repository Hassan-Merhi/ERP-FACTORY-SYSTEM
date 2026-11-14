import { pool } from "../../db";

export interface RetailReportFilters {
  companyId: number;
  from: Date;
  to: Date;
  locationId?: number;
  slowMovingDays?: number;
  limit?: number;
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

// Damaged refunds reverse revenue and tax but do not restore sellable stock
// or reverse the COGS of goods written off. A zero-delta audit movement records
// the return, and its returnedQuantity metadata supplies the financial quantity.
const effectiveMovementQuantitySql = `CASE
  WHEN m.movement_type = 'return'
   AND COALESCE((m.metadata->>'restocked')::boolean, true) = false
    THEN -COALESCE((m.metadata->>'returnedQuantity')::numeric, 0)
  ELSE -m.quantity_delta
END`;

function financialLocationPredicate(locationId?: number): string {
  return locationId ? " AND m.location_id = $4" : "";
}

function inventoryLocationPredicate(locationId?: number): string {
  return locationId ? " AND i.location_id = $2" : "";
}

export async function getRetailDashboard(filters: RetailReportFilters) {
  const slowMovingDays = Math.min(Math.max(filters.slowMovingDays ?? 60, 1), 3650);
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);
  const financialLocation = financialLocationPredicate(filters.locationId);
  const inventoryLocation = inventoryLocationPredicate(filters.locationId);
  const inventoryParams: unknown[] = filters.locationId ? [filters.companyId, filters.locationId] : [filters.companyId];
  const financialParams: unknown[] = filters.locationId
    ? [filters.companyId, filters.from, filters.to, filters.locationId]
    : [filters.companyId, filters.from, filters.to];
  const slowMovingParams: unknown[] = filters.locationId
    ? [filters.companyId, filters.locationId, slowMovingDays]
    : [filters.companyId, slowMovingDays];
  const slowMovingDaysParam = filters.locationId ? 3 : 2;

  const [
    inventorySummaryResult,
    financialSummaryResult,
    rankingsResult,
    lowStockResult,
    outOfStockResult,
    slowMovingResult,
  ] = await Promise.all([
    pool.query(
      `WITH catalog AS (
         SELECT
           COUNT(DISTINCT p.id)::int AS product_count,
           COUNT(DISTINCT v.id)::int AS variant_count
         FROM retail_products p
         LEFT JOIN retail_product_variants v
           ON v.product_id = p.id
          AND v.company_id = p.company_id
          AND v.active = true
         WHERE p.company_id = $1
           AND p.active = true
       ), stock AS (
         SELECT
           COALESCE(SUM(i.quantity), 0) AS inventory_quantity,
           COALESCE(SUM(i.quantity * i.average_cost), 0) AS inventory_value
         FROM retail_variant_inventory i
         WHERE i.company_id = $1${inventoryLocation}
       ), low_stock AS (
         SELECT COUNT(*)::int AS low_stock_count
         FROM retail_variant_inventory i
         JOIN retail_product_variants v
           ON v.id = i.variant_id AND v.company_id = i.company_id
         JOIN retail_products p
           ON p.id = v.product_id AND p.company_id = v.company_id
         WHERE i.company_id = $1
           AND v.active = true
           AND p.active = true
           AND i.quantity > 0
           AND i.quantity <= v.low_stock_threshold${inventoryLocation}
       ), out_stock AS (
         SELECT COUNT(*)::int AS out_of_stock_count
         FROM (
           SELECT v.id
           FROM retail_product_variants v
           JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
           LEFT JOIN retail_variant_inventory i
             ON i.variant_id = v.id
            AND i.company_id = v.company_id${filters.locationId ? " AND i.location_id = $2" : ""}
           WHERE v.company_id = $1
             AND v.active = true
             AND p.active = true
           GROUP BY v.id
           HAVING COALESCE(SUM(i.quantity), 0) <= 0
         ) rows
       )
       SELECT catalog.*, stock.*, low_stock.*, out_stock.*
       FROM catalog CROSS JOIN stock CROSS JOIN low_stock CROSS JOIN out_stock`,
      inventoryParams
    ),
    pool.query(
      `WITH financial_moves AS (
         SELECT
           m.id,
           m.movement_type,
           s.customer_id,
           ${effectiveMovementQuantitySql} AS net_quantity,
           ${effectiveMovementQuantitySql} * si.unit_price AS revenue,
           CASE WHEN m.movement_type = 'return'
                  AND COALESCE((m.metadata->>'restocked')::boolean, true) = false
              THEN 0 ELSE ${effectiveMovementQuantitySql} * si.unit_cost END AS cogs,
           CASE WHEN si.quantity <> 0 THEN ${effectiveMovementQuantitySql} / si.quantity ELSE 0 END * si.tax_amount AS tax_amount,
           CASE WHEN si.quantity <> 0 THEN ${effectiveMovementQuantitySql} / si.quantity ELSE 0 END * si.line_discount_amount AS discount_amount
         FROM retail_stock_movements m
         JOIN retail_pos_sale_items si
           ON si.company_id = m.company_id
          AND si.id = NULLIF(m.metadata->>'saleItemId', '')::integer
         JOIN retail_pos_sales s
           ON s.company_id = si.company_id
          AND s.id = si.sale_id
         WHERE m.company_id = $1
           AND m.created_at >= $2
           AND m.created_at < $3
           AND m.movement_type IN ('sale', 'return', 'cancellation')${financialLocation}
       )
       SELECT
         COALESCE(SUM(revenue), 0) AS revenue,
         COALESCE(SUM(cogs), 0) AS cogs,
         COALESCE(SUM(revenue - cogs), 0) AS gross_profit,
         COALESCE(SUM(net_quantity), 0) AS units_sold,
         COALESCE(SUM(tax_amount), 0) AS tax_collected,
         COALESCE(SUM(discount_amount), 0) AS discount_given,
         COUNT(DISTINCT customer_id)::int AS customer_count,
         COUNT(*) FILTER (WHERE movement_type = 'sale')::int AS sale_lines
       FROM financial_moves`,
      financialParams
    ),
    pool.query(
      `WITH financial_moves AS (
         SELECT
           m.location_id,
           m.variant_id,
           ${effectiveMovementQuantitySql} AS net_quantity,
           ${effectiveMovementQuantitySql} * si.unit_price AS revenue,
           CASE WHEN m.movement_type = 'return'
                  AND COALESCE((m.metadata->>'restocked')::boolean, true) = false
              THEN 0 ELSE ${effectiveMovementQuantitySql} * si.unit_cost END AS cogs
         FROM retail_stock_movements m
         JOIN retail_pos_sale_items si
           ON si.company_id = m.company_id
          AND si.id = NULLIF(m.metadata->>'saleItemId', '')::integer
         WHERE m.company_id = $1
           AND m.created_at >= $2
           AND m.created_at < $3
           AND m.movement_type IN ('sale', 'return', 'cancellation')${financialLocation}
       ), enriched AS (
         SELECT
           fm.*,
           p.id AS product_id,
           p.name AS product_name,
           p.code AS product_code,
           v.color,
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
         FROM enriched
         GROUP BY product_id, product_name, product_code
         ORDER BY quantity DESC, revenue DESC
         LIMIT ${limit}
       ), brand_rank AS (
         SELECT brand_name AS name,
                SUM(net_quantity) AS quantity,
                SUM(revenue) AS revenue,
                SUM(cogs) AS cogs,
                SUM(revenue - cogs) AS profit
         FROM enriched
         GROUP BY brand_name
         ORDER BY quantity DESC, revenue DESC
         LIMIT ${limit}
       ), size_rank AS (
         SELECT size AS name,
                SUM(net_quantity) AS quantity,
                SUM(revenue) AS revenue
         FROM enriched
         GROUP BY size
         ORDER BY quantity DESC, revenue DESC
         LIMIT ${limit}
       ), location_rank AS (
         SELECT location_id, location_name AS name,
                SUM(net_quantity) AS quantity,
                SUM(revenue) AS revenue,
                SUM(revenue - cogs) AS profit
         FROM enriched
         GROUP BY location_id, location_name
         ORDER BY revenue DESC
         LIMIT ${limit}
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
         v.color,
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
         AND v.active = true
         AND p.active = true
         AND i.quantity > 0
         AND i.quantity <= v.low_stock_threshold${inventoryLocation}
       ORDER BY (v.low_stock_threshold - i.quantity) DESC, p.name, v.color, v.size
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
         v.color,
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
       GROUP BY p.id, p.code, p.name, b.name, v.id, v.color, v.size, v.barcode
       HAVING COALESCE(SUM(i.quantity), 0) <= 0
       ORDER BY p.name, v.color, v.size
       LIMIT ${limit}`,
      inventoryParams
    ),
    pool.query(
      `WITH stock AS (
         SELECT
           v.id AS variant_id,
           p.id AS product_id,
           p.code,
           p.name,
           COALESCE(b.name, 'Other / No Brand') AS brand,
           v.color,
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
         GROUP BY v.id, p.id, p.code, p.name, b.name, v.color, v.size, v.barcode
       ), last_sales AS (
         SELECT variant_id, MAX(created_at) AS last_sale_at
         FROM retail_stock_movements
         WHERE company_id = $1
           AND movement_type = 'sale'${filters.locationId ? " AND location_id = $2" : ""}
         GROUP BY variant_id
       )
       SELECT stock.*, last_sales.last_sale_at
       FROM stock
       LEFT JOIN last_sales ON last_sales.variant_id = stock.variant_id
       WHERE stock.quantity > 0
         AND (last_sales.last_sale_at IS NULL
              OR last_sales.last_sale_at < NOW() - ($${slowMovingDaysParam}::text || ' days')::interval)
       ORDER BY last_sales.last_sale_at NULLS FIRST, stock.quantity DESC
       LIMIT ${limit}`,
      slowMovingParams
    ),
  ]);

  const inventorySummary = mapNumericFields(inventorySummaryResult.rows[0] ?? {}, [
    "inventory_quantity",
    "inventory_value",
    "product_count",
    "variant_count",
    "low_stock_count",
    "out_of_stock_count",
  ]);
  const financialSummary = mapNumericFields(financialSummaryResult.rows[0] ?? {}, [
    "revenue",
    "tax_collected",
    "discount_given",
    "customer_count",
    "cogs",
    "gross_profit",
    "units_sold",
    "sale_lines",
  ]);
  const rankings = (rankingsResult.rows[0]?.rankings ?? {
    products: [],
    brands: [],
    sizes: [],
    locations: [],
  }) as Record<string, Array<Record<string, unknown>>>;

  for (const group of ["products", "brands", "sizes", "locations"]) {
    rankings[group] = (rankings[group] ?? []).map((row) =>
      mapNumericFields(row, ["product_id", "location_id", "quantity", "revenue", "cogs", "profit"])
    );
  }

  return {
    period: {
      from: filters.from.toISOString(),
      to: filters.to.toISOString(),
      locationId: filters.locationId ?? null,
    },
    summary: { ...inventorySummary, ...financialSummary },
    bestSellingProducts: rankings.products,
    bestSellingBrands: rankings.brands,
    bestSellingSizes: rankings.sizes,
    salesByLocation: rankings.locations,
    lowStock: lowStockResult.rows.map((row) =>
      mapNumericFields(row, ["product_id", "variant_id", "location_id", "quantity", "threshold"])
    ),
    outOfStock: outOfStockResult.rows.map((row) => mapNumericFields(row, ["product_id", "variant_id", "quantity"])),
    slowMoving: slowMovingResult.rows.map((row) => mapNumericFields(row, ["product_id", "variant_id", "quantity"])),
    profitByProduct: rankings.products,
    profitByBrand: rankings.brands,
  };
}


export { runRetailAudit, type RetailAuditIssue } from "./retailAudit";
