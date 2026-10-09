import { pool } from "../../db";

export interface ItemMarketBulkSalePriceFilters {
  companyId: number;
  stockItemIds: number[];
  locationIds: number[];
  startDate?: string;
  endDate?: string;
}

/**
 * The same sale/credit-note unit-price breakdown used in the expanded market
 * analysis rows, aggregated for all requested item IDs in a single query.
 * Both voucher/company and stock-item/company are scoped; location access is
 * resolved by the report route, never trusted from the browser.
 */
export async function getItemMarketBulkSalePrices(filters: ItemMarketBulkSalePriceFilters) {
  if (filters.stockItemIds.length === 0 || filters.locationIds.length === 0) return [];
  const result = await pool.query(
    `
    WITH activity AS (
      SELECT
        s.stock_item_id,
        'sale'::text AS activity_type,
        s.selling_price::numeric AS unit_price,
        s.quantity::numeric AS quantity,
        s.total_sales::numeric AS revenue,
        (s.total_sales::numeric - s.total_cost::numeric) AS profit
      FROM sales_items s
      JOIN vouchers v ON v.id = s.voucher_id
      JOIN stock_items si ON si.id = s.stock_item_id
      WHERE v.company_id = $1 AND si.company_id = $1
        AND s.stock_item_id = ANY($2::int[])
        AND v.voucher_type = 'Sales'
        AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
        AND v.location_id = ANY($3::int[])
        AND ($4::date IS NULL OR v.voucher_date >= $4::date)
        AND ($5::date IS NULL OR v.voucher_date <= $5::date)

      UNION ALL

      SELECT
        cni.stock_item_id,
        'return'::text AS activity_type,
        cni.rate::numeric AS unit_price,
        -cni.quantity::numeric AS quantity,
        -cni.total_value::numeric AS revenue,
        -(
          cni.total_value::numeric -
          (cni.quantity::numeric * cni.inventory_cost::numeric)
        ) AS profit
      FROM credit_note_items cni
      JOIN vouchers v ON v.id = cni.voucher_id
      JOIN stock_items si ON si.id = cni.stock_item_id
      WHERE v.company_id = $1 AND si.company_id = $1
        AND cni.stock_item_id = ANY($2::int[])
        AND v.voucher_type = 'Credit Note'
        AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
        AND cni.location_id = ANY($3::int[])
        AND ($4::date IS NULL OR v.voucher_date >= $4::date)
        AND ($5::date IS NULL OR v.voucher_date <= $5::date)
    )
    SELECT stock_item_id, activity_type, unit_price,
      COALESCE(SUM(quantity), 0) AS quantity,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(profit), 0) AS profit,
      COUNT(*)::int AS transaction_count
    FROM activity
    GROUP BY stock_item_id, activity_type, unit_price
    ORDER BY stock_item_id,
      CASE WHEN activity_type = 'sale' THEN 0 ELSE 1 END,
      unit_price DESC
    `,
    [filters.companyId, filters.stockItemIds, filters.locationIds, filters.startDate ?? null, filters.endDate ?? null]
  );
  const toNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return result.rows.map((row) => ({
    companyId: filters.companyId,
    stockItemId: Number(row.stock_item_id),
    activityType: String(row.activity_type) as "sale" | "return",
    unitPrice: toNumber(row.unit_price),
    quantity: toNumber(row.quantity),
    revenue: toNumber(row.revenue),
    profit: toNumber(row.profit),
    transactionCount: Number(row.transaction_count || 0),
  }));
}
