import type { Express, Request } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { storage } from "../../storage";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import {
  buildSalesSummary,
  type Grouping,
  type ProfitFilter,
  type CompanyOption,
  type SummaryParams,
  type SummaryGroup,
} from "./salesReportBandwidthRoutesHelpers";

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
        COALESCE(SUM(COALESCE(sales.total_sales, 0)::numeric - COALESCE(sales.total_cost, 0)::numeric), 0)::text AS "costProfit"
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
      // The pooled database connection defaults to the active company under FORCE RLS.
      // Explicitly scope this aggregate read to the membership-verified companies so
      // selecting a different company never silently returns an empty sales report.
      const authorizedIds = accessibleCompanies.map((company) => company.id);
      const activeCompanyId = Number(req.session.currentCompanyId);
      const primaryCompanyId = authorizedIds.includes(activeCompanyId) ? activeCompanyId : authorizedIds[0];
      const groups = primaryCompanyId
        ? await runWithDatabaseScopeRuntimeContext(
            createTenantDatabaseScope(primaryCompanyId, authorizedIds, "authorized-companies"),
            () =>
              buildSalesSummary(
                selectedCompanies.map((company) => company.id),
                readSummaryParams(req)
              )
          )
        : [];
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
      const authorizedIds = accessibleCompanies.map((company) => company.id);
      const activeCompanyId = Number(req.session.currentCompanyId);
      const primaryCompanyId = authorizedIds.includes(activeCompanyId) ? activeCompanyId : authorizedIds[0];
      const rows = primaryCompanyId
        ? await runWithDatabaseScopeRuntimeContext(
            createTenantDatabaseScope(primaryCompanyId, authorizedIds, "authorized-companies"),
            () => buildComparisonRows(selectedCompanies, req)
          )
        : [];
      return res.json(rows);
    } catch (error: unknown) {
      logger.error("Sales report comparison summary error:", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
