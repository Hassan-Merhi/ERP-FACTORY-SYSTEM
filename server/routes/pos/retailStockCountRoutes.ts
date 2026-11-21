/**
 * Retail Wave 2 — physical stock-count sessions (Track D).
 *
 * Counting is a store-floor activity, so retail-company users (including the POS role) can
 * create sessions, scan, type quantities, flag recounts and move to review. Finalizing —
 * which writes `stock_count` inventory movements — and canceling require a non-POS role,
 * matching the stock-adjustment rule already enforced elsewhere.
 */
import type { Express } from "express";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  cancelRetailStockCount,
  finalizeRetailStockCount,
  loadRetailStockCountSession,
  moveRetailStockCountToReview,
  recountRetailStockCountLines,
  recordRetailStockCountEntry,
  updateRetailStockCountLine,
} from "../../services/retail/retailStockCount";
import { currentUserId, requireRetailCompany } from "./retailPosContext";
import { registerRetailStockCountRoutesPart1, respondStockCountError } from "./registerRetailStockCountRoutesPart1";

const lineSchema = z.object({
  countedQuantity: z.coerce.number().finite().nonnegative().optional(),
  recountRequired: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const finalizeSchema = z.object({
  allowUncounted: z.boolean().optional(),
  confirmVariance: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export function registerRetailStockCountRoutes(app: Express): void {
  registerRetailStockCountRoutesPart1(app);

  app.patch("/api/pos/retail/stock-counts/:id/lines/:lineId", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      const lineId = Number(req.params.lineId);
      if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(lineId) || lineId <= 0) {
        return res.status(400).json({ message: "Invalid stock count line" });
      }
      const body = lineSchema.parse(req.body ?? {});
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
  });

  app.post("/api/pos/retail/stock-counts/:id/review", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const notes = z.object({ notes: z.string().trim().max(2000).nullable().optional() }).parse(req.body ?? {}).notes;
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

  app.post("/api/pos/retail/stock-counts/:id/recount", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const body = z
        .object({
          lineIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
          notes: z.string().trim().max(2000).nullable().optional(),
        })
        .parse(req.body ?? {});
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

  app.post("/api/pos/retail/stock-counts/:id/finalize", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const body = finalizeSchema.parse(req.body ?? {});
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
  });

  app.post("/api/pos/retail/stock-counts/:id/cancel", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ message: "Invalid session" });
      const reason = z
        .object({ reason: z.string().trim().max(500).nullable().optional() })
        .parse(req.body ?? {}).reason;
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
  });
}
