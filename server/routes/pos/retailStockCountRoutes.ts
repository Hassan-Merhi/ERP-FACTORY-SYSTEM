/**
 * Retail Wave 2 — physical stock-count sessions (Track D).
 *
 * Counting is a store-floor activity, so retail-company users (including the POS role) can
 * create sessions, scan, type quantities, flag recounts and move to review. Finalizing —
 * which writes `stock_count` inventory movements — and canceling require a non-POS role,
 * matching the stock-adjustment rule already enforced elsewhere.
 */
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { retailProductVariants, retailProducts } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  emptyQuery,
  idParams,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";
import { toCsv } from "../../services/retail/retailVariantReports";
import {
  cancelRetailStockCount,
  createRetailStockCountSession,
  finalizeRetailStockCount,
  listRetailStockCountSessions,
  loadRetailStockCountSession,
  loadRetailStockCountVarianceReport,
  moveRetailStockCountToReview,
  recountRetailStockCountLines,
  recordRetailStockCountEntry,
  RetailStockCountConflictError,
  RetailStockCountValidationError,
  startRetailStockCountSession,
  updateRetailStockCountLine,
} from "../../services/retail/retailStockCount";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";

const createSchema = z.strictObject({
  locationId: z.coerce.number().int().positive(),
  notes: z.string().trim().max(2000).nullable().optional(),
  includeAllVariants: z.boolean().optional(),
  startNow: z.boolean().optional(),
});

const scanSchema = z
  .strictObject({
    barcode: z.string().trim().min(1).max(191).optional(),
    variantId: z.coerce.number().int().positive().optional(),
    quantity: z.coerce.number().finite().positive().optional(),
    mode: z.enum(["increment", "set"]).optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Boolean(value.barcode) || Boolean(value.variantId), {
    message: "A barcode or variant is required",
  });

const lineSchema = z.strictObject({
  countedQuantity: z.coerce.number().finite().nonnegative().optional(),
  recountRequired: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const finalizeSchema = z.strictObject({
  allowUncounted: z.boolean().optional(),
  confirmVariance: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// Transitions with no required field may be posted with no body at all.
const sessionInput = <T extends z.ZodType>(body: T) =>
  ({ params: idParams, query: emptyQuery, body: body.optional() }) satisfies RequestSchemas;

const createInput = { query: emptyQuery, body: createSchema } satisfies RequestSchemas;
const startInput = sessionInput(z.strictObject({ includeAllVariants: z.boolean().optional() }));
const scanInput = { params: idParams, query: emptyQuery, body: scanSchema } satisfies RequestSchemas;
const lineInput = {
  params: z.strictObject({ id: positiveIntParam, lineId: positiveIntParam }),
  query: emptyQuery,
  body: lineSchema.optional(),
} satisfies RequestSchemas;
const reviewInput = sessionInput(z.strictObject({ notes: z.string().trim().max(2000).nullable().optional() }));
const recountInput = sessionInput(
  z.strictObject({
    lineIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
);
const finalizeInput = sessionInput(finalizeSchema);
const cancelInput = sessionInput(z.strictObject({ reason: z.string().trim().max(500).nullable().optional() }));

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

export function registerRetailStockCountRoutes(app: Express): void {
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

  app.post("/api/pos/retail/stock-counts", requireAuth, validateRequest(createInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = validatedInput(req, createInput).body;
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

  app.post("/api/pos/retail/stock-counts/:id/start", requireAuth, validateRequest(startInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const { params, body } = validatedInput(req, startInput);
      const sessionId = params.id;
      const includeAllVariants = body?.includeAllVariants;
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

  app.post("/api/pos/retail/stock-counts/:id/scan", requireAuth, validateRequest(scanInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const { params, body } = validatedInput(req, scanInput);
      const sessionId = params.id;
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

  app.patch(
    "/api/pos/retail/stock-counts/:id/lines/:lineId",
    requireAuth,
    validateRequest(lineInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;
        const { params } = validatedInput(req, lineInput);
        const sessionId = params.id;
        const lineId = params.lineId;
        const body = validatedInput(req, lineInput).body ?? {};
        if (body.countedQuantity !== undefined) {
          const session = await loadRetailStockCountSession(companyId, sessionId);
          if (!session) return res.status(404).json({ message: "Stock count session not found" });
          const line = session.lines.find((entry) => entry.id === lineId);
          if (!line) return res.status(404).json({ message: "Stock count line not found" });
          const entry = await recordRetailStockCountEntry({
            companyId,
            sessionId,
            userId: currentUserId(req),
            variantId: line.variantId,
            quantity: body.countedQuantity,
            mode: "set",
            note: body.notes ?? null,
          });
          if (body.recountRequired !== undefined) {
            await updateRetailStockCountLine({
              companyId,
              sessionId,
              lineId,
              userId: currentUserId(req),
              recountRequired: body.recountRequired,
              notes: body.notes ?? undefined,
            });
          }
          return res.json({ ...entry, recountRequired: body.recountRequired ?? line.recountRequired });
        }
        const result = await updateRetailStockCountLine({
          companyId,
          sessionId,
          lineId,
          userId: currentUserId(req),
          recountRequired: body.recountRequired,
          notes: body.notes,
        });
        res.json(result);
      } catch (error) {
        respondStockCountError(res, error);
      }
    }
  );

  app.post("/api/pos/retail/stock-counts/:id/review", requireAuth, validateRequest(reviewInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const { params, body } = validatedInput(req, reviewInput);
      const sessionId = params.id;
      const notes = body?.notes;
      const result = await moveRetailStockCountToReview({
        companyId,
        sessionId,
        userId: currentUserId(req),
        notes: notes ?? null,
      });
      res.json({ ...result, session: await loadRetailStockCountSession(companyId, sessionId) });
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.post("/api/pos/retail/stock-counts/:id/recount", requireAuth, validateRequest(recountInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const { params } = validatedInput(req, recountInput);
      const sessionId = params.id;
      const body = validatedInput(req, recountInput).body ?? {};
      const result = await recountRetailStockCountLines({
        companyId,
        sessionId,
        userId: currentUserId(req),
        lineIds: body.lineIds,
        notes: body.notes ?? null,
      });
      res.json({ ...result, session: await loadRetailStockCountSession(companyId, sessionId) });
    } catch (error) {
      respondStockCountError(res, error);
    }
  });

  app.post(
    "/api/pos/retail/stock-counts/:id/finalize",
    requireAuth,
    requireNonPOS,
    validateRequest(finalizeInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;
        const { params } = validatedInput(req, finalizeInput);
        const sessionId = params.id;
        const body = validatedInput(req, finalizeInput).body ?? {};
        const result = await finalizeRetailStockCount({
          companyId,
          sessionId,
          userId: currentUserId(req),
          allowUncounted: body.allowUncounted,
          confirmVariance: body.confirmVariance,
          notes: body.notes ?? null,
        });
        res
          .status(result.replayed ? 200 : 201)
          .json({ ...result, session: await loadRetailStockCountSession(companyId, sessionId) });
      } catch (error) {
        respondStockCountError(res, error);
      }
    }
  );

  app.post(
    "/api/pos/retail/stock-counts/:id/cancel",
    requireAuth,
    requireNonPOS,
    validateRequest(cancelInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;
        const { params, body } = validatedInput(req, cancelInput);
        const sessionId = params.id;
        const reason = body?.reason;
        const result = await cancelRetailStockCount({
          companyId,
          sessionId,
          userId: currentUserId(req),
          reason: reason ?? null,
        });
        res.json({ ...result, session: await loadRetailStockCountSession(companyId, sessionId) });
      } catch (error) {
        respondStockCountError(res, error);
      }
    }
  );
}

function respondStockCountError(res: Parameters<Parameters<Express["post"]>[1]>[1], error: unknown): void {
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
