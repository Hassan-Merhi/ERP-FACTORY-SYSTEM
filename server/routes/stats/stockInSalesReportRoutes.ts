import type { Express } from "express";
import { z } from "zod";

import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { requirePageAccess } from "../../lib/permissionMiddleware";
import { getStockInSalesComparison } from "../../services/reports/stockInSalesComparisonService";
import { getStockInSalesDetail } from "../../services/reports/stockInSalesDetailService";
import {
  resolveStockInSalesLocationIds,
  StockInSalesLocationAccessError,
} from "../../services/reports/stockInSalesLocationAccess";
import { getStockInSalesMovementDetails } from "../../services/reports/stockInSalesMovementDetailService";
import {
  applyOutboundBreakdown,
  getStockInSalesOutboundBreakdown,
} from "../../services/reports/stockInSalesOutboundBreakdown";
import {
  attachStockInSalesReconciliation,
  getStockInSalesReconciliation,
} from "../../services/reports/stockInSalesReconciliation";
import { getStockInSalesReport } from "../../services/reports/stockInSalesReportService";

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "Date is invalid");

const idListSchema = z
  .preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") return [];
      const values = Array.isArray(value) ? value : [value];
      return values
        .flatMap((entry) => String(entry).split(","))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(Number);
    },
    z.array(z.number().int().positive()).max(100, "Too many filter values")
  )
  .transform((ids) => Array.from(new Set(ids)));

const reportQuerySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  grouping: z.enum(["daily", "monthly", "yearly"]).default("daily"),
  profitFilter: z.enum(["all", "positive", "negative"]).default("all"),
  locationIds: idListSchema,
  stockGroupIds: idListSchema,
  search: z.string().trim().max(100, "Search is too long").optional(),
});

const detailQuerySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  locationIds: idListSchema,
  stockGroupIds: idListSchema,
  search: z.string().trim().max(100, "Search is too long").optional(),
  stockInPage: z.coerce.number().int().positive().max(100_000).default(1),
  stockOutPage: z.coerce.number().int().positive().max(100_000).default(1),
  limit: z.coerce.number().int().min(25).max(250).default(100),
  exportAll: z.preprocess((value) => value === "true" || value === "1" || value === true, z.boolean()).default(false),
});

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

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  if (typeof value === "string") return value;
  return undefined;
}

function invalidRange(startDate: string | undefined, endDate: string | undefined): boolean {
  return !!startDate && !!endDate && startDate > endDate;
}

function locationAccessResponse(error: unknown, res: import("express").Response): boolean {
  if (!(error instanceof StockInSalesLocationAccessError)) return false;
  res.status(error.statusCode).json({ message: error.message });
  return true;
}

async function resolveRequestLocationIds(req: import("express").Request, requestedLocationIds: number[]): Promise<number[]> {
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;
  const role = req.session.currentRole;
  if (!companyId || !userId || !role) {
    throw new StockInSalesLocationAccessError("An active company session is required");
  }

  return resolveStockInSalesLocationIds({
    companyId,
    userId,
    role,
    currentLocationId: req.session.currentLocationId,
    requestedLocationIds,
  });
}

export function registerStockInSalesReportRoutes(app: Express) {
  const reportPageAccess = requirePageAccess("page_sales_report");

  app.get("/api/reports/stock-in-sales", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const parsed = reportQuerySchema.safeParse({
      startDate: firstQueryValue(req.query.startDate),
      endDate: firstQueryValue(req.query.endDate),
      grouping: firstQueryValue(req.query.grouping),
      profitFilter: firstQueryValue(req.query.profitFilter),
      locationIds: req.query.locationIds ?? req.query.locationId,
      stockGroupIds: req.query.stockGroupIds ?? req.query.stockGroupId,
      search: firstQueryValue(req.query.search),
    });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid stock in and sales report filters", errors: parsed.error.flatten() });
    }
    if (invalidRange(parsed.data.startDate, parsed.data.endDate)) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      const locationIds = await resolveRequestLocationIds(req, parsed.data.locationIds);
      const reportFilters = {
        companyId,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        grouping: parsed.data.grouping,
        profitFilter: parsed.data.profitFilter,
        locationIds,
        stockGroupIds: parsed.data.stockGroupIds,
        search: parsed.data.search || undefined,
      };
      const [baseResult, outboundBreakdown] = await Promise.all([
        getStockInSalesReport(reportFilters),
        getStockInSalesOutboundBreakdown(reportFilters),
      ]);
      const outboundResult = applyOutboundBreakdown(baseResult, outboundBreakdown);
      const reconciliation = await getStockInSalesReconciliation(reportFilters, outboundResult);
      const result = attachStockInSalesReconciliation(outboundResult, reconciliation);

      res.setHeader("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error: unknown) {
      if (locationAccessResponse(error, res)) return;
      logger.error("Stock in and sales report error", {
        module: "reports",
        action: "stock-in-sales",
        companyId,
        error,
      });
      return res.status(500).json({ message: "Failed to generate stock in and sales report" });
    }
  });

  app.get("/api/reports/stock-in-sales/detail", requireAuth, requireNonPOS, reportPageAccess, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const parsed = detailQuerySchema.safeParse({
      startDate: firstQueryValue(req.query.startDate),
      endDate: firstQueryValue(req.query.endDate),
      locationIds: req.query.locationIds ?? req.query.locationId,
      stockGroupIds: req.query.stockGroupIds ?? req.query.stockGroupId,
      search: firstQueryValue(req.query.search),
      stockInPage: firstQueryValue(req.query.stockInPage),
      stockOutPage: firstQueryValue(req.query.stockOutPage),
      limit: firstQueryValue(req.query.limit),
      exportAll: req.query.exportAll,
    });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid stock in and sales detail filters", errors: parsed.error.flatten() });
    }
    if (invalidRange(parsed.data.startDate, parsed.data.endDate)) {
      return res.status(400).json({ message: "Start date cannot be after end date" });
    }

    try {
      const locationIds = await resolveRequestLocationIds(req, parsed.data.locationIds);
      const detailFilters = {
        companyId,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        locationIds,
        stockGroupIds: parsed.data.stockGroupIds,
        search: parsed.data.search || undefined,
      };
      const [result, outboundBreakdown] = await Promise.all([
        getStockInSalesDetail({
          ...detailFilters,
          stockInPage: parsed.data.stockInPage,
          stockOutPage: parsed.data.stockOutPage,
          limit: parsed.data.limit,
          exportAll: parsed.data.exportAll,
        }),
        getStockInSalesOutboundBreakdown({
          ...detailFilters,
          grouping: "daily",
          profitFilter: "all",
        }),
      ]);
      const costProfit = Number((result.summary.totalSales - result.summary.costOfSales).toFixed(2));
      const avgProfitPerBale =
        outboundBreakdown.summary.netSalesQty === 0
          ? 0
          : Number((costProfit / outboundBreakdown.summary.netSalesQty).toFixed(6));
      const enrichedResult = {
        ...result,
        summary: {
          ...result.summary,
          ...outboundBreakdown.summary,
          costProfit,
          avgProfitPerBale,
        },
      };
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(enrichedResult);
    } catch (error: unknown) {
      if (locationAccessResponse(error, res)) return;
      logger.error("Stock in and sales detail error", {
        module: "reports",
        action: "stock-in-sales-detail",
        companyId,
        error,
      });
      return res.status(500).json({ message: "Failed to load stock in and sales details" });
    }
  });

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
