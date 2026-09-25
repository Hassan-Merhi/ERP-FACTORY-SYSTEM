import type { Express } from "express";
import { z } from "zod";

import { pool } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { requirePageAccess } from "../../lib/permissionMiddleware";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  sendCompanyAccessError,
} from "../../security/companyAccessBoundary";
import { getItemMarketAnalysis } from "../../services/reports/itemMarketAnalysisService";
import {
  resolveStockInSalesLocationIds,
  StockInSalesLocationAccessError,
} from "../../services/reports/stockInSalesLocationAccess";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { storage } from "../../storage";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "Date is invalid");

const querySchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  stockGroupId: z.coerce.number().int().positive().optional(),
  companyIds: z.string().trim().max(500).optional(),
});

const first = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value[0] == null
      ? undefined
      : String(value[0])
    : typeof value === "string"
      ? value
      : undefined;

function parseCompanyIds(value: string | undefined, activeCompanyId: number): number[] {
  if (!value) return [activeCompanyId];

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = [...new Set(parts.map((part) => Number(part)))];

  if (
    ids.length === 0 ||
    ids.length > 20 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new CompanyAccessError(400, "companyIds must contain 1 to 20 valid company IDs", "INVALID_COMPANY_IDS");
  }

  return ids;
}

function marginPct(profit: number, revenue: number): number {
  return revenue === 0 ? 0 : Number(((profit / revenue) * 100).toFixed(2));
}

export function registerItemMarketAnalysisRoutes(app: Express) {
  const reportPageAccess = requirePageAccess("page_sales_report");

  app.get("/api/reports/item-market-analysis", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const activeCompanyId = req.session.currentCompanyId;
    const userId = req.session.userId;
    const activeRole = req.session.currentRole;
    if (!activeCompanyId || !userId || !activeRole) {
      return res.status(400).json({ message: "An active company session is required" });
    }

    const parsed = querySchema.safeParse({
      startDate: first(req.query.startDate),
      endDate: first(req.query.endDate),
      search: first(req.query.search),
      country: first(req.query.country),
      stockGroupId: first(req.query.stockGroupId),
      companyIds: first(req.query.companyIds),
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid item market analysis filters", errors: parsed.error.flatten() });
    }
    if (parsed.data.startDate && parsed.data.endDate && parsed.data.startDate > parsed.data.endDate) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      const companyIds = parseCompanyIds(parsed.data.companyIds, activeCompanyId);
      await assertCompaniesAccess(userId, companyIds);

      const companyResult = await pool.query(
        `SELECT id, code, name, COALESCE(company_type, 'erp') AS company_type
         FROM companies
         WHERE id = ANY($1::int[]) AND active = true`,
        [companyIds]
      );
      const companiesById = new Map<number, { id: number; code: string; name: string; companyType: string }>(
        companyResult.rows.map((row) => [
          Number(row.id),
          {
            id: Number(row.id),
            code: String(row.code || ""),
            name: String(row.name || ""),
            companyType: String(row.company_type || "erp"),
          },
        ])
      );

      if (companiesById.size !== companyIds.length) {
        return res.status(404).json({ message: "One or more selected companies could not be found" });
      }

      const selectedCompanies = companyIds.map((id) => companiesById.get(id)!);
      if (selectedCompanies.some((company) => company.companyType !== "erp")) {
        return res.status(403).json({ message: "Item Market Analysis can only compare ERP companies" });
      }

      const sections = await runWithDatabaseScopeRuntimeContext(
        createTenantDatabaseScope(activeCompanyId, companyIds, "authorized-companies"),
        async () =>
          Promise.all(
            selectedCompanies.map(async (company) => {
              const assignment =
                company.id === activeCompanyId ? undefined : await storage.getUserCompanyRole(userId, company.id);
              const role = company.id === activeCompanyId ? activeRole : assignment?.role ?? (activeRole === "Developer" ? "Developer" : null);

              if (!role || role === "POS") {
                throw new CompanyAccessError(
                  403,
                  `You do not have report access to ${company.name}`,
                  "COMPANY_REPORT_ACCESS_DENIED"
                );
              }

              const locationIds = await resolveStockInSalesLocationIds({
                companyId: company.id,
                userId,
                role,
                currentLocationId:
                  company.id === activeCompanyId ? req.session.currentLocationId : assignment?.assignedLocationId ?? null,
                requestedLocationIds: [],
              });

              const [analysis, countriesResult] = await Promise.all([
                getItemMarketAnalysis({
                  companyId: company.id,
                  locationIds,
                  startDate: parsed.data.startDate,
                  endDate: parsed.data.endDate,
                  search: parsed.data.search || undefined,
                  country: parsed.data.country || undefined,
                  stockGroupId: companyIds.length === 1 ? parsed.data.stockGroupId : undefined,
                }),
                pool.query(
                  `SELECT DISTINCT COALESCE(NULLIF(BTRIM(country), ''), 'Unknown Country') AS country
                   FROM locations
                   WHERE company_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL
                   ORDER BY country`,
                  [company.id, locationIds]
                ),
              ]);

              return {
                company,
                analysis,
                countries: countriesResult.rows.map((row) => String(row.country)),
              };
            })
          )
      );

      const rows = sections.flatMap(({ company, analysis }) =>
        analysis.rows.map((row) => ({
          ...row,
          companyId: company.id,
          companyCode: company.code,
          companyName: company.name,
        }))
      );

      const totals = rows.reduce(
        (acc, row) => ({
          importedQty: acc.importedQty + row.importedQty,
          soldQty: acc.soldQty + row.soldQty,
          revenue: acc.revenue + row.revenue,
          profit: acc.profit + row.profit,
        }),
        { importedQty: 0, soldQty: 0, revenue: 0, profit: 0 }
      );

      const companySummaries = sections.map(({ company, analysis }) => ({
        companyId: company.id,
        companyCode: company.code,
        companyName: company.name,
        ...analysis.summary,
      }));

      res.setHeader("Cache-Control", "private, no-store");
      return res.json({
        generatedAt: new Date().toISOString(),
        countries: [...new Set(sections.flatMap((section) => section.countries))].sort((a, b) => a.localeCompare(b)),
        rows,
        companySummaries,
        summary: {
          itemCount: new Set(rows.map((row) => row.name.trim().toLocaleLowerCase())).size,
          ...totals,
          marginPct: marginPct(totals.profit, totals.revenue),
        },
      });
    } catch (error: unknown) {
      if (error instanceof CompanyAccessError) {
        return sendCompanyAccessError(res, error);
      }
      if (error instanceof StockInSalesLocationAccessError) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      logger.error("Item market analysis error", {
        module: "reports",
        action: "item-market-analysis",
        companyId: activeCompanyId,
        error,
      });
      return res.status(500).json({ message: "Failed to generate item market analysis" });
    }
  });
}
