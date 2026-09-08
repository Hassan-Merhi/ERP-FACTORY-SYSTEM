/**
 * rawStockBalanceRoutesLegacy: RawStockRecalculateUsed endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { requireSessionUserId } from "../../../../lib/sessionUser";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { checkFactoryAdmin } from "../../_helpers";
import { logAudit } from "../../../helpers/auditHelpers";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
} from "@shared/schema";
import { eq, and, or, sql, inArray, ne, isNull } from "drizzle-orm";
import Decimal from "decimal.js";

export function registerRawStockRecalculateUsedRoutes(app: Express) {
  // Recalculate usedKg for all factory_raw_stock records based on ACTIVE (non-deleted) mix batch sources.
  // Dangerous bulk recalc — bulk-overwrites usedKg for every raw stock record in the
  // company. Admin-only, defaults to a dry-run diff preview, and audit-logs every apply.
  // Only counts sources from mix batches that are NOT soft-deleted and NOT status='DELETED'.
  app.post(
    "/api/factory/raw-stock/recalculate-used",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const dryRun = req.body?.confirm !== true;

        // 1. Load only non-deleted raw-stock whose container is also not deleted.
        const allRawStock = await db
          .select({
            id: factoryRawStock.id,
            containerId: factoryRawStock.containerId,
            usedKg: factoryRawStock.usedKg,
            receivedKg: factoryRawStock.receivedKg,
            containerNumber: factoryContainers.containerNumber,
            supplierId: factoryContainers.supplierId,
            supplierName: factorySuppliers.name,
          })
          .from(factoryRawStock)
          .innerJoin(factoryContainers, eq(factoryContainers.id, factoryRawStock.containerId))
          .leftJoin(factorySuppliers, eq(factorySuppliers.id, factoryContainers.supplierId))
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              isNull(factoryRawStock.deletedAt),
              isNull(factoryContainers.deletedAt),
              ne(factoryContainers.status, "DELETED")
            )
          );

        if (allRawStock.length === 0) return res.json({ updated: 0, dryRun, changes: [] });

        const containerIds = allRawStock.map((r) => r.containerId as number);

        // 2. Sum used kg only from VALID (non-deleted) mix batch sources.
        const sourceSums = await db
          .select({
            containerId: factoryMixBatchSources.containerId,
            totalUsedKg: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), 0)`,
            validSourceCount: sql<string>`COUNT(*)`,
          })
          .from(factoryMixBatchSources)
          .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
          .where(
            and(
              eq(factoryMixBatches.companyId, companyId),
              isNull(factoryMixBatches.deletedAt),
              ne(factoryMixBatches.status, "DELETED"),
              inArray(factoryMixBatchSources.containerId, containerIds)
            )
          )
          .groupBy(factoryMixBatchSources.containerId);

        // 3. Separately tally excluded (deleted-batch) source rows for transparency.
        const excludedSums = await db
          .select({
            containerId: factoryMixBatchSources.containerId,
            excludedWeight: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), 0)`,
            excludedCount: sql<string>`COUNT(*)`,
          })
          .from(factoryMixBatchSources)
          .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
          .where(
            and(
              inArray(factoryMixBatchSources.containerId, containerIds),
              or(sql`${factoryMixBatches.deletedAt} IS NOT NULL`, eq(factoryMixBatches.status, "DELETED"))
            )
          )
          .groupBy(factoryMixBatchSources.containerId);

        const validByContainer = new Map<number, { used: number; count: number }>();
        for (const row of sourceSums) {
          if (row.containerId != null) {
            validByContainer.set(row.containerId, {
              used: parseFloat(row.totalUsedKg || "0"),
              count: parseInt(row.validSourceCount || "0"),
            });
          }
        }
        const excludedByContainer = new Map<number, { weight: number; count: number }>();
        for (const row of excludedSums) {
          if (row.containerId != null) {
            excludedByContainer.set(row.containerId, {
              weight: parseFloat(row.excludedWeight || "0"),
              count: parseInt(row.excludedCount || "0"),
            });
          }
        }

        // 4. Build the change list with full per-row detail.
        const changes: any[] = [];
        let totalOldUsed = new Decimal(0);
        let totalNewUsed = new Decimal(0);
        let totalReceived = new Decimal(0);
        let totalValidSourceWeight = new Decimal(0);
        let totalExcludedWeight = new Decimal(0);

        for (const rs of allRawStock) {
          const valid = validByContainer.get(rs.containerId) || { used: 0, count: 0 };
          const excluded = excludedByContainer.get(rs.containerId) || { weight: 0, count: 0 };
          const oldUsedKg = new Decimal(rs.usedKg || "0").toDecimalPlaces(3);
          const newUsedKg = new Decimal(valid.used).toDecimalPlaces(3);

          totalOldUsed = totalOldUsed.plus(oldUsedKg);
          totalNewUsed = totalNewUsed.plus(newUsedKg);
          totalReceived = totalReceived.plus(new Decimal(rs.receivedKg || "0"));
          totalValidSourceWeight = totalValidSourceWeight.plus(new Decimal(valid.used));
          totalExcludedWeight = totalExcludedWeight.plus(new Decimal(excluded.weight));

          if (!oldUsedKg.equals(newUsedKg)) {
            changes.push({
              rawStockId: rs.id,
              containerId: rs.containerId,
              containerNumber: rs.containerNumber,
              supplierId: rs.supplierId ?? null,
              supplierName: rs.supplierName ?? null,
              receivedKg: new Decimal(rs.receivedKg || "0").toDecimalPlaces(3).toFixed(3),
              oldUsedKg: oldUsedKg.toFixed(3),
              correctedUsedKg: newUsedKg.toFixed(3),
              differenceKg: newUsedKg.minus(oldUsedKg).toFixed(3),
              validSourceCount: valid.count,
              validSourceWeightKg: new Decimal(valid.used).toFixed(3),
              excludedDeletedSourceCount: excluded.count,
              excludedDeletedSourceWeightKg: new Decimal(excluded.weight).toFixed(3),
            });
          }
        }

        const summary = {
          totalReceivedKg: totalReceived.toFixed(3),
          currentTotalUsedKg: totalOldUsed.toFixed(3),
          correctedTotalUsedKg: totalNewUsed.toFixed(3),
          totalDifferenceKg: totalNewUsed.minus(totalOldUsed).toFixed(3),
          validSourceWeightKg: totalValidSourceWeight.toFixed(3),
          excludedDeletedSourceWeightKg: totalExcludedWeight.toFixed(3),
        };

        if (dryRun) {
          return res.json({
            dryRun: true,
            wouldUpdate: changes.length,
            summary,
            changes,
            message: `Dry run: ${changes.length} of ${allRawStock.length} raw stock record(s) would change. Re-submit with { confirm: true } to apply.`,
          });
        }

        // 5. Apply inside a single transaction — lock each row FOR UPDATE, compare with Decimal.js.
        let updated = 0;
        const appliedChanges: any[] = [];
        const now = new Date();

        await db.transaction(async (tx) => {
          for (const c of changes) {
            const [locked] = await tx
              .select({ id: factoryRawStock.id, usedKg: factoryRawStock.usedKg })
              .from(factoryRawStock)
              .where(eq(factoryRawStock.id, c.rawStockId))
              .for("update");

            if (!locked) continue;

            // Re-compare inside the lock in case of concurrent writes
            const currentUsedKg = new Decimal(locked.usedKg || "0").toDecimalPlaces(3);
            const correctedUsedKg = new Decimal(c.correctedUsedKg).toDecimalPlaces(3);
            if (currentUsedKg.equals(correctedUsedKg)) continue;

            await tx
              .update(factoryRawStock)
              .set({ usedKg: correctedUsedKg.toFixed(3), updatedAt: now } as any)
              .where(eq(factoryRawStock.id, c.rawStockId));

            appliedChanges.push(c);
            updated++;
          }

          // Single audit record for the whole batch
          await logAudit({
            userId: requireSessionUserId(req),
            username: req.session.username || requireSessionUserId(req),
            companyId,
            action: "update",
            tableName: "factory_raw_stock",
            recordIdentifier: "bulk recalculate-used",
            changes: {
              updated: { new: updated },
              summary: { new: summary },
              rows: { new: appliedChanges },
            },
          });
        });

        res.json({
          dryRun: false,
          updated,
          summary,
          changes: appliedChanges,
          message: `Recalculated used KG for ${updated} raw stock records.`,
        });
      } catch (error: unknown) {
        logger.error("Error recalculating raw stock used:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Recalculate bale costs from current mix batch cost/kg (one-time historical fix) ──
  // Dangerous one-time historical fix — bulk-overwrites costPerKg/totalCost on every bale
  // in every mix batch for the company. Admin-only, defaults to a dry-run diff preview,
  // and audit-logs every apply.
  app.post(
    "/api/factory/raw-stock/recalculate-bale-costs",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        if (!checkFactoryAdmin(req, res)) return;
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const dryRun = req.body?.confirm !== true;

        const allBatches = await db
          .select({ id: factoryMixBatches.id, costPerKg: factoryMixBatches.costPerKg })
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.companyId, companyId), sql`${factoryMixBatches.status} != 'DELETED'`));

        const changes: {
          baleId: number;
          mixBatchId: number;
          oldCostPerKg: string | null;
          newCostPerKg: string;
          oldTotalCost: string | null;
          newTotalCost: string;
        }[] = [];

        for (const batch of allBatches) {
          const batchCost = parseFloat(batch.costPerKg || "0");
          if (batchCost <= 0) continue;

          const bales = await db
            .select({
              id: factoryBales.id,
              weightKg: factoryBales.weightKg,
              costPerKg: factoryBales.costPerKg,
              totalCost: factoryBales.totalCost,
            })
            .from(factoryBales)
            .where(
              and(
                eq(factoryBales.mixBatchId, batch.id),
                eq(factoryBales.companyId, companyId),
                sql`${factoryBales.status} NOT IN ('DELETED','REMOVED')`
              )
            );

          for (const bale of bales) {
            const baleWt = parseFloat(bale.weightKg as string) || 0;
            const newCostPerKg = batchCost.toFixed(4);
            const newTotalCost = (baleWt * batchCost).toFixed(2);
            if (String(bale.costPerKg) === newCostPerKg && String(bale.totalCost) === newTotalCost) continue;
            changes.push({
              baleId: bale.id,
              mixBatchId: batch.id,
              oldCostPerKg: bale.costPerKg,
              newCostPerKg,
              oldTotalCost: bale.totalCost,
              newTotalCost,
            });
          }
        }

        if (dryRun) {
          return res.json({
            dryRun: true,
            wouldUpdate: changes.length,
            changes,
            message: `Dry run: ${changes.length} bale(s) across ${allBatches.length} batch(es) would change. Re-submit with { confirm: true } to apply.`,
          });
        }

        const now = new Date();
        for (const c of changes) {
          await db
            .update(factoryBales)
            .set({ costPerKg: c.newCostPerKg, totalCost: c.newTotalCost, updatedAt: now })
            .where(eq(factoryBales.id, c.baleId));
        }

        await logAudit({
          userId: requireSessionUserId(req),
          username: req.session.username || requireSessionUserId(req),
          companyId,
          action: "update",
          tableName: "factory_bales",
          recordIdentifier: "bulk recalculate-bale-costs",
          changes: { updated: { new: changes.length }, rows: { new: changes } },
        });

        res.json({
          dryRun: false,
          balesUpdated: changes.length,
          changes,
          message: `Updated cost/kg on ${changes.length} bale(s) across ${allBatches.length} batch(es).`,
        });
      } catch (error: unknown) {
        logger.error("Error recalculating bale costs:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // 6. Factory Mix Batches
  // ───────────────────────────────────────────────
}
