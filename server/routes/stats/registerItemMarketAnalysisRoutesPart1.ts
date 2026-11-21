// Extracted from ./registerItemMarketAnalysisRoutes.ts
import type { Express } from "express";
import { pool } from "../../db";
import { getItemMarketBulkSalePrices } from "../../services/reports/itemMarketBulkSalePrices";
import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { buildPermissionMap, canAccess } from "../../lib/permissionHelpers";
import { requirePageAccess } from "../../lib/permissionMiddleware";
import {
  assertCompaniesAccess,
  CompanyAccessError,
  sendCompanyAccessError,
} from "../../security/companyAccessBoundary";
import { getItemMarketSalePriceBreakdown } from "../../services/reports/itemMarketAnalysisService";
import {
  resolveStockInSalesLocationIds,
  StockInSalesLocationAccessError,
} from "../../services/reports/stockInSalesLocationAccess";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { storage } from "../../storage";
import { exportSalePricesSchema, first, salePriceQuerySchema } from "./itemMarketAnalysisRoutesParseStockGroupNames";

export function registerItemMarketAnalysisRoutesPart1(app: Express) {
  const reportPageAccess = requirePageAccess("page_sales_report");

  app.get(
    "/api/reports/item-market-analysis/sale-prices",
    requireAuth,
    requireNonPOS,
    reportPageAccess,
    async (req, res) => {
      const activeCompanyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      const activeRole = req.session.currentRole;
      if (!activeCompanyId || !userId || !activeRole) {
        return res.status(400).json({ message: "An active company session is required" });
      }

      const parsed = salePriceQuerySchema.safeParse({
        companyId: first(req.query.companyId),
        stockItemId: first(req.query.stockItemId),
        startDate: first(req.query.startDate),
        endDate: first(req.query.endDate),
      });
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid item sale price filters", errors: parsed.error.flatten() });
      }
      if (parsed.data.startDate && parsed.data.endDate && parsed.data.startDate > parsed.data.endDate) {
        return res.status(400).json({ message: "Start date cannot be after end date" });
      }

      try {
        const companyId = parsed.data.companyId;
        await assertCompaniesAccess(userId, [companyId]);

        const companyResult = await pool.query<{
          id: number;
          name: string;
          company_type: string | null;
        }>(
          `SELECT id, name, company_type
             FROM companies
            WHERE id = $1
              AND active = true
            LIMIT 1`,
          [companyId]
        );
        const company = companyResult.rows[0];
        if (!company) {
          return res.status(404).json({ message: "Selected company could not be found" });
        }
        if (String(company.company_type || "erp") !== "erp") {
          return res.status(403).json({ message: "Item Market Analysis is available for ERP companies only" });
        }

        const assignment =
          companyId === activeCompanyId ? undefined : await storage.getUserCompanyRole(userId, companyId);
        const role =
          companyId === activeCompanyId
            ? activeRole
            : (assignment?.role ?? (activeRole === "Developer" ? "Developer" : null));

        if (!role || role === "POS") {
          throw new CompanyAccessError(
            403,
            `You do not have report access to ${company.name}`,
            "COMPANY_REPORT_ACCESS_DENIED"
          );
        }

        if (role !== "Developer" && role !== "Admin") {
          const permissionRows = await storage.getRoleFeaturePermissions(companyId);
          const permissionMap = buildPermissionMap(permissionRows, role);
          if (!canAccess(role, "page_sales_report", permissionMap)) {
            throw new CompanyAccessError(
              403,
              `You do not have Sales Report access in ${company.name}`,
              "COMPANY_REPORT_ACCESS_DENIED"
            );
          }
        }

        const locationIds = await resolveStockInSalesLocationIds({
          companyId,
          userId,
          role,
          currentLocationId:
            companyId === activeCompanyId ? req.session.currentLocationId : (assignment?.assignedLocationId ?? null),
          requestedLocationIds: [],
        });

        const breakdown = await runWithDatabaseScopeRuntimeContext(
          createTenantDatabaseScope(activeCompanyId, [companyId], "authorized-companies"),
          () =>
            getItemMarketSalePriceBreakdown({
              companyId,
              stockItemId: parsed.data.stockItemId,
              locationIds,
              startDate: parsed.data.startDate,
              endDate: parsed.data.endDate,
            })
        );

        res.setHeader("Cache-Control", "private, no-store");
        return res.json(breakdown);
      } catch (error: unknown) {
        if (error instanceof CompanyAccessError) {
          return sendCompanyAccessError(res, error);
        }
        if (error instanceof StockInSalesLocationAccessError) {
          return res.status(error.statusCode).json({ message: error.message });
        }
        logger.error("Item market sale price breakdown error", {
          module: "reports",
          action: "item-market-sale-price-breakdown",
          companyId: activeCompanyId,
          error,
        });
        return res.status(500).json({ message: "Failed to load item sale price breakdown" });
      }
    }
  );

  // Batched drill-down used only on user-initiated Excel export. Every company
  // and its allowed locations are verified exactly as in the report endpoint.
  app.post(
    "/api/reports/item-market-analysis/export-sale-prices",
    requireAuth,
    requireNonPOS,
    reportPageAccess,
    async (req, res) => {
      const activeCompanyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      const activeRole = req.session.currentRole;
      if (!activeCompanyId || !userId || !activeRole) {
        return res.status(400).json({ message: "An active company session is required" });
      }
      const parsed = exportSalePricesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid sale-price export filters", errors: parsed.error.flatten() });
      }
      const { startDate, endDate, companyItems } = parsed.data;
      if (startDate && endDate && startDate > endDate) {
        return res.status(400).json({ message: "Start date cannot be after end date" });
      }
      const companyIds = companyItems.map((entry) => entry.companyId);
      if (
        new Set(companyIds).size !== companyIds.length ||
        companyItems.reduce((count, entry) => count + entry.stockItemIds.length, 0) > 10000
      ) {
        return res.status(400).json({ message: "Invalid or repeated companies or too many item IDs" });
      }

      try {
        await assertCompaniesAccess(userId, companyIds);
        const companyResult = await pool.query<{ id: number; name: string; company_type: string | null }>(
          `SELECT id, name, company_type FROM companies
            WHERE id = ANY($1::int[]) AND active = true`,
          [companyIds]
        );
        const byId = new Map(companyResult.rows.map((company) => [Number(company.id), company]));
        if (byId.size !== companyIds.length) {
          return res.status(404).json({ message: "One or more companies could not be found" });
        }
        if ([...byId.values()].some((company) => String(company.company_type || "erp") !== "erp")) {
          return res.status(403).json({ message: "Item Market Analysis is available for ERP companies only" });
        }

        const rows = await runWithDatabaseScopeRuntimeContext(
          createTenantDatabaseScope(activeCompanyId, companyIds, "authorized-companies"),
          async () => {
            const result = [];
            for (const entry of companyItems) {
              const company = byId.get(entry.companyId)!;
              const assignment =
                entry.companyId === activeCompanyId
                  ? undefined
                  : await storage.getUserCompanyRole(userId, entry.companyId);
              const role =
                entry.companyId === activeCompanyId
                  ? activeRole
                  : (assignment?.role ?? (activeRole === "Developer" ? "Developer" : null));

              if (!role || role === "POS") {
                throw new CompanyAccessError(
                  403,
                  `You do not have report access to ${company.name}`,
                  "COMPANY_REPORT_ACCESS_DENIED"
                );
              }
              if (role !== "Developer" && role !== "Admin") {
                const permissions = await storage.getRoleFeaturePermissions(entry.companyId);
                if (!canAccess(role, "page_sales_report", buildPermissionMap(permissions, role))) {
                  throw new CompanyAccessError(
                    403,
                    `You do not have Sales Report access in ${company.name}`,
                    "COMPANY_REPORT_ACCESS_DENIED"
                  );
                }
              }

              const locationIds = await resolveStockInSalesLocationIds({
                companyId: entry.companyId,
                userId,
                role,
                currentLocationId:
                  entry.companyId === activeCompanyId
                    ? req.session.currentLocationId
                    : (assignment?.assignedLocationId ?? null),
                requestedLocationIds: [],
              });
              const breakdown = await getItemMarketBulkSalePrices({
                companyId: entry.companyId,
                stockItemIds: [...new Set(entry.stockItemIds)],
                locationIds,
                startDate,
                endDate,
              });
              result.push(...breakdown);
            }
            return result;
          }
        );
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({ rows });
      } catch (error: unknown) {
        if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
        if (error instanceof StockInSalesLocationAccessError) {
          return res.status(error.statusCode).json({ message: error.message });
        }
        logger.error("Item market Excel sale-price export error", {
          module: "reports",
          action: "item-market-export-sale-prices",
          companyId: activeCompanyId,
          error,
        });
        return res.status(500).json({ message: "Failed to export item sale price breakdown" });
      }
    }
  );
  return { reportPageAccess };
}
