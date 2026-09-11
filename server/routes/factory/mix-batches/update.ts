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
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { getStableSupplierCost } from "../../../services/factory/rawStockStableCost";
import { getLockedSupplierRate } from "../../../services/factory/rawStockLockedRate";
import Decimal from "decimal.js";

export function registerFactoryMixBatchUpdateRoutes(app: Express) {
  app.patch("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name, notes, batchDate, supplierSources, batchSources } = req.body;

      // If no source data provided → simple name/notes update only
      const hasSourceUpdate = supplierSources !== undefined || batchSources !== undefined;

      if (!hasSourceUpdate) {
        const [batch] = await db
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));
        if (!batch) return res.status(404).json({ message: "Mix batch not found" });
        const updates: Partial<typeof factoryMixBatches.$inferInsert> = {};
        if (name !== undefined) updates.name = name?.trim() || null;
        if (notes !== undefined) updates.notes = notes?.trim() || null;
        if (batchDate !== undefined) updates.batchDate = batchDate || null;
        const [updated] = await db
          .update(factoryMixBatches)
          .set(updates)
          .where(eq(factoryMixBatches.id, id))
          .returning();
        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_mix_batches",
            recordId: id,
            recordIdentifier: batch.batchCode + (updated.name ? ` – ${updated.name}` : ""),
            changes: {
              ...(name !== undefined ? { name: { old: batch.name ?? null, new: updated.name ?? null } } : {}),
              ...(notes !== undefined ? { notes: { old: batch.notes ?? null, new: updated.notes ?? null } } : {}),
              ...(batchDate !== undefined
                ? { batchDate: { old: batch.batchDate ?? null, new: updated.batchDate ?? null } }
                : {}),
            },
          });
        } catch (auditErr) {
          logger.error("[mix-batch simple-patch audit] non-fatal:", { error: auditErr });
        }
        return res.json(updated);
      }

      // Capture old values before the transaction so the audit log has real before/after diffs.
      const [batchBefore] = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));
      if (!batchBefore) return res.status(404).json({ message: "Mix batch not found" });

      // Full source edit: reverse old consumption, apply new
      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)))
          .for("update");
        if (!batch) throw new Error("Mix batch not found");

        const _usedKg = parseFloat(batch.usedKg || "0");

        // ── 1. Reverse all existing sources ──
        const oldSources = await tx
          .select()
          .from(factoryMixBatchSources)
          .where(eq(factoryMixBatchSources.mixBatchId, id));

        for (const src of oldSources) {
          if (src.containerId) {
            const [rsRow] = await tx
              .select()
              .from(factoryRawStock)
              .where(eq(factoryRawStock.containerId, src.containerId));
            if (rsRow) {
              const newUsed = Math.max(0, parseFloat(rsRow.usedKg) - parseFloat(src.weightKg));
              await tx
                .update(factoryRawStock)
                .set({ usedKg: newUsed.toFixed(3) })
                .where(eq(factoryRawStock.id, rsRow.id));
            }
          } else if (src.supplierId && !src.sourceBatchId) {
            // Legacy supplier-only source: FIFO reverse
            const supplierRawStocks = await tx
              .select({
                id: factoryRawStock.id,
                usedKg: factoryRawStock.usedKg,
              })
              .from(factoryRawStock)
              .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
              .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryContainers.supplierId, src.supplierId)))
              .orderBy(desc(factoryRawStock.offloadedAt), desc(factoryRawStock.id));
            let toRestore = parseFloat(src.weightKg);
            for (const rs of supplierRawStocks) {
              if (toRestore <= 0.001) break;
              const usedNow = parseFloat(rs.usedKg);
              if (usedNow <= 0) continue;
              const restore = Math.min(toRestore, usedNow);
              await tx
                .update(factoryRawStock)
                .set({ usedKg: Math.max(0, usedNow - restore).toFixed(3) })
                .where(eq(factoryRawStock.id, rs.id));
              toRestore -= restore;
            }
          } else if (src.sourceBatchId) {
            const [srcBatch] = await tx
              .select()
              .from(factoryMixBatches)
              .where(eq(factoryMixBatches.id, src.sourceBatchId));
            if (srcBatch) {
              const newUsed = Math.max(0, parseFloat(srcBatch.usedKg) - parseFloat(src.weightKg));
              await tx
                .update(factoryMixBatches)
                .set({ usedKg: newUsed.toFixed(3), status: "ACTIVE" })
                .where(eq(factoryMixBatches.id, src.sourceBatchId));
            }
          }
        }

        // ── 2. Delete old source records ──
        await tx.delete(factoryMixBatchSources).where(eq(factoryMixBatchSources.mixBatchId, id));

        // ── 3. Apply new sources ──
        // DEFECT 15 FIX: use Decimal.js for cost accumulation (edit route).
        let dTotalWeightKg = new Decimal(0);
        let dTotalCost = new Decimal(0);
        const sourceRecords = [];

        for (const source of supplierSources || []) {
          // costPerKg from the client is NEVER trusted for a real supplier.
          const { supplierId, weightKg } = source;
          const weight = parseFloat(weightKg);

          // Locked, offload-time moving-average rate — never derived from remaining/
          // available kg or all-time received kg, so it doesn't shift depending on
          // which container FIFO happens to draw from.
          const [costPerKg, { rows: supplierRawStocks }] = await Promise.all([
            getLockedSupplierRate(tx, companyId, supplierId, { forUpdate: true }),
            getStableSupplierCost(tx, companyId, supplierId, { forUpdate: true }),
          ]);

          // FIFO allocation of usedKg only — this determines WHICH container rows get
          // debited, never the cost rate itself (that's fixed above).
          const perRsDeductions: Array<{ containerId: number; deduct: number }> = [];
          let remaining = weight;
          for (const rs of supplierRawStocks) {
            if (remaining <= 0.001) break;
            const avail = rs.receivedKg - rs.usedKg;
            if (avail <= 0) continue;
            const deduct = Math.min(remaining, avail);
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`${factoryRawStock.usedKg} + ${deduct}` })
              .where(eq(factoryRawStock.id, rs.id));
            perRsDeductions.push({ containerId: rs.containerId, deduct });
            remaining -= deduct;
          }
          if (remaining > 0.001 && supplierRawStocks.length > 0) {
            const lastRs = supplierRawStocks[supplierRawStocks.length - 1];
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`${factoryRawStock.usedKg} + ${remaining}` })
              .where(eq(factoryRawStock.id, lastRs.id));
            const ex = perRsDeductions.find((d) => d.containerId === lastRs.containerId);
            if (ex) ex.deduct += remaining;
            else perRsDeductions.push({ containerId: lastRs.containerId, deduct: remaining });
          }

          const dW = new Decimal(weight);
          const dCpk = new Decimal(costPerKg);
          dTotalWeightKg = dTotalWeightKg.plus(dW);
          dTotalCost = dTotalCost.plus(dW.times(dCpk));
          if (supplierRawStocks.length === 0) {
            if (costPerKg <= 0) {
              throw new Error(
                `Supplier has no established raw-material rate yet. Record a container offload or opening-balance/ADD adjustment before using it as a mix-batch source.`
              );
            }
            sourceRecords.push({
              supplierId,
              weightKg: String(weight),
              costPerKg: String(costPerKg),
              totalCost: dW.times(dCpk).toDecimalPlaces(6).toFixed(6),
            });
          }
          for (const d of perRsDeductions) {
            sourceRecords.push({
              supplierId,
              containerId: d.containerId,
              weightKg: String(d.deduct),
              costPerKg: String(costPerKg),
              totalCost: new Decimal(d.deduct).times(dCpk).toDecimalPlaces(6).toFixed(6),
            });
          }
        }

        for (const bSource of batchSources || []) {
          const { sourceBatchId, weightKg } = bSource;
          const [srcBatch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, sourceBatchId), eq(factoryMixBatches.companyId, companyId)))
            .for("update");
          if (!srcBatch) throw new Error(`Source batch ${sourceBatchId} not found`);
          const batchRemaining = parseFloat(srcBatch.totalWeightKg) - parseFloat(srcBatch.usedKg);
          const weight = parseFloat(weightKg);
          if (weight > batchRemaining + 0.001)
            throw new Error(`Not enough in batch ${srcBatch.batchCode}. Available: ${batchRemaining.toFixed(3)} kg`);
          const cost = parseFloat(srcBatch.costPerKg);
          await tx
            .update(factoryMixBatches)
            .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${weight}`, updatedAt: new Date() })
            .where(eq(factoryMixBatches.id, srcBatch.id));
          const dWb = new Decimal(weight);
          const dCostB = new Decimal(cost);
          dTotalWeightKg = dTotalWeightKg.plus(dWb);
          dTotalCost = dTotalCost.plus(dWb.times(dCostB));
          sourceRecords.push({
            sourceBatchId,
            weightKg: String(weight),
            costPerKg: String(cost),
            totalCost: dWb.times(dCostB).toDecimalPlaces(6).toFixed(6),
          });
        }

        const blendedCostPerKg = dTotalWeightKg.gt(0)
          ? dTotalCost.div(dTotalWeightKg).toDecimalPlaces(6).toNumber()
          : 0;

        // ── 5. Update batch totals ──
        const batchUpdates: Partial<typeof factoryMixBatches.$inferInsert> = {
          totalWeightKg: dTotalWeightKg.toDecimalPlaces(6).toFixed(6),
          costPerKg: new Decimal(blendedCostPerKg).toFixed(6),
          totalCost: dTotalCost.toDecimalPlaces(6).toFixed(6),
          updatedAt: new Date(),
        };
        if (name !== undefined) batchUpdates.name = name?.trim() || null;
        if (notes !== undefined) batchUpdates.notes = notes?.trim() || null;
        if (batchDate !== undefined) batchUpdates.batchDate = batchDate || null;

        const [updated] = await tx
          .update(factoryMixBatches)
          .set(batchUpdates)
          .where(eq(factoryMixBatches.id, id))
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

        return updated;
      });

      // Update daybook entry
      await db
        .delete(factoryDaybookEntries)
        .where(
          and(
            eq(factoryDaybookEntries.companyId, companyId),
            eq(factoryDaybookEntries.txType, "MIX_BATCH_CREATED"),
            eq(factoryDaybookEntries.referenceId, id)
          )
        );
      const mbTxDate = batchDate || result.batchDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: mbTxDate,
        txType: "MIX_BATCH_CREATED",
        referenceId: result.id,
        referenceTable: "factory_mix_batches",
        description: `Mix batch edited: ${result.batchCode}${result.name ? ` – ${result.name}` : ""} (${parseFloat(result.totalWeightKg || "0").toFixed(1)} kg)`,
        amountCurrency: parseFloat(result.totalCost || "0"),
        amountUsd: parseFloat(result.totalCost || "0"),
      });

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "update",
        tableName: "factory_mix_batches",
        recordId: result.id,
        recordIdentifier: result.batchCode + (result.name ? ` – ${result.name}` : ""),
        changes: {
          ...(name !== undefined ? { name: { old: batchBefore.name ?? null, new: name?.trim() || null } } : {}),
          ...(notes !== undefined ? { notes: { old: batchBefore.notes ?? null, new: notes?.trim() || null } } : {}),
          totalWeightKg: {
            old: parseFloat(batchBefore.totalWeightKg || "0").toFixed(3),
            new: parseFloat(result.totalWeightKg || "0").toFixed(3),
          },
        },
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error updating mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
