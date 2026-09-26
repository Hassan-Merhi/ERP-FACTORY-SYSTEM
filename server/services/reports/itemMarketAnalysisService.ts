import { pool } from "../../db";

export interface ItemMarketAnalysisFilters {
  companyId: number;
  locationIds: number[];
  startDate?: string;
  endDate?: string;
  search?: string;
  stockGroupId?: number;
}

type NumericRow = Record<string, string | number | null | string[]>;

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const marginPct = (profit: number, revenue: number): number =>
  revenue === 0 ? 0 : Number(((profit / revenue) * 100).toFixed(2));

const marketStatus = (soldQty: number, profit: number, margin: number) => {
  if (soldQty <= 0) return "no_sales";
  if (profit < 0) return "losing";
  if (margin >= 15) return "strong";
  return "watch";
};

export async function getItemMarketAnalysis(filters: ItemMarketAnalysisFilters) {
  const params = [
    filters.companyId,
    filters.locationIds,
    filters.startDate ?? null,
    filters.endDate ?? null,
    filters.search ?? null,
    filters.stockGroupId ?? null,
  ];

  const commonCtes = `
    WITH eligible_items AS MATERIALIZED (
      SELECT si.id, si.code, si.name, si.stock_group_id, sg.name AS stock_group_name
      FROM stock_items si
      LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
      WHERE si.company_id = $1
        AND si.deleted_at IS NULL
        AND ($5::text IS NULL OR si.code ILIKE '%' || $5 || '%' OR si.name ILIKE '%' || $5 || '%')
        AND ($6::int IS NULL OR si.stock_group_id = $6)
    ),
    imports AS (
      SELECT pli.stock_item_id,
        COUNT(DISTINCT c.id)::int AS import_count,
        COALESCE(SUM(pli.quantity::numeric), 0) AS imported_qty,
        COALESCE(SUM(pli.line_total::numeric), 0) AS purchase_value,
        COUNT(DISTINCT COALESCE(NULLIF(po.currency, ''), 'UNKNOWN'))::int AS currency_count,
        ARRAY_AGG(DISTINCT COALESCE(NULLIF(po.currency, ''), 'UNKNOWN')) AS currencies,
        SUM(pli.line_total::numeric) / NULLIF(SUM(pli.quantity::numeric), 0) AS weighted_purchase_cost
      FROM eligible_items e
      JOIN po_line_items pli ON pli.stock_item_id = e.id
      JOIN purchase_orders po ON po.id = pli.po_id
      JOIN containers c ON c.id = po.container_id
      WHERE po.company_id = $1
        AND c.offload_date IS NOT NULL
        AND ($3::date IS NULL OR c.offload_date >= $3::date)
        AND ($4::date IS NULL OR c.offload_date <= $4::date)
      GROUP BY pli.stock_item_id
    ),
    sales_base AS (
      SELECT s.stock_item_id,
        COALESCE(SUM(s.quantity::numeric), 0) AS sold_qty,
        COALESCE(SUM(s.total_sales::numeric), 0) AS revenue,
        COALESCE(SUM(s.total_cost::numeric), 0) AS historical_cost,
        COALESCE(SUM(s.total_sales::numeric - s.total_cost::numeric), 0) AS profit
      FROM eligible_items e
      JOIN sales_items s ON s.stock_item_id = e.id
      JOIN vouchers v ON v.id = s.voucher_id
      WHERE v.company_id = $1
        AND v.voucher_type = 'Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND v.location_id = ANY($2::int[])
        AND ($3::date IS NULL OR v.voucher_date >= $3::date)
        AND ($4::date IS NULL OR v.voucher_date <= $4::date)
      GROUP BY s.stock_item_id
    ),
    note_adjustments AS (
      SELECT cni.stock_item_id,
        COALESCE(SUM(
          (CASE WHEN v.voucher_type = 'Credit Note' THEN -1 ELSE 1 END) * cni.quantity::numeric
        ), 0) AS sold_qty,
        COALESCE(SUM(
          (CASE WHEN v.voucher_type = 'Credit Note' THEN -1 ELSE 1 END) * cni.total_value::numeric
        ), 0) AS revenue,
        COALESCE(SUM(
          (CASE WHEN v.voucher_type = 'Credit Note' THEN -1 ELSE 1 END) *
          (cni.quantity::numeric * cni.inventory_cost::numeric)
        ), 0) AS historical_cost,
        COALESCE(SUM(
          (CASE WHEN v.voucher_type = 'Credit Note' THEN -1 ELSE 1 END) *
          (cni.total_value::numeric - (cni.quantity::numeric * cni.inventory_cost::numeric))
        ), 0) AS profit
      FROM eligible_items e
      JOIN credit_note_items cni ON cni.stock_item_id = e.id
      JOIN vouchers v ON v.id = cni.voucher_id
      WHERE v.company_id = $1
        AND v.voucher_type IN ('Credit Note', 'Debit Note')
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND cni.location_id = ANY($2::int[])
        AND ($3::date IS NULL OR v.voucher_date >= $3::date)
        AND ($4::date IS NULL OR v.voucher_date <= $4::date)
      GROUP BY cni.stock_item_id
    ),
    sales AS (
      SELECT activity.stock_item_id,
        COALESCE(SUM(activity.sold_qty), 0) AS sold_qty,
        COALESCE(SUM(activity.revenue), 0) AS revenue,
        COALESCE(SUM(activity.historical_cost), 0) AS historical_cost,
        COALESCE(SUM(activity.profit), 0) AS profit
      FROM (
        SELECT stock_item_id, sold_qty, revenue, historical_cost, profit FROM sales_base
        UNION ALL
        SELECT stock_item_id, sold_qty, revenue, historical_cost, profit FROM note_adjustments
      ) activity
      GROUP BY activity.stock_item_id
    )
  `;

  const itemResult = await pool.query(
    `${commonCtes}
    SELECT e.id AS stock_item_id, e.code, e.name, e.stock_group_id, e.stock_group_name,
      COALESCE(i.import_count, 0) AS import_count,
      COALESCE(i.imported_qty, 0) AS imported_qty,
      CASE WHEN i.currency_count = 1 THEN i.purchase_value ELSE NULL END AS purchase_value,
      CASE WHEN i.currency_count = 1 THEN i.weighted_purchase_cost ELSE NULL END AS weighted_purchase_cost,
      COALESCE(i.currencies, ARRAY[]::text[]) AS purchase_currencies,
      COALESCE(s.sold_qty, 0) AS sold_qty,
      COALESCE(s.revenue, 0) AS revenue,
      COALESCE(s.historical_cost, 0) AS historical_cost,
      COALESCE(s.profit, 0) AS profit
    FROM eligible_items e
    LEFT JOIN imports i ON i.stock_item_id = e.id
    LEFT JOIN sales s ON s.stock_item_id = e.id
    WHERE i.stock_item_id IS NOT NULL OR s.stock_item_id IS NOT NULL
    ORDER BY COALESCE(s.profit, 0) DESC, e.code ASC
    `,
    params
  );

  const rows = (itemResult.rows as NumericRow[]).map((raw) => {
    const soldQty = numberValue(raw.sold_qty);
    const revenue = numberValue(raw.revenue);
    const profit = numberValue(raw.profit);
    const margin = marginPct(profit, revenue);
    return {
      stockItemId: Number(raw.stock_item_id),
      code: String(raw.code || ""),
      name: String(raw.name || ""),
      stockGroupId: raw.stock_group_id == null ? null : Number(raw.stock_group_id),
      stockGroupName: raw.stock_group_name ? String(raw.stock_group_name) : null,
      importCount: numberValue(raw.import_count),
      importedQty: numberValue(raw.imported_qty),
      purchaseValue: raw.purchase_value == null ? null : numberValue(raw.purchase_value),
      weightedPurchaseCost: raw.weighted_purchase_cost == null ? null : numberValue(raw.weighted_purchase_cost),
      purchaseCurrencies: Array.isArray(raw.purchase_currencies) ? raw.purchase_currencies : [],
      soldQty,
      revenue,
      historicalCost: numberValue(raw.historical_cost),
      profit,
      avgSellingPrice: soldQty === 0 ? 0 : Number((revenue / soldQty).toFixed(6)),
      profitPerUnit: soldQty === 0 ? 0 : Number((profit / soldQty).toFixed(6)),
      marginPct: margin,
      marketStatus: marketStatus(soldQty, profit, margin),
    };
  });

  const totals = rows.reduce(
    (acc, row) => ({
      importedQty: acc.importedQty + row.importedQty,
      soldQty: acc.soldQty + row.soldQty,
      revenue: acc.revenue + row.revenue,
      profit: acc.profit + row.profit,
    }),
    { importedQty: 0, soldQty: 0, revenue: 0, profit: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      itemCount: rows.length,
      ...totals,
      marginPct: marginPct(totals.profit, totals.revenue),
    },
  };
}
