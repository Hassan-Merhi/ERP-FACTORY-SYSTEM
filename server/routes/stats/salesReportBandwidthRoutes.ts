import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { storage } from "../../storage";

type Grouping = "daily" | "monthly" | "yearly";
type ProfitFilter = "all" | "positive" | "negative";

type CompanyOption = {
  id: number;
  code: string;
  name: string;
};

type SummaryParams = {
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

type SummaryGroup = {
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

function parseIdList(value: unknown): number[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Backward-compatible fallback for callers that send comma-separated names.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGrouping(value: unknown): Grouping {
  return value === "monthly" || value === "yearly" ? value : "daily";
}

function parseProfitFilter(value: unknown): ProfitFilter {
  return value === "positive" || value === "negative" ? value : "all";
}

function readSummaryParams(req: Request): SummaryParams {
  return {
    startDate: typeof req.query.startDate === "string" && req.query.startDate ? req.query.startDate : undefined,
    endDate: typeof req.query.endDate === "string" && req.query.endDate ? req.query.endDate : undefined,
    grouping: parseGrouping(req.query.grouping),
    mergeView: req.query.mergeView === "true" || req.query.mergeView === "1",
    profitFilter: parseProfitFilter(req.query.profitFilter),
    search: typeof req.query.search === "string" ? req.query.search.trim() : "",
    locationIds: parseIdList(req.query.locationIds),
    stockGroupIds: parseIdList(req.query.stockGroupIds),
    stockGroupNames: parseStringArray(req.query.stockGroupNames),
  };
}

function dateKeyExpression(grouping: Grouping): string {
  if (grouping === "monthly") return `TO_CHAR(v.voucher_date::date, 'YYYY-MM')`;
  if (grouping === "yearly") return `TO_CHAR(v.voucher_date::date, 'YYYY')`;
  return `TO_CHAR(v.voucher_date::date, 'YYYY-MM-DD')`;
}

async function buildSalesSummary(companyIds: number[], params: SummaryParams): Promise<SummaryGroup[]> {
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
        COALESCE(SUM(COALESCE(sales.profit, 0)::numeric), 0)::float8 AS "costProfit",
        COALESCE(
          SUM(
            (
              CASE
                WHEN COALESCE(price.selling_price, 0)::numeric > 0 THEN price.selling_price::numeric
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
                WHEN COALESCE(price.selling_price, 0)::numeric > 0 THEN price.selling_price::numeric
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
      LEFT JOIN stock_item_location_prices price
        ON price.stock_item_id = sales.stock_item_id
        AND price.location_id = v.location_id
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

function buildSummaryTotals(groups: SummaryGroup[]) {
  return groups.reduce(
    (totals, group) => {
      totals.itemCount += group.itemCount;
      totals.totalQty += group.totalQty;
      totals.totalSales += group.totalSales;
      totals.totalCost += group.totalCost;
      totals.totalConfiguredCost += group.totalConfiguredCost;
      totals.costProfit += group.costProfit;
      totals.configuredProfit += group.configuredProfit;
      return totals;
    },
    {
      itemCount: 0,
      totalQty: 0,
      totalSales: 0,
      totalCost: 0,
      totalConfiguredCost: 0,
      costProfit: 0,
      configuredProfit: 0,
    }
  );
}

async function getAccessibleCompanies(userId: string | number): Promise<CompanyOption[]> {
  const accessibleIds = Array.from(await getAccessibleCompanyIds(String(userId)));
  if (accessibleIds.length === 0) return [];
  const accessibleSet = new Set(accessibleIds);
  const companies = await storage.getAllCompanies();
  return companies
    .filter((company) => accessibleSet.has(company.id))
    .map((company) => ({ id: company.id, code: company.code, name: company.name }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function filterCompaniesByCodes(companies: CompanyOption[], value: unknown): CompanyOption[] {
  if (typeof value !== "string" || !value.trim()) return companies;
  const codes = new Set(
    value
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean)
  );
  return companies.filter((company) => codes.has(company.code));
}

async function buildComparisonRows(companies: CompanyOption[], req: Request) {
  if (companies.length === 0) return [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [
    `v.company_id = ANY(${bind(companies.map((company) => company.id))}::int[])`,
    `v.optional = FALSE`,
    `v.deleted_at IS NULL`,
  ];
  if (typeof req.query.startDate === "string" && req.query.startDate) {
    conditions.push(`v.voucher_date >= ${bind(req.query.startDate)}::date`);
  }
  if (typeof req.query.endDate === "string" && req.query.endDate) {
    conditions.push(`v.voucher_date <= ${bind(req.query.endDate)}::date`);
  }

  const result = await pool.query(
    `
      SELECT
        v.company_id AS "companyId",
        MIN(sales.stock_item_id)::int AS "stockItemId",
        COALESCE(si.code, '') AS "stockItemCode",
        COALESCE(si.name, '') AS "stockItemName",
        COALESCE(sg.name, '') AS "stockGroupName",
        COALESCE(SUM(COALESCE(sales.quantity, 0)::numeric), 0)::text AS quantity,
        COALESCE(SUM(COALESCE(sales.total_sales, 0)::numeric), 0)::text AS "totalSales",
        COALESCE(SUM(COALESCE(sales.profit, 0)::numeric), 0)::text AS "costProfit"
      FROM sales_items sales
      INNER JOIN vouchers v ON sales.voucher_id = v.id
      INNER JOIN stock_items si ON sales.stock_item_id = si.id
      LEFT JOIN stock_groups sg ON si.stock_group_id = sg.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY v.company_id, si.code, si.name, sg.name
      ORDER BY si.name ASC, si.code ASC, v.company_id ASC
    `,
    values
  );

  const byId = new Map(companies.map((company) => [company.id, company]));
  return result.rows.map((row: Record<string, unknown>) => {
    const company = byId.get(Number(row.companyId));
    return {
      stockItemId: Number(row.stockItemId || 0),
      stockItemCode: String(row.stockItemCode || ""),
      stockItemName: String(row.stockItemName || ""),
      stockGroupName: row.stockGroupName ? String(row.stockGroupName) : null,
      quantity: String(row.quantity || "0"),
      totalSales: String(row.totalSales || "0"),
      costProfit: String(row.costProfit || "0"),
      companyId: Number(row.companyId),
      companyCode: company?.code || "",
      companyName: company?.name || "Unknown",
    };
  });
}

export function registerSalesReportBandwidthRoutes(app: Express): void {
  app.get("/api/sales-report/summary", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const groups = await buildSalesSummary([companyId], readSummaryParams(req));
      return res.json({ groups, totals: buildSummaryTotals(groups), companies: [] });
    } catch (error: unknown) {
      logger.error("Sales report summary error:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/dashboard/sales-report-all/summary", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const accessibleCompanies = await getAccessibleCompanies(userId);
      const selectedCompanies = filterCompaniesByCodes(accessibleCompanies, req.query.companyFilter);
      const groups = await buildSalesSummary(
        selectedCompanies.map((company) => company.id),
        readSummaryParams(req)
      );
      return res.json({
        groups,
        totals: buildSummaryTotals(groups),
        companies: accessibleCompanies.map(({ code, name }) => ({ code, name })),
      });
    } catch (error: unknown) {
      logger.error("All-company sales report summary error:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/dashboard/sales-report-comparison", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const accessibleCompanies = await getAccessibleCompanies(userId);
      const selectedCompanies = filterCompaniesByCodes(accessibleCompanies, req.query.companyFilter);
      return res.json(await buildComparisonRows(selectedCompanies, req));
    } catch (error: unknown) {
      logger.error("Sales report comparison summary error:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
