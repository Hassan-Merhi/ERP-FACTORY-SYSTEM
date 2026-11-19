import type { Express } from "express";
import { z } from "zod";

import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { getStockInSalesComparison } from "../../services/reports/stockInSalesComparisonService";
import { getStockInSalesMovementDetails } from "../../services/reports/stockInSalesMovementDetailService";
import {
  registerStockInSalesReportRoutesPart1,
  isoDateSchema,
  idListSchema,
  detailQuerySchema,
  firstQueryValue,
  invalidRange,
  locationAccessResponse,
  resolveRequestLocationIds,
} from "./registerStockInSalesReportRoutesPart1";

const movementQuerySchema = detailQuerySchema.pick({
  startDate: true,
  endDate: true,
  locationIds: true,
  stockGroupIds: true,
  search: true,
  exportAll: true,
});

const comparisonQuerySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  grouping: z.enum(["daily", "monthly", "yearly"]).default("yearly"),
  search: z.string().trim().max(100, "Search is too long").optional(),
  sideALocationId: z.coerce.number().int().positive(),
  sideAStockGroupIds: idListSchema,
  sideBLocationId: z.coerce.number().int().positive(),
  sideBStockGroupIds: idListSchema,
});

export function registerStockInSalesReportRoutes(app: Express) {
  const { reportPageAccess } = registerStockInSalesReportRoutesPart1(app);

  app.get("/api/reports/stock-in-sales/movements", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const parsed = movementQuerySchema.safeParse({
      startDate: firstQueryValue(req.query.startDate),
      endDate: firstQueryValue(req.query.endDate),
      locationIds: req.query.locationIds ?? req.query.locationId,
      stockGroupIds: req.query.stockGroupIds ?? req.query.stockGroupId,
      search: firstQueryValue(req.query.search),
      exportAll: req.query.exportAll,
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid inventory movement filters", errors: parsed.error.flatten() });
    }
    if (invalidRange(parsed.data.startDate, parsed.data.endDate)) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      const locationIds = await resolveRequestLocationIds(req, parsed.data.locationIds);
      const result = await getStockInSalesMovementDetails({
        companyId,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        locationIds,
        stockGroupIds: parsed.data.stockGroupIds,
        search: parsed.data.search || undefined,
        exportAll: parsed.data.exportAll,
      });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error: unknown) {
      if (locationAccessResponse(error, res)) return;
      logger.error("Stock in and sales movement detail error", {
        module: "reports",
        action: "stock-in-sales-movements",
        companyId,
        error,
      });
      return res.status(500).json({ message: "Failed to load inventory movements" });
    }
  });

  app.get("/api/reports/stock-in-sales/comparison", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const parsed = comparisonQuerySchema.safeParse({
      startDate: firstQueryValue(req.query.startDate),
      endDate: firstQueryValue(req.query.endDate),
      grouping: firstQueryValue(req.query.grouping),
      search: firstQueryValue(req.query.search),
      sideALocationId: firstQueryValue(req.query.sideALocationId),
      sideAStockGroupIds: req.query.sideAStockGroupIds,
      sideBLocationId: firstQueryValue(req.query.sideBLocationId),
      sideBStockGroupIds: req.query.sideBStockGroupIds,
    });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid stock in and sales comparison filters", errors: parsed.error.flatten() });
    }
    if (invalidRange(parsed.data.startDate, parsed.data.endDate)) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      await resolveRequestLocationIds(req, [parsed.data.sideALocationId, parsed.data.sideBLocationId]);
      const result = await getStockInSalesComparison({
        companyId,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        grouping: parsed.data.grouping,
        search: parsed.data.search || undefined,
        sideA: { locationId: parsed.data.sideALocationId, stockGroupIds: parsed.data.sideAStockGroupIds },
        sideB: { locationId: parsed.data.sideBLocationId, stockGroupIds: parsed.data.sideBStockGroupIds },
      });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error: unknown) {
      if (locationAccessResponse(error, res)) return;
      logger.error("Stock in and sales comparison error", {
        module: "reports",
        action: "stock-in-sales-comparison",
        companyId,
        error,
      });
      return res.status(500).json({ message: "Failed to compare stock in and sales" });
    }
  });
}
