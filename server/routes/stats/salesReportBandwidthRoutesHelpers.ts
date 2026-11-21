// Extracted from ./salesReportBandwidthRoutes.ts
import { normalizeSearchText } from "@shared/searchNormalization";
import { pool } from "../../db";

export type Grouping = "daily" | "monthly" | "yearly";

export type ProfitFilter = "all" | "positive" | "negative";

export type CompanyOption = {
  id: number;
  code: string;
  name: string;
};

export type SummaryParams = {
  startDate?: string;
  endDate?: string;
  grouping: Grouping;
  mergeView: boolean;
  profitFilter: ProfitFilter;
  search: string;
  locationIds: number[];
  stockGroupIds: number[];
  stockGroupNames: string[];
};

export type SummaryGroup = {
  date: string;
  dateKey: string;
  displayDate: string;
  totalSales: number;
  totalCost: number;
  totalConfiguredCost: number;
  costProfit: number;
  configuredProfit: number;
  itemCount: number;
  totalQty: number;
  isCreditSale: boolean;
  hasMixedSales: boolean;
  items: never[];
};

function dateKeyExpression(grouping: Grouping): string {
  if (grouping === "monthly") return `TO_CHAR(v.voucher_date::date, 'YYYY-MM')`;
  if (grouping === "yearly") return `TO_CHAR(v.voucher_date::date, 'YYYY')`;
  return `TO_CHAR(v.voucher_date::date, 'YYYY-MM-DD')`;
}

export async function buildSalesSummary(companyIds: number[], params: SummaryParams): Promise<SummaryGroup[]> {
  if (companyIds.length === 0) return [];

  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const conditions = [`v.company_id = ANY(${bind(companyIds)}::int[])`, `v.optional = FALSE`, `v.deleted_at IS NULL`];
  if (params.startDate) conditions.push(`v.voucher_date >= ${bind(params.startDate)}::date`);
  if (params.endDate) conditions.push(`v.voucher_date <= ${bind(params.endDate)}::date`);
  if (params.locationIds.length > 0) conditions.push(`v.location_id = ANY(${bind(params.locationIds)}::int[])`);
  if (params.stockGroupIds.length > 0) {
    conditions.push(`si.stock_group_id = ANY(${bind(params.stockGroupIds)}::int[])`);
  }
  if (params.stockGroupNames.length > 0) {
    conditions.push(`sg.name = ANY(${bind(params.stockGroupNames)}::text[])`);
  }
  if (params.search) {
    const needle = `%${params.search.toLowerCase()}%`;
    const compactNeedle = `%${normalizeSearchText(params.search)}%`;
    conditions.push(
      `(
        LOWER(COALESCE(si.name, '')) LIKE ${bind(needle)}
        OR LOWER(COALESCE(l.name, v.location_name, '')) LIKE ${bind(needle)}
        OR regexp_replace(lower(COALESCE(si.name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${bind(compactNeedle)}
        OR regexp_replace(lower(COALESCE(l.name, v.location_name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${bind(compactNeedle)}
      )`
    );
  }

  const dateKey = dateKeyExpression(params.grouping);
  const creditProjection = params.mergeView
    ? `'all'::text AS "creditBucket"`
    : `CASE WHEN COALESCE(v.is_credit_sale, FALSE) THEN 'credit' ELSE 'cash' END AS "creditBucket"`;
  const creditGroupBy = params.mergeView ? "" : `, COALESCE(v.is_credit_sale, FALSE)`;

  const query = `
    WITH grouped AS (
      SELECT
        ${dateKey} AS "dateKey",
        ${creditProjection},
        COUNT(*)::int AS "itemCount",
        COALESCE(SUM(COALESCE(sales.quantity, 0)::numeric), 0)::float8 AS "totalQty",
        COALESCE(SUM(COALESCE(sales.total_sales, 0)::numeric), 0)::float8 AS "totalSales",
        COALESCE(SUM(COALESCE(sales.total_cost, 0)::numeric), 0)::float8 AS "totalCost",
        COALESCE(SUM(COALESCE(sales.total_sales, 0)::numeric - COALESCE(sales.total_cost, 0)::numeric), 0)::float8 AS "costProfit",
        COALESCE(
          SUM(
            (
              CASE
                WHEN COALESCE(price.selling_price, si.selling_price, 0)::numeric > 0
                  THEN COALESCE(price.selling_price, si.selling_price)::numeric
                ELSE COALESCE(sales.selling_price, 0)::numeric
              END
            ) * COALESCE(sales.quantity, 0)::numeric
          ),
          0
        )::float8 AS "totalConfiguredCost",
        COALESCE(
          SUM(
            (
              COALESCE(sales.selling_price, 0)::numeric -
              CASE
                WHEN COALESCE(price.selling_price, si.selling_price, 0)::numeric > 0
                  THEN COALESCE(price.selling_price, si.selling_price)::numeric
                ELSE COALESCE(sales.selling_price, 0)::numeric
              END
            ) * COALESCE(sales.quantity, 0)::numeric
          ),
          0
        )::float8 AS "configuredProfit",
        BOOL_AND(COALESCE(v.is_credit_sale, FALSE)) AS "isCreditSale",
        (
          BOOL_OR(COALESCE(v.is_credit_sale, FALSE))
          AND BOOL_OR(NOT COALESCE(v.is_credit_sale, FALSE))
        ) AS "hasMixedSales"
      FROM sales_items sales
      INNER JOIN vouchers v ON sales.voucher_id = v.id
      INNER JOIN stock_items si ON sales.stock_item_id = si.id
      LEFT JOIN stock_groups sg ON si.stock_group_id = sg.id
      LEFT JOIN locations l ON v.location_id = l.id
      -- The Price List inherits the master location's price for follower
      -- locations. Resolve it here too so summary totals match detail rows.
      -- A scalar subquery avoids duplicate sales rows from legacy mappings.
      LEFT JOIN stock_item_location_prices price
        ON price.stock_item_id = sales.stock_item_id
        AND price.location_id = COALESCE(
          (
            SELECT lpg.master_location_id
            FROM location_price_groups lpg
            WHERE lpg.company_id = v.company_id
              AND lpg.follower_location_id = v.location_id
            ORDER BY lpg.id
            LIMIT 1
          ),
          v.location_id
        )
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${dateKey}${creditGroupBy}
    )
    SELECT *
    FROM grouped
    ORDER BY "dateKey" DESC, "isCreditSale" DESC
  `;

  const result = await pool.query(query, values);
  const rows = result.rows.map((row: Record<string, unknown>): SummaryGroup => {
    const cleanDateKey = String(row.dateKey || "");
    const isCreditSale = Boolean(row.isCreditSale);
    return {
      date: !params.mergeView && isCreditSale ? `${cleanDateKey}-credit` : cleanDateKey,
      dateKey: cleanDateKey,
      displayDate: cleanDateKey,
      totalSales: Number(row.totalSales || 0),
      totalCost: Number(row.totalCost || 0),
      totalConfiguredCost: Number(row.totalConfiguredCost || 0),
      costProfit: Number(row.costProfit || 0),
      configuredProfit: Number(row.configuredProfit || 0),
      itemCount: Number(row.itemCount || 0),
      totalQty: Number(row.totalQty || 0),
      isCreditSale,
      hasMixedSales: Boolean(row.hasMixedSales),
      items: [],
    };
  });

  if (params.profitFilter === "positive") return rows.filter((row) => row.costProfit >= 0);
  if (params.profitFilter === "negative") return rows.filter((row) => row.costProfit < 0);
  return rows;
}
