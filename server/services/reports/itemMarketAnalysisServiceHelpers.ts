// Extracted from ./itemMarketAnalysisService.ts
import { pool } from "../../db";

export interface ItemMarketAnalysisFilters {
  companyId: number;
  locationIds: number[];
  startDate?: string;
  endDate?: string;
  search?: string;
  stockGroupId?: number;
  stockGroupNames?: string[];
}

export type NumericRow = Record<string, string | number | null | string[]>;

export const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const marginPct = (profit: number, revenue: number): number =>
  revenue === 0 ? 0 : Number(((profit / revenue) * 100).toFixed(2));

export const marketStatus = (soldQty: number, profit: number, margin: number) => {
  if (soldQty <= 0) return "no_sales";
  if (profit < 0) return "losing";
  if (margin >= 15) return "strong";
  return "watch";
};

export interface ItemMarketSalePriceBreakdownFilters {
  companyId: number;
  stockItemId: number;
  locationIds: number[];
  startDate?: string;
  endDate?: string;
}

export async function getItemMarketSalePriceBreakdown(filters: ItemMarketSalePriceBreakdownFilters) {
  const result = await pool.query(
    `
    WITH activity AS (
      SELECT
        'sale'::text AS activity_type,
        s.selling_price::numeric AS unit_price,
        s.quantity::numeric AS quantity,
        s.total_sales::numeric AS revenue,
        (s.total_sales::numeric - s.total_cost::numeric) AS profit
      FROM sales_items s
      JOIN vouchers v ON v.id = s.voucher_id
      JOIN stock_items si ON si.id = s.stock_item_id
      WHERE v.company_id = $1
        AND si.company_id = $1
        AND s.stock_item_id = $2
        AND v.voucher_type = 'Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND v.location_id = ANY($3::int[])
        AND ($4::date IS NULL OR v.voucher_date >= $4::date)
        AND ($5::date IS NULL OR v.voucher_date <= $5::date)

      UNION ALL

      SELECT
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
      WHERE v.company_id = $1
        AND si.company_id = $1
        AND cni.stock_item_id = $2
        AND v.voucher_type = 'Credit Note'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND cni.location_id = ANY($3::int[])
        AND ($4::date IS NULL OR v.voucher_date >= $4::date)
        AND ($5::date IS NULL OR v.voucher_date <= $5::date)
    )
    SELECT
      activity_type,
      unit_price,
      COALESCE(SUM(quantity), 0) AS quantity,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(profit), 0) AS profit,
      COUNT(*)::int AS transaction_count
    FROM activity
    GROUP BY activity_type, unit_price
    ORDER BY CASE WHEN activity_type = 'sale' THEN 0 ELSE 1 END, unit_price DESC
    `,
    [filters.companyId, filters.stockItemId, filters.locationIds, filters.startDate ?? null, filters.endDate ?? null]
  );

  return {
    rows: result.rows.map((raw) => ({
      activityType: String(raw.activity_type) as "sale" | "return",
      unitPrice: numberValue(raw.unit_price),
      quantity: numberValue(raw.quantity),
      revenue: numberValue(raw.revenue),
      profit: numberValue(raw.profit),
      transactionCount: Number(raw.transaction_count || 0),
    })),
  };
}
