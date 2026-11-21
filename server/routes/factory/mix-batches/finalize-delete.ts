/**
 * factoryMixBatchRoutes: FactoryMixBatchFinalizeDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import { MixLifecycleRefusal, requireMixFinalizeDecision } from "../../../services/factory/mixLifecyclePhase6";
import { registerFactoryMixBatchFinalizeDeleteRoutesPart1 } from "./registerFactoryMixBatchFinalizeDeleteRoutesPart1";

export function registerFactoryMixBatchFinalizeDeleteRoutes(app: Express) {
  // ── Finalize a mix batch (mark as fully consumed/completed) ──
  app.post("/api/factory/mix-batches/:id/finalize", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // Re-read under the same transaction lock used for finalization.
      // Never convert a stale remainder into unreviewed waste.
      const updated = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(
            and(
              eq(factoryMixBatches.id, id),
              eq(factoryMixBatches.companyId, companyId),
              isNull(factoryMixBatches.deletedAt)
            )
          )
          .for("update");
        if (!batch) throw new MixLifecycleRefusal("Mix batch is missing or deleted.", 404);
        const { remainingKg, wasteReason } = requireMixFinalizeDecision(batch, req.body);
        return withFactoryValuationEventTx(
          tx,
          companyId,
          "WASTE",
          { sourceType: "factory-mix-batch-finalize", sourceId: id },
          async () => {
            const [record] = await tx
              .update(factoryMixBatches)
              .set({
                usedKg: batch.totalWeightKg,
                status: "COMPLETED",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(factoryMixBatches.id, id),
                  eq(factoryMixBatches.companyId, companyId),
                  isNull(factoryMixBatches.deletedAt)
                )
              )
              .returning();
            if (!record) throw new MixLifecycleRefusal("Finalization state changed; review and retry.");
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || req.session.userId!,
                companyId,
                action: "update",
                tableName: "factory_mix_batches",
                recordId: id,
                recordIdentifier: batch.batchCode,
                changes: {
                  status: { old: batch.status, new: "COMPLETED" },
                  usedKg: { old: batch.usedKg, new: batch.totalWeightKg },
                  confirmedWasteKg: { old: null, new: remainingKg.toFixed(3) },
                  wasteReason: { old: null, new: wasteReason },
                },
              },
              tx
            );
            return record;
          }
        );
      });
      res.json(updated);
    } catch (error: unknown) {
      if (error instanceof MixLifecycleRefusal) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      logger.error("Error finalizing mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryMixBatchFinalizeDeleteRoutesPart1(app);
}
