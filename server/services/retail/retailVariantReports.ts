import { pool } from "../../db";

/** Filters shared by the exact-variant stock and sales reports. */
export interface RetailVariantReportFilters {
  companyId: number;
  brandId?: number;
  search?: string;
  color?: string;
  size?: string;
  locationId?: number;
  status?: "all" | "in" | "low" | "out" | "slow";
  slowMovingDays?: number;
  from?: Date;
  to?: Date;
  limit?: number;
}

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function variantWhere(filters: RetailVariantReportFilters, params: unknown[], includeArchived = false): string[] {
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [`v.company_id = ${add(filters.companyId)}`];
  if (!includeArchived) where.push("v.active = true", "p.active = true");
  if (filters.brandId) where.push(`p.brand_id = ${add(filters.brandId)}`);
  if (filters.color) where.push(`LOWER(v.color) = LOWER(${add(filters.color)})`);
  if (filters.size) where.push(`LOWER(v.size) = LOWER(${add(filters.size)})`);
  if (filters.search) {
    const token = add(`%${filters.search.trim().toLowerCase()}%`);
    where.push(
      `LOWER(CONCAT_WS(' ', p.name, p.code, COALESCE(b.name, ''), v.color, v.size, v.barcode, COALESCE(v.sku, ''))) LIKE ${token}`
    );
  }
  return where;
}

/**
 * One row per exact variant (and per location when a location is chosen):
 * brand, style, color, size, barcode, SKU, stock, value and last sale.
 */
export async function getRetailStockReport(filters: RetailVariantReportFilters) {
  const params: unknown[] = [];
  const where = variantWhere(filters, params);
  const locationJoin = filters.locationId ? `AND i.location_id = $${params.push(filters.locationId)}` : "";
  const slowDays = Math.min(Math.max(filters.slowMovingDays ?? 60, 1), 3650);
  const limit = Math.min(Math.max(filters.limit ?? 2000, 1), 10000);
  const having: string[] = [];
  if (filters.status === "in") having.push("COALESCE(SUM(i.quantity), 0) > 0");
  if (filters.status === "out") having.push("COALESCE(SUM(i.quantity), 0) <= 0");
  if (filters.status === "low") {
    having.push("COALESCE(SUM(i.quantity), 0) > 0 AND COALESCE(SUM(i.quantity), 0) <= v.low_stock_threshold");
  }
  if (filters.status === "slow") {
    const slowParam = `$${params.push(slowDays)}`;
    having.push(
      `COALESCE(SUM(i.quantity), 0) > 0 AND (MAX(ls.last_sale_at) IS NULL OR MAX(ls.last_sale_at) < now() - (${slowParam} || ' days')::interval)`
    );
  }
  const result = await pool.query(
    `WITH last_sales AS (
       SELECT variant_id, MAX(created_at) AS last_sale_at
       FROM retail_stock_movements
       WHERE company_id = $1 AND movement_type = 'sale'
       GROUP BY variant_id
     )
     SELECT
       v.id AS variant_id,
       p.id AS product_id,
       COALESCE(b.name, 'Other / No Brand') AS brand,
       p.name AS style,
       p.category,
       v.color,
       v.size,
       v.barcode,
       v.sku,
       v.cost,
       v.selling_price,
       v.low_stock_threshold,
       COALESCE(SUM(i.quantity), 0) AS quantity,
       COALESCE(SUM(i.quantity * CASE WHEN i.average_cost > 0 THEN i.average_cost ELSE v.cost END), 0) AS stock_value,
       STRING_AGG(l.name || ': ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM i.quantity::text)), ', ' ORDER BY l.name)
         FILTER (WHERE i.quantity <> 0) AS locations,
       MAX(ls.last_sale_at) AS last_sale_at
     FROM retail_product_variants v
     JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
     LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
     LEFT JOIN retail_variant_inventory i ON i.variant_id = v.id AND i.company_id = v.company_id ${locationJoin}
     LEFT JOIN locations l ON l.id = i.location_id AND l.company_id = v.company_id
     LEFT JOIN last_sales ls ON ls.variant_id = v.id
     WHERE ${where.join(" AND ")}
     GROUP BY v.id, p.id, b.name
     ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
     ORDER BY LOWER(COALESCE(b.name, '')), LOWER(p.name), LOWER(v.color), v.size
     LIMIT ${limit}`,
    params
  );
  return result.rows.map((row) => ({
    variantId: row.variant_id,
    productId: row.product_id,
    brand: row.brand,
    style: row.style,
    category: row.category,
    color: row.color,
    size: row.size,
    barcode: row.barcode,
    sku: row.sku,
    cost: numberValue(row.cost),
    sellingPrice: numberValue(row.selling_price),
    lowStockThreshold: numberValue(row.low_stock_threshold),
    quantity: numberValue(row.quantity),
    stockValue: numberValue(row.stock_value),
    locations: row.locations ?? "",
    lastSaleAt: row.last_sale_at ? new Date(row.last_sale_at).toISOString() : null,
  }));
}

/** Sold / returned / net quantity, revenue, cost and profit per exact variant in a period. */
export async function getRetailVariantSalesReport(filters: RetailVariantReportFilters) {
  const params: unknown[] = [];
  // Archived variants keep their sales history in reports.
  const where = variantWhere(filters, params, true);
  const fromParam = `$${params.push(filters.from ?? new Date(Date.now() - 30 * 86400000))}`;
  const toParam = `$${params.push(filters.to ?? new Date())}`;
  const locationClause = filters.locationId ? `AND s.location_id = $${params.push(filters.locationId)}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 2000, 1), 10000);
  const result = await pool.query(
    `WITH sold AS (
       SELECT si.variant_id,
              SUM(si.quantity) AS sold_qty,
              SUM(si.quantity * si.unit_price) AS gross_revenue,
              SUM(si.quantity * si.unit_cost) AS gross_cost
       FROM retail_pos_sale_items si
       JOIN retail_pos_sales s ON s.id = si.sale_id AND s.company_id = si.company_id
       WHERE si.company_id = $1 AND s.status = 'completed'
         AND s.created_at >= ${fromParam} AND s.created_at < ${toParam} ${locationClause}
       GROUP BY si.variant_id
     ), returned AS (
       SELECT ri.variant_id,
              SUM(ri.quantity) AS returned_qty,
              SUM(ri.quantity * ri.unit_price) AS returned_revenue,
              SUM(ri.quantity * si.unit_cost) AS returned_cost
       FROM retail_pos_return_items ri
       JOIN retail_pos_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
       JOIN retail_pos_sale_items si ON si.id = ri.sale_item_id
       JOIN retail_pos_sales s ON s.id = r.sale_id AND s.company_id = r.company_id
       WHERE ri.company_id = $1
         AND r.created_at >= ${fromParam} AND r.created_at < ${toParam} ${locationClause}
       GROUP BY ri.variant_id
     )
     SELECT
       v.id AS variant_id,
       COALESCE(b.name, 'Other / No Brand') AS brand,
       p.name AS style,
       v.color,
       v.size,
       v.barcode,
       v.sku,
       COALESCE(sold.sold_qty, 0) AS sold_qty,
       COALESCE(returned.returned_qty, 0) AS returned_qty,
       COALESCE(sold.gross_revenue, 0) - COALESCE(returned.returned_revenue, 0) AS net_revenue,
       COALESCE(sold.gross_cost, 0) - COALESCE(returned.returned_cost, 0) AS net_cost
     FROM retail_product_variants v
     JOIN retail_products p ON p.id = v.product_id AND p.company_id = v.company_id
     LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
     LEFT JOIN sold ON sold.variant_id = v.id
     LEFT JOIN returned ON returned.variant_id = v.id
     WHERE ${where.join(" AND ")}
       AND (sold.variant_id IS NOT NULL OR returned.variant_id IS NOT NULL)
     ORDER BY net_revenue DESC, LOWER(p.name), v.color, v.size
     LIMIT ${limit}`,
    params
  );
  return result.rows.map((row) => {
    const netRevenue = numberValue(row.net_revenue);
    const netCost = numberValue(row.net_cost);
    return {
      variantId: row.variant_id,
      brand: row.brand,
      style: row.style,
      color: row.color,
      size: row.size,
      barcode: row.barcode,
      sku: row.sku,
      soldQuantity: numberValue(row.sold_qty),
      returnedQuantity: numberValue(row.returned_qty),
      netQuantity: numberValue(row.sold_qty) - numberValue(row.returned_qty),
      netRevenue,
      netCost,
      profit: netRevenue - netCost,
    };
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Neutralize spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string }>): string {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
