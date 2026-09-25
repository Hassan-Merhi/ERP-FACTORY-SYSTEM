import type { Express } from "express";
import { z } from "zod";

import { pool } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { requirePageAccess } from "../../lib/permissionMiddleware";
import { getItemMarketAnalysis } from "../../services/reports/itemMarketAnalysisService";
import {
  resolveStockInSalesLocationIds,
  StockInSalesLocationAccessError,
} from "../../services/reports/stockInSalesLocationAccess";

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
});

const first = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value[0] == null
      ? undefined
      : String(value[0])
    : typeof value === "string"
      ? value
      : undefined;

export function registerItemMarketAnalysisRoutes(app: Express) {
  const reportPageAccess = requirePageAccess("page_sales_report");

  app.get("/api/reports/item-market-analysis", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    const userId = req.session.userId;
    const role = req.session.currentRole;
    if (!companyId || !userId || !role) {
      return res.status(400).json({ message: "An active company session is required" });
    }

    const parsed = querySchema.safeParse({
      startDate: first(req.query.startDate),
      endDate: first(req.query.endDate),
      search: first(req.query.search),
      country: first(req.query.country),
      stockGroupId: first(req.query.stockGroupId),
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid item market analysis filters", errors: parsed.error.flatten() });
    }
    if (parsed.data.startDate && parsed.data.endDate && parsed.data.startDate > parsed.data.endDate) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      const company = await pool.query("SELECT company_type FROM companies WHERE id = $1 LIMIT 1", [companyId]);
      if (company.rows[0]?.company_type !== "erp") {
        return res.status(403).json({ message: "Item Market Analysis is available for ERP companies only" });
      }

      const locationIds = await resolveStockInSalesLocationIds({
        companyId,
        userId,
        role,
        currentLocationId: req.session.currentLocationId,
        requestedLocationIds: [],
      });

      const [analysis, countriesResult] = await Promise.all([
        getItemMarketAnalysis({
          companyId,
          locationIds,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          search: parsed.data.search || undefined,
          country: parsed.data.country || undefined,
          stockGroupId: parsed.data.stockGroupId,
        }),
        pool.query(
          `SELECT DISTINCT COALESCE(NULLIF(BTRIM(country), ''), 'Unknown Country') AS country
           FROM locations
           WHERE company_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL
           ORDER BY country`,
          [companyId, locationIds]
        ),
      ]);

      res.setHeader("Cache-Control", "private, no-store");
      return res.json({
        ...analysis,
        countries: countriesResult.rows.map((row) => String(row.country)),
      });
    } catch (error: unknown) {
      if (error instanceof StockInSalesLocationAccessError) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      logger.error("Item market analysis error", {
        module: "reports",
        action: "item-market-analysis",
        companyId,
        error,
      });
      return res.status(500).json({ message: "Failed to generate item market analysis" });
    }
  });
}
