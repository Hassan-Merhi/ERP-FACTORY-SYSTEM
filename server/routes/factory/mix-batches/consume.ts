/**
 * factoryMixBatchRoutes: FactoryMixBatchConsume endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logAudit } from "../../helpers/auditHelpers";
import { isPerpetualInventoryActive } from "../../../services/accounting/perpetualInventory/cutover";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches, factoryMixBatchSources, factoryDailyUsages } from "@shared/schema";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import {
  MixLifecycleRefusal,
  requireMixLifecycleUsage,
  validateMixLifecycleUsageRequest,
} from "../../../services/factory/mixLifecyclePhase6";

export function registerFactoryMixBatchConsumeRoutes(app: Express) {
  app.post("/api/factory/mix-batches/consume", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { entries, operatorUser, usedDate } = validateMixLifecycleUsageRequest(req.body);

      type ConsumeResult =
        | { batchId: number; action: "closed"; carryForwardId: null }
        | {
            batchId: number;
            action: "carry_forward";
            carryForwardId: number;
            carryForwardCode: string;
            leftoverKg: number;
          };
      const results: ConsumeResult[] = [];
      await db.transaction(async (tx) => {
        // Serialize carry-forward code assignment across consumption requests.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_mix_batch_sequence'), ${companyId})`);
        // This legacy endpoint has no bale/COGS or linked GL posting for
        // the kg consumed. Under perpetual inventory, an unbalanced WIP
        // reduction is not permitted.
        if (await isPerpetualInventoryActive(tx, companyId, usedDate)) {
          throw new MixLifecycleRefusal(
            "Mix consumption requires a matching production-output and accounting posting after inventory cutover. Use the reviewed production workflow."
          );
        }
        for (const { batchId, kgUsed, notes } of entries) {
          const [batch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(
              and(
                eq(factoryMixBatches.id, batchId),
                eq(factoryMixBatches.companyId, companyId),
                isNull(factoryMixBatches.deletedAt)
              )
            )
            .for("update");
          if (!batch) throw new Error(`Batch ${batchId} not found`);

          // Decimal arithmetic (wave 11): the carry-forward batch takes exactly
          // the leftover kg at exactly the closed batch's cost per kg, so
          // carrying a mix forward does not change the factory valuation (the
          // float path drifted it, and the drift landed in production variance).
          const { remainingBeforeKg: remaining, usedKg: used } = requireMixLifecycleUsage(batch, kgUsed.toFixed(3));
          const [hasSource] = await tx
            .select({ id: factoryMixBatchSources.id })
            .from(factoryMixBatchSources)
            .where(eq(factoryMixBatchSources.mixBatchId, batchId))
            .limit(1);
          if (!hasSource)
            throw new MixLifecycleRefusal(`Mix ${batch.batchCode} lacks persisted material-source evidence.`);
          if (toMoney(batch.costPerKg).lte(0))
            throw new MixLifecycleRefusal(`Mix ${batch.batchCode} has no supported recorded USD rate.`);

          const now = new Date();
          await tx.insert(factoryDailyUsages).values({
            companyId,
            mixBatchId: batchId,
            kgUsed: kgUsed.toFixed(3),
            operatorUser: operatorUser || null,
            usedDate,
            notes: notes || null,
          });

          const isFullyConsumed = used.eq(remaining);

          if (isFullyConsumed) {
            await tx
              .update(factoryMixBatches)
              .set({ usedKg: batch.totalWeightKg, status: "CLOSED", updatedAt: now })
              .where(eq(factoryMixBatches.id, batchId));
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || req.session.userId!,
                companyId,
                action: "update",
                tableName: "factory_mix_batches",
                recordId: batchId,
                recordIdentifier: batch.batchCode,
                changes: {
                  status: { old: batch.status, new: "CLOSED" },
                  usedKg: { old: batch.usedKg, new: batch.totalWeightKg },
                  consumedKg: { old: null, new: used.toFixed(3) },
                  usedDate: { old: null, new: usedDate },
                },
              },
              tx
            );
            results.push({ batchId, action: "closed", carryForwardId: null });
          } else {
            // total_weight_kg holds 3dp.
            const leftoverKg = remaining.minus(used).toDecimalPlaces(3);
            const costPerKg = toMoney(batch.costPerKg);
            const leftoverCost = leftoverKg.times(costPerKg);

            await tx
              .update(factoryMixBatches)
              .set({ usedKg: batch.totalWeightKg, status: "CLOSED", updatedAt: now })
              .where(eq(factoryMixBatches.id, batchId));

            const year = Number(usedDate.slice(0, 4));
            const existingBatches = await tx
              .select({ batchCode: factoryMixBatches.batchCode })
              .from(factoryMixBatches)
              .where(
                and(
                  eq(factoryMixBatches.companyId, companyId),
                  sql`${factoryMixBatches.batchCode} LIKE ${"FMB-" + year + "-%"}`
                )
              );
            let nextNum = 1;
            for (const b of existingBatches) {
              const parts = b.batchCode.split("-");
              const num = parseInt(parts[2]) || 0;
              if (num >= nextNum) nextNum = num + 1;
            }
            const newBatchCode = `FMB-${year}-${String(nextNum).padStart(4, "0")}`;

            const [cfBatch] = await tx
              .insert(factoryMixBatches)
              .values({
                companyId,
                batchCode: newBatchCode,
                batchNumber: newBatchCode,
                name: batch.name || null,
                totalWeightKg: leftoverKg.toFixed(3),
                usedKg: "0.000",
                costPerKg: costPerKg.toFixed(7),
                totalCost: leftoverCost.toDecimalPlaces(7).toFixed(7),
                notes: batch.notes || null,
                operatorUser: operatorUser || batch.operatorUser || null,
                batchDate: usedDate || null,
                carryForwardFromId: batchId,
                status: "CARRY_FORWARD",
              })
              .returning();

            // A carry-forward is a real source-backed WIP transfer. Without
            // this row the historical source sum and replay provenance are lost.
            await tx.insert(factoryMixBatchSources).values({
              mixBatchId: cfBatch.id,
              sourceBatchId: batchId,
              sourceType: "BATCH",
              sourceId: batchId,
              weightKg: leftoverKg.toFixed(3),
              quantityKg: leftoverKg.toFixed(3),
              costPerKg: costPerKg.toFixed(7),
              totalCost: leftoverCost.toDecimalPlaces(7).toFixed(7),
              notes: `Carry-forward of ${leftoverKg.toFixed(3)} kg from ${batch.batchCode} after daily usage ${used.toFixed(3)} kg on ${usedDate}`,
            });

            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || req.session.userId!,
                companyId,
                action: "update",
                tableName: "factory_mix_batches",
                recordId: batchId,
                recordIdentifier: batch.batchCode,
                changes: {
                  status: { old: batch.status, new: "CLOSED" },
                  usedKg: { old: batch.usedKg, new: batch.totalWeightKg },
                  consumedKg: { old: null, new: used.toFixed(3) },
                  carriedKg: { old: null, new: leftoverKg.toFixed(3) },
                  carryForwardId: { old: null, new: cfBatch.id },
                  usedDate: { old: null, new: usedDate },
                },
              },
              tx
            );
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || req.session.userId!,
                companyId,
                action: "create",
                tableName: "factory_mix_batches",
                recordId: cfBatch.id,
                recordIdentifier: cfBatch.batchCode,
                changes: {
                  parentBatchId: { old: null, new: batchId },
                  carriedKg: { old: null, new: leftoverKg.toFixed(3) },
                  carriedValueUsd: { old: null, new: leftoverCost.toDecimalPlaces(7).toFixed(7) },
                },
              },
              tx
            );
            results.push({
              batchId,
              action: "carry_forward",
              carryForwardId: cfBatch.id,
              carryForwardCode: cfBatch.batchCode,
              leftoverKg: leftoverKg.toNumber(),
            });
          }
        }
      });

      res.json({ success: true, results });
    } catch (error: unknown) {
      if (error instanceof MixLifecycleRefusal) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      logger.error("Error consuming mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/suppliers/:id/mix-batch-history", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const supplierId = parseId(req.params.id);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });

      const rows = await db
        .select({
          batchId: factoryMixBatches.id,
          batchCode: factoryMixBatches.batchCode,
          batchName: factoryMixBatches.name,
          batchDate: factoryMixBatches.batchDate,
          batchStatus: factoryMixBatches.status,
          deletedAt: factoryMixBatches.deletedAt,
          batchCreatedAt: factoryMixBatches.createdAt,
          sourceId: factoryMixBatchSources.id,
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          totalCost: factoryMixBatchSources.totalCost,
          sourceCreatedAt: factoryMixBatchSources.createdAt,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(and(eq(factoryMixBatchSources.supplierId, supplierId), eq(factoryMixBatches.companyId, companyId)))
        .orderBy(desc(factoryMixBatches.createdAt));

      res.json(rows);
    } catch (error: unknown) {
      logger.error("Error fetching supplier mix batch history:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
