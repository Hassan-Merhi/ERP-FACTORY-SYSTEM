// Extracted from ./retailStockCountRoutes.ts
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { retailProductVariants, retailProducts } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { toCsv } from "../../services/retail/retailVariantReports";
import {
  createRetailStockCountSession,
  listRetailStockCountSessions,
  loadRetailStockCountSession,
  loadRetailStockCountVarianceReport,
  recordRetailStockCountEntry,
  RetailStockCountConflictError,
  RetailStockCountValidationError,
  startRetailStockCountSession,
} from "../../services/retail/retailStockCount";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";

const createSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  notes: z.string().trim().max(2000).nullable().optional(),
  includeAllVariants: z.boolean().optional(),
  startNow: z.boolean().optional(),
});

const scanSchema = z
  .object({
    barcode: z.string().trim().min(1).max(191).optional(),
    variantId: z.coerce.number().int().positive().optional(),
    quantity: z.coerce.number().finite().positive().optional(),
    mode: z.enum(["increment", "set"]).optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Boolean(value.barcode) || Boolean(value.variantId), {
    message: "A barcode or variant is required",
  });

const SESSION_COUNT_COLUMNS = [
  { key: "code", label: "Session" },
  { key: "status", label: "Status" },
  { key: "locationName", label: "Location" },
  { key: "snapshotAt", label: "Snapshot at" },
  { key: "finalizedAt", label: "Finalized at" },
  { key: "lineCount", label: "Lines" },
  { key: "countedLineCount", label: "Counted" },
  { key: "uncountedLineCount", label: "Uncounted" },
  { key: "varianceLineCount", label: "Variance lines" },
  { key: "unexpectedLineCount", label: "Unexpected" },
  { key: "expectedQuantityTotal", label: "Expected qty" },
  { key: "countedQuantityTotal", label: "Counted qty" },
  { key: "varianceQuantityTotal", label: "Variance qty" },
  { key: "varianceValueTotal", label: "Variance value" },
];

function sendCsv(res: Parameters<Parameters<Express["get"]>[1]>[1], name: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}

export function respondStockCountError(res: Parameters<Parameters<Express["post"]>[1]>[1], error: unknown): void {
  if (error instanceof RetailStockCountConflictError) {
    res.status(409).json({ message: error.message, code: error.code, details: error.details });
    return;
  }
  if (error instanceof RetailStockCountValidationError) {
    res.status(400).json({ message: error.message });
    return;
  }
  const message = getErrorMessage(error);
  res.status(message.includes("not found") ? 404 : 400).json({ message });
}

export function registerRetailStockCountRoutesPart1(app: Express) {
  app.get("/api/pos/retail/stock-counts", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const sessions = await listRetailStockCountSessions(companyId, {
        locationId: Number.isInteger(locationId) && locationId > 0 ? locationId : undefined,
        status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
        from: typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : undefined,
        to: typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : undefined,
        limit: Number(req.query.limit) || undefined,
      });
      res.json(sessions);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** History + variance report, optionally as CSV. Registered before `/:id`. */
  app.get("/api/pos/retail/stock-counts/report", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const sessions = await listRetailStockCountSessions(companyId, {
        locationId: Number.isInteger(locationId) && locationId > 0 ? locationId : undefined,
        status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
        from: typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : undefined,
        to: typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : undefined,
        limit: 200,
      });
      if (req.query.format === "csv") {
        return sendCsv(
          res,
          "retail-stock-counts",
          toCsv(sessions as unknown as Array<Record<string, unknown>>, SESSION_COUNT_COLUMNS)
        );
      }
      res.json({
        sessions,
        summary: {
          sessionCount: sessions.length,
          finalizedCount: sessions.filter((session) => session.status === "finalized").length,
          varianceQuantityTotal: sessions.reduce((sum, session) => sum + Number(session.varianceQuantityTotal ?? 0), 0),
          varianceValueTotal: sessions.reduce((sum, session) => sum + Number(session.varianceValueTotal ?? 0), 0),
        },
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/stock-counts", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = createSchema.parse(req.body ?? {});
      await ensureCompanyLocation(companyId, body.locationId);
      const session = await createRetailStockCountSession({
        companyId,
        locationId: body.locationId,
        userId: currentUserId(req),
        notes: body.notes ?? null,
        includeAllVariants: body.includeAllVariants,
        startNow: body.startNow !== false,
      });
      res.status(201).json(session);
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.get("/api/pos/retail/stock-counts/:id", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const session = await loadRetailStockCountSession(companyId, sessionId);
      if (!session) return res.status(404).json({ message: "Stock count session not found" });
      res.json(session);
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.get("/api/pos/retail/stock-counts/:id/variance", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const report = await loadRetailStockCountVarianceReport(companyId, sessionId);
      if (!report) return res.status(404).json({ message: "Stock count session not found" });
      res.json(report);
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.post("/api/pos/retail/stock-counts/:id/start", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const includeAllVariants = z
        .object({ includeAllVariants: z.boolean().optional() })
        .parse(req.body ?? {}).includeAllVariants;
      const result = await startRetailStockCountSession({
        companyId,
        sessionId,
        userId: currentUserId(req),
        includeAllVariants,
      });
      res.json({ ...result, session: await loadRetailStockCountSession(companyId, sessionId) });
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.post("/api/pos/retail/stock-counts/:id/scan", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const body = scanSchema.parse(req.body ?? {});
      let variantId = body.variantId ?? null;
      if (!variantId && body.barcode) {
        const [variant] = await db
          .select({ id: retailProductVariants.id })
          .from(retailProductVariants)
          .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
          .where(
            and(
              eq(retailProductVariants.barcode, body.barcode),
              eq(retailProductVariants.companyId, companyId),
              eq(retailProducts.companyId, companyId)
            )
          )
          .limit(1);
        if (!variant) {
          return res.status(404).json({ message: `No retail variant matches barcode ${body.barcode}` });
        }
        variantId = variant.id;
      }
      if (!variantId) return res.status(400).json({ message: "A barcode or variant is required" });
      const result = await recordRetailStockCountEntry({
        companyId,
        sessionId,
        userId: currentUserId(req),
        variantId,
        quantity: body.quantity ?? 1,
        mode: body.mode ?? "increment",
        note: body.note ?? null,
      });
      res.json(result);
    } catch (error) {
      respondStockCountError(res, error);
    }
  });
}
