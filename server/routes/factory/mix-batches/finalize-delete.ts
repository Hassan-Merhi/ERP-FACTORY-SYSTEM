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
import {
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  factoryPressingBatches,
  factoryDailyUsages,
} from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import { toMoney } from "../../../lib/money";
import {
  MixLifecycleRefusal,
  requireMixFinalizeDecision,
  requireMixDeletionSafe,
} from "../../../services/factory/mixLifecyclePhase6";

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
      const result = await db.transaction(async (tx) => {
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
        if (!batch) return null;
        const [children, downstreamSources, bales, pressing, usages] = await Promise.all([
          tx
            .select({ id: factoryMixBatches.id })
            .from(factoryMixBatches)
            .where(
              and(
                eq(factoryMixBatches.companyId, companyId),
                eq(factoryMixBatches.carryForwardFromId, id),
                isNull(factoryMixBatches.deletedAt)
              )
            )
            .limit(1),
          // Source rows of a soft-deleted downstream mix are retained as history
          // after its consumption was reversed; only live owners are dependencies.
          tx
            .select({ id: factoryMixBatchSources.id })
            .from(factoryMixBatchSources)
            .innerJoin(factoryMixBatches, eq(factoryMixBatches.id, factoryMixBatchSources.mixBatchId))
            .where(and(eq(factoryMixBatchSources.sourceBatchId, id), isNull(factoryMixBatches.deletedAt)))
            .limit(1),
          tx
            .select({ id: factoryBales.id })
            .from(factoryBales)
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                eq(factoryBales.mixBatchId, id),
                isNull(factoryBales.deletedAt)
              )
            )
            .limit(1),
          tx
            .select({ id: factoryPressingBatches.id })
            .from(factoryPressingBatches)
            .where(and(eq(factoryPressingBatches.companyId, companyId), eq(factoryPressingBatches.mixBatchId, id)))
            .limit(1),
          tx
            .select({ id: factoryDailyUsages.id })
            .from(factoryDailyUsages)
            .where(and(eq(factoryDailyUsages.companyId, companyId), eq(factoryDailyUsages.mixBatchId, id)))
            .limit(1),
        ]);
        requireMixDeletionSafe(
          batch,
          [children, downstreamSources, bales, pressing, usages].some((rows) => rows.length > 0)
        );
        return withFactoryValuationEventTx(
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
              const weight = toMoney(src.weightKg);
              if (!weight.isFinite() || weight.lte(0)) {
                throw new MixLifecycleRefusal(
                  "Historical mix has an invalid source quantity; deletion requires a reviewed source correction."
                );
              }
              if (src.containerId != null) {
                // A source has only a container ID, not the raw-stock row ID.
                // Reverse only when that original row is uniquely identifiable.
                // Never decrement every row sharing a container or clamp usage.
                const rawRows = await tx
                  .select({
                    id: factoryRawStock.id,
                    usedKg: factoryRawStock.usedKg,
                  })
                  .from(factoryRawStock)
                  .where(
                    and(
                      eq(factoryRawStock.companyId, companyId),
                      eq(factoryRawStock.containerId, src.containerId),
                      isNull(factoryRawStock.deletedAt)
                    )
                  )
                  .for("update");
                if (rawRows.length !== 1) {
                  throw new MixLifecycleRefusal(
                    "Cannot reverse mix source container #" +
                      src.containerId +
                      ": its physical raw-stock allocation is missing or ambiguous."
                  );
                }
                const currentUsed = toMoney(rawRows[0].usedKg);
                if (currentUsed.lt(weight)) {
                  throw new MixLifecycleRefusal(
                    "Cannot reverse mix source container #" +
                      src.containerId +
                      ": recorded usage is lower than the source kg. No negative or clamped stock change was applied."
                  );
                }
                await tx
                  .update(factoryRawStock)
                  .set({ usedKg: currentUsed.minus(weight).toFixed(3) })
                  .where(and(eq(factoryRawStock.id, rawRows[0].id), eq(factoryRawStock.companyId, companyId)));
              } else if (src.sourceBatchId != null) {
                const [parent] = await tx
                  .select({
                    id: factoryMixBatches.id,
                    totalWeightKg: factoryMixBatches.totalWeightKg,
                    usedKg: factoryMixBatches.usedKg,
                    status: factoryMixBatches.status,
                  })
                  .from(factoryMixBatches)
                  .where(
                    and(
                      eq(factoryMixBatches.id, src.sourceBatchId),
                      eq(factoryMixBatches.companyId, companyId),
                      isNull(factoryMixBatches.deletedAt)
                    )
                  )
                  .for("update");
                if (!parent || parent.status === "COMPLETED" || toMoney(parent.usedKg).lt(weight)) {
                  throw new MixLifecycleRefusal("Upstream mix quantity/status cannot be exactly reversed.");
                }
                const nextUsed = toMoney(parent.usedKg).minus(weight);
                await tx
                  .update(factoryMixBatches)
                  .set({
                    usedKg: nextUsed.toFixed(3),
                    status:
                      parent.status === "CLOSED" && nextUsed.lt(toMoney(parent.totalWeightKg))
                        ? "ACTIVE"
                        : parent.status,
                    updatedAt: new Date(),
                  })
                  .where(and(eq(factoryMixBatches.id, parent.id), eq(factoryMixBatches.companyId, companyId)));
              } else {
                // No container or upstream batch = no exact raw-stock attribution.
                // Supplier-only manual material must use a reviewed reconciliation.
                throw new MixLifecycleRefusal(
                  "A supplier-only historical source has no exact raw-stock or batch attribution; ordinary deletion is unsafe."
                );
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
        );
      });

      if (!result) return res.status(404).json({ message: "Mix batch not found" });
      res.json({ id: result.id, message: "Mix batch moved to Deleted Items" });
    } catch (error: unknown) {
      if (error instanceof MixLifecycleRefusal) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      logger.error("Error deleting mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
