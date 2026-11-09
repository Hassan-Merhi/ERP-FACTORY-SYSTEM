/**
 * factoryMixBatchRoutes: FactoryMixBatchUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import {
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { getStableSupplierCost } from "../../../services/factory/rawStockStableCost";
import {
  containerUsdRate,
  MixCostAccumulator,
  sendFactoryCostBasisRefusal,
  supplierLockedUsdRate,
} from "../../../services/factory/baleCostBasis";
import { recordFactoryStockValueEventTx } from "../../../services/factory/factoryStockValueEvents";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { MixEditRequestError, parseMixEditSelection, sameMixEditSources } from "../../../services/factory/mixBatchEditRequest";
import { prepareMixSourceEditReview } from "../../../services/factory/mixBatchEditReview";

class CompletedMixBatchSourceEditError extends Error {
  readonly code = "MIX_BATCH_COMPLETED_SOURCE_EDIT_REQUIRES_REVIEW";
  constructor() {
    super("Completed mix batches cannot have source materials repriced automatically. Use the reviewed correction workflow.");
  }
}

export function registerFactoryMixBatchUpdateRoutes(app: Express) {
  app.patch("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name, notes, batchDate, supplierSources, batchSources } = req.body;

      // Identical source weights are metadata-only, even if an older client
      // submits all its sources. Never silently reprice that historical batch.
      const hasSourceUpdate = supplierSources !== undefined || batchSources !== undefined;
      const parsedSources = hasSourceUpdate ? parseMixEditSelection(req.body) : null;
      const reason = typeof req.body.sourceEditReason === "string" ? req.body.sourceEditReason.trim() : "";
      let identicalSources = false;
      if (parsedSources) {
        const [existing] = await db.select().from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt)));
        if (!existing) return res.status(404).json({ message: "Mix batch not found" });
        const prior = await db.select().from(factoryMixBatchSources).where(eq(factoryMixBatchSources.mixBatchId, id));
        identicalSources = sameMixEditSources(prior, parsedSources);
        if (req.body.sourceEditPreview === true) {
          const preview = await prepareMixSourceEditReview(db, companyId, existing, prior, parsedSources, reason, { proposedBatchDate: batchDate });
          res.set("Cache-Control", "private, no-store");
          return res.json({ ...preview, previewOnly: true, batchCode: existing.batchCode });
        }
      }

      if (!hasSourceUpdate || identicalSources) {
        const [batch] = await db
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));
        if (!batch || batch.deletedAt) return res.status(404).json({ message: "Mix batch not found" });
        const updates: Partial<typeof factoryMixBatches.$inferInsert> = {};
        if (name !== undefined) updates.name = name?.trim() || null;
        if (notes !== undefined) updates.notes = notes?.trim() || null;
        if (batchDate !== undefined) updates.batchDate = batchDate || null;
        if (Object.keys(updates).length === 0) return res.json(batch);
        // Phase 21 (B): the write and its audit commit together.
        const updated = await db.transaction(async (tx) => {
          const [written] = await tx
            .update(factoryMixBatches)
            .set(updates)
            .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt)))
            .returning();
          if (!written) throw new Error("Mix batch is no longer available");
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || req.session.userId!,
              companyId,
              action: "update",
              tableName: "factory_mix_batches",
              recordId: id,
              recordIdentifier: batch.batchCode + (written.name ? ` – ${written.name}` : ""),
              changes: {
                ...(name !== undefined ? { name: { old: batch.name ?? null, new: written.name ?? null } } : {}),
                ...(notes !== undefined ? { notes: { old: batch.notes ?? null, new: written.notes ?? null } } : {}),
                ...(batchDate !== undefined
                  ? { batchDate: { old: batch.batchDate ?? null, new: written.batchDate ?? null } }
                  : {}),
              },
            },
            tx
          );
          return written;
        });
        return res.json(updated);
      }

      // Every real source edit requires a reviewed hash; validation is
      // repeated under transaction locks before any quantity changes.
      const sourceInputs = parsedSources!;
      const weightOf = (source: { weightKg: string }) => toMoney(source.weightKg);
      const ZERO = new MoneyDecimal(0);
      if (req.body.confirmSourceEdit !== true || typeof req.body.sourceEditReviewHash !== "string") {
        return res.status(409).json({
          code: "MIX_EDIT_REVIEW_REQUIRED",
          message: "Review the proposed source changes before applying them.",
        });
      }

      // Full source edit: reverse old consumption, apply new atomically.
      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)))
          .for("update");
        if (!batch) throw new Error("Mix batch not found");
        if (batch.deletedAt) throw new MixEditRequestError("Mix batch not found", "MIX_BATCH_NOT_FOUND", 404);
        // Completed/used batches require the later historical recost phase.
        if (batch.status === "COMPLETED" || batch.status === "CLOSED") {
          throw new CompletedMixBatchSourceEditError();
        }

        const oldSources = await tx
          .select()
          .from(factoryMixBatchSources)
          .where(eq(factoryMixBatchSources.mixBatchId, id))
          .for("update");
        if (sameMixEditSources(oldSources, sourceInputs)) {
          throw new MixEditRequestError("No material changes remain to review.", "MIX_EDIT_ALREADY_UNCHANGED", 409);
        }
        const batchBefore = batch;
        const review = await prepareMixSourceEditReview(tx, companyId, batch, oldSources, sourceInputs, reason, { forUpdate: true, proposedBatchDate: batchDate });
        if (!review.allowed) {
          throw new MixEditRequestError(review.warnings.join(" "), "MIX_EDIT_REVIEW_BLOCKED", 409);
        }
        if (review.reviewHash !== req.body.sourceEditReviewHash) {
          throw new MixEditRequestError(
            "The mix or supplier stock changed since review. Review your changes again.",
            "MIX_EDIT_REVIEW_STALE", 409,
          );
        }
        // ── 1. Reverse all existing sources ──

        // The material price difference the old sources carried, reversed below.
        let oldPriceDelta = new MoneyDecimal(0);
        for (const src of oldSources) {
          if (src.containerId) {
            const landed = await containerUsdRate(tx, companyId, src.containerId);
            const rate = toMoney(src.costPerKg);
            if (landed && rate.gt(0)) {
              oldPriceDelta = oldPriceDelta.plus(toMoney(src.weightKg).times(rate.minus(landed)));
            }
            const [rsRow] = await tx
              .select()
              .from(factoryRawStock)
              .where(and(
                eq(factoryRawStock.companyId, companyId),
                eq(factoryRawStock.containerId, src.containerId),
                isNull(factoryRawStock.deletedAt),
              ))
              .for("update");
            if (!rsRow || toMoney(rsRow.usedKg).lessThan(toMoney(src.weightKg))) {
              throw new MixEditRequestError(
                "Original raw material consumption cannot be reversed safely.",
                "MIX_EDIT_SOURCE_REVERSE_UNSAFE", 409,
              );
            }
            await tx.update(factoryRawStock)
              .set({ usedKg: toMoney(rsRow.usedKg).minus(src.weightKg).toFixed(3) })
              .where(and(eq(factoryRawStock.id, rsRow.id), eq(factoryRawStock.companyId, companyId)));
          } else if (src.supplierId && !src.sourceBatchId) {
            // The review only allows a legacy supplier-only source when there
            // are no raw-stock rows at all. Never reverse arbitrary FIFO stock.
          } else if (src.sourceBatchId) {
            const [srcBatch] = await tx
              .select()
              .from(factoryMixBatches)
              .where(and(eq(factoryMixBatches.id, src.sourceBatchId), eq(factoryMixBatches.companyId, companyId)))
              .for("update");
            if (!srcBatch || toMoney(srcBatch.usedKg).lessThan(toMoney(src.weightKg))) {
              throw new MixEditRequestError(
                "Original upstream batch consumption cannot be reversed safely.",
                "MIX_EDIT_SOURCE_REVERSE_UNSAFE", 409,
              );
            }
            await tx.update(factoryMixBatches)
              .set({
                usedKg: toMoney(srcBatch.usedKg).minus(src.weightKg).toFixed(3),
                updatedAt: new Date(),
              })
              .where(and(eq(factoryMixBatches.id, src.sourceBatchId), eq(factoryMixBatches.companyId, companyId)));
          }
        }

        // ── 2. Delete old source records ──
        await tx.delete(factoryMixBatchSources).where(eq(factoryMixBatchSources.mixBatchId, id));

        // ── 3. Apply new sources ──
        // Wave 11: every source at its USD rate (services/factory/baleCostBasis.ts).
        const mixCost = new MixCostAccumulator();
        const sourceRecords = [];

        for (const source of sourceInputs.supplierSources) {
          // costPerKg from the client is NEVER trusted for a real supplier.
          const { supplierId } = source;
          const weight = weightOf(source);

          // Locked, offload-time moving-average rate — never derived from remaining/
          // available kg or all-time received kg, so it doesn't shift depending on
          // which container FIFO happens to draw from.
          // The persisted locked rate only (the legacy receipt-weighted fallback
          // can carry a native-currency cost); with none, each FIFO container is
          // priced at its own landed USD cost.
          const [lockedRate, { rows: supplierRawStocks }] = await Promise.all([
            supplierLockedUsdRate(tx, companyId, supplierId),
            getStableSupplierCost(tx, companyId, supplierId, { forUpdate: true }),
          ]);

          // FIFO allocation of usedKg only — this determines WHICH container rows get
          // debited, never the cost rate itself (that's fixed above).
          const perRsDeductions: Array<{ containerId: number; deduct: Decimal }> = [];
          let remaining = weight;
          for (const rs of supplierRawStocks) {
            if (remaining.lessThanOrEqualTo(0.001)) break;
            const avail = toMoney(rs.receivedKg).minus(toMoney(rs.usedKg));
            if (avail.lessThanOrEqualTo(0)) continue;
            const deduct = MoneyDecimal.min(remaining, avail);
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`${factoryRawStock.usedKg} + ${deduct.toFixed()}` })
              .where(eq(factoryRawStock.id, rs.id));
            perRsDeductions.push({ containerId: rs.containerId, deduct });
            remaining = remaining.minus(deduct);
          }
          if (remaining.greaterThan(0.001) && supplierRawStocks.length > 0) {
            throw new MixEditRequestError(
              "Not enough raw stock to apply this edit without negative inventory.",
              "MIX_EDIT_INSUFFICIENT_RAW_STOCK", 409,
            );
          }

          if (supplierRawStocks.length === 0) {
            if (lockedRate === null) {
              throw new Error(
                `Supplier has no established raw-material rate yet. Record a container offload or opening-balance/ADD adjustment before using it as a mix-batch source.`
              );
            }
            mixCost.add(weight, lockedRate, { supplierId });
            sourceRecords.push({
              supplierId,
              weightKg: weight.toFixed(),
              costPerKg: lockedRate.toFixed(),
              totalCost: weight.times(lockedRate).toDecimalPlaces(6).toFixed(6),
            });
          }
          for (const d of perRsDeductions) {
            const landed = await containerUsdRate(tx, companyId, d.containerId);
            const rate = lockedRate ?? landed;
            mixCost.add(d.deduct, rate, { supplierId, containerId: d.containerId });
            mixCost.addPriceDifference(d.deduct, rate, landed);
            sourceRecords.push({
              supplierId,
              containerId: d.containerId,
              weightKg: d.deduct.toFixed(),
              costPerKg: (rate ?? ZERO).toFixed(),
              totalCost: d.deduct
                .times(rate ?? 0)
                .toDecimalPlaces(6)
                .toFixed(6),
            });
          }
        }

        for (const bSource of sourceInputs.batchSources) {
          const { sourceBatchId } = bSource;
          const [srcBatch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(
              eq(factoryMixBatches.id, sourceBatchId),
              eq(factoryMixBatches.companyId, companyId),
              isNull(factoryMixBatches.deletedAt),
            ))
            .for("update");
          if (!srcBatch) throw new Error(`Source batch ${sourceBatchId} not found`);
          const batchRemaining = toMoney(srcBatch.totalWeightKg).minus(toMoney(srcBatch.usedKg));
          const weight = weightOf(bSource);
          if (weight.greaterThan(batchRemaining.plus(0.001)))
            throw new Error(`Not enough in batch ${srcBatch.batchCode}. Available: ${batchRemaining.toFixed(3)} kg`);
          const cost = toMoney(srcBatch.costPerKg);
          await tx
            .update(factoryMixBatches)
            .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${weight.toFixed()}`, updatedAt: new Date() })
            .where(eq(factoryMixBatches.id, srcBatch.id));
          mixCost.add(weight, cost.gt(0) ? cost : null, { sourceBatchId });
          sourceRecords.push({
            sourceBatchId,
            weightKg: weight.toFixed(),
            costPerKg: cost.toFixed(),
            totalCost: weight.times(cost).toDecimalPlaces(6).toFixed(6),
          });
        }

        const settled = await mixCost.settle(tx, companyId, batchDate || batch.batchDate || getClientDate(req));

        // ── 5. Update batch totals ──
        const batchUpdates: Partial<typeof factoryMixBatches.$inferInsert> = {
          totalWeightKg: settled.totalWeight.toDecimalPlaces(3).toFixed(3),
          costPerKg: settled.costPerKg.toFixed(7),
          totalCost: settled.totalCost.toFixed(7),
          updatedAt: new Date(),
        };
        if (name !== undefined) batchUpdates.name = name?.trim() || null;
        if (notes !== undefined) batchUpdates.notes = notes?.trim() || null;
        if (batchDate !== undefined) batchUpdates.batchDate = batchDate || null;

        const [updated] = await tx
          .update(factoryMixBatches)
          .set(batchUpdates)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)))
          .returning();

        // ── 6. Insert new source records ──
        for (const sr of sourceRecords) {
          await tx.insert(factoryMixBatchSources).values({
            mixBatchId: id,
            containerId: sr.containerId || null,
            supplierId: sr.supplierId || null,
            sourceBatchId: sr.sourceBatchId || null,
            sourceType: sr.sourceBatchId
              ? "BATCH"
              : sr.supplierId
                ? sr.containerId
                  ? "SUPPLIER_FIFO"
                  : "SUPPLIER"
                : "CONTAINER_DIRECT",
            sourceId: sr.supplierId || sr.containerId || sr.sourceBatchId || null,
            weightKg: sr.weightKg,
            quantityKg: sr.weightKg,
            costPerKg: sr.costPerKg,
            totalCost: sr.totalCost,
            // V7: explicit inventory ownership. supplierId here is always the container's
            // supplier (populated from ctnSupplierId2 for container sources), so this
            // expression correctly identifies the inventory owner for all source types.
            inventorySupplierId: sr.sourceBatchId != null ? null : (sr.supplierId ?? null),
          });
        }

        await recordFactoryStockValueEventTx(tx, {
          companyId,
          kind: "MATERIAL_PRICE",
          amount: mixCost.materialPriceDelta.minus(oldPriceDelta),
          sourceType: "factory-mix-batch-edit",
          sourceId: id,
        });

        const edited = updated;
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_mix_batches",
            recordId: edited.id,
            recordIdentifier: edited.batchCode + (edited.name ? ` – ${edited.name}` : ""),
            changes: {
              ...(name !== undefined ? { name: { old: batchBefore.name ?? null, new: name?.trim() || null } } : {}),
              ...(notes !== undefined ? { notes: { old: batchBefore.notes ?? null, new: notes?.trim() || null } } : {}),
              totalWeightKg: {
                old: toMoney(batchBefore.totalWeightKg).toFixed(3),
                new: toMoney(edited.totalWeightKg).toFixed(3),
              },
              totalCost: {
                old: toMoney(batchBefore.totalCost).toFixed(7),
                new: toMoney(edited.totalCost).toFixed(7),
              },
              sourceEdit: {
                old: oldSources.map((s) => ({
                  sourceId: s.id, supplierId: s.supplierId, containerId: s.containerId,
                  sourceBatchId: s.sourceBatchId, weightKg: s.weightKg,
                  costPerKg: s.costPerKg, totalCost: s.totalCost,
                })),
                new: {
                  reason,
                  reviewHash: review.reviewHash,
                  newSupplierSources: sourceInputs.supplierSources,
                  newBatchSources: sourceInputs.batchSources,
                },
              },
            },
          },
          tx
        );
        // Keep the existing daybook reference in the SAME transaction as
        // source, quantity, valuation and audit updates. This does not create
        // an extra accounting voucher; failure rolls back the whole edit.
        await tx.delete(factoryDaybookEntries).where(and(
          eq(factoryDaybookEntries.companyId, companyId),
          eq(factoryDaybookEntries.txType, "MIX_BATCH_CREATED"),
          eq(factoryDaybookEntries.referenceId, id),
        ));
        const mbTxDate = batchDate || edited.batchDate || getClientDate(req);
        await writeDaybookEntry(tx, {
          companyId,
          txDate: mbTxDate,
          txType: "MIX_BATCH_CREATED",
          referenceId: edited.id,
          referenceTable: "factory_mix_batches",
          description: `Mix batch edited: ${edited.batchCode}${edited.name ? ` – ${edited.name}` : ""} (${toMoney(edited.totalWeightKg).toFixed(1)} kg)`,
          amountCurrency: toMoney(edited.totalCost).toNumber(),
          amountUsd: toMoney(edited.totalCost).toNumber(),
        });
        return edited;
      });
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof MixEditRequestError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      if (error instanceof CompletedMixBatchSourceEditError) {
        return res.status(409).json({ code: error.code, message: error.message });
      }
      if (sendFactoryCostBasisRefusal(res, error)) return;
      logger.error("Error updating mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
