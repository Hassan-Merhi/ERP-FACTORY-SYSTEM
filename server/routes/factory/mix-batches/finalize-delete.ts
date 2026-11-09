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
import { factoryRawStock, factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import { toMoney } from "../../../lib/money";
import { MixLifecycleRefusal, requireMixFinalizeDecision } from "../../../services/factory/mixLifecyclePhase6";

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
        const [batch] = await tx.select().from(factoryMixBatches).where(and(
          eq(factoryMixBatches.id, id),
          eq(factoryMixBatches.companyId, companyId),
          isNull(factoryMixBatches.deletedAt),
        )).for("update");
        if (!batch) throw new MixLifecycleRefusal("Mix batch is missing or deleted.", 404);
        const { remainingKg, wasteReason } = requireMixFinalizeDecision(batch, req.body);
        return withFactoryValuationEventTx(
          tx, companyId, "WASTE",
          { sourceType: "factory-mix-batch-finalize", sourceId: id },
          async () => {
            const [record] = await tx.update(factoryMixBatches).set({
              usedKg: batch.totalWeightKg,
              status: "COMPLETED",
              updatedAt: new Date(),
            }).where(and(
              eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId),
              isNull(factoryMixBatches.deletedAt),
            )).returning();
            if (!record) throw new MixLifecycleRefusal("Finalization state changed; review and retry.");
            await logAudit({
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
            }, tx);
            return record;
          },
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

  app.delete("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // Soft-delete: also reverse the usedKg this batch consumed from its sources
      // (raw stock containers and/or upstream batches) so the material becomes
      // available again in Raw Materials stock. Previously this reversal never
      // happened, so deleting a batch permanently "lost" its consumed stock.
      //
      // Wave 11: deleting a mix undoes its creation (raw material back at its
      // landed USD cost, the mix's work in progress gone), so the change of the
      // factory valuation is the reverse of the material price variance the
      // create recorded, and is tagged MATERIAL_PRICE as the create was.
      const result = await db.transaction((tx) =>
        withFactoryValuationEventTx(
          tx,
          companyId,
          "MATERIAL_PRICE",
          { sourceType: "factory-mix-batch-delete", sourceId: id },
          async () => {
            const [updated] = await tx
              .update(factoryMixBatches)
              .set({ deletedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(factoryMixBatches.id, id),
                  eq(factoryMixBatches.companyId, companyId),
                  isNull(factoryMixBatches.deletedAt)
                )
              )
              .returning({ id: factoryMixBatches.id });

            if (!updated) return null;

            const batchSourceRows = await tx
              .select({
                containerId: factoryMixBatchSources.containerId,
                sourceBatchId: factoryMixBatchSources.sourceBatchId,
                weightKg: factoryMixBatchSources.weightKg,
              })
              .from(factoryMixBatchSources)
              .where(eq(factoryMixBatchSources.mixBatchId, id));

            for (const src of batchSourceRows) {
              const weight = toMoney(src.weightKg).toNumber();
              if (weight <= 0) continue;
              if (src.containerId) {
                // Reverse consumption on the underlying raw-stock container. Scoped to
                // companyId too so a corrupted/cross-tenant containerId can never
                // mutate another company's raw stock. GREATEST(...,0) is a defensive
                // floor only — the restore path in deletedItemsRoutes.ts re-adds the
                // same `weight` (not a clamped value), so a normal delete→restore
                // round trip is exact as long as usedKg wasn't already corrupted below
                // this batch's own contribution.
                await tx
                  .update(factoryRawStock)
                  .set({ usedKg: sql`GREATEST(${factoryRawStock.usedKg} - ${weight}, 0)` })
                  .where(
                    and(eq(factoryRawStock.containerId, src.containerId), eq(factoryRawStock.companyId, companyId))
                  );
              } else if (src.sourceBatchId) {
                // Reverse consumption on the upstream batch this batch topped up from.
                await tx
                  .update(factoryMixBatches)
                  .set({ usedKg: sql`GREATEST(${factoryMixBatches.usedKg} - ${weight}, 0)`, updatedAt: new Date() })
                  .where(and(eq(factoryMixBatches.id, src.sourceBatchId), eq(factoryMixBatches.companyId, companyId)));
              }
            }

            // Phase 21 (B): the delete audit commits with the delete.
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || req.session.userId!,
                companyId,
                action: "delete",
                tableName: "factory_mix_batches",
                recordId: id,
                recordIdentifier: `Mix Batch #${id}`,
                changes: null,
              },
              tx
            );
            return updated;
          }
        )
      );

      if (!result) return res.status(404).json({ message: "Mix batch not found" });
      res.json({ id: result.id, message: "Mix batch moved to Deleted Items" });
    } catch (error: unknown) {
      logger.error("Error deleting mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
