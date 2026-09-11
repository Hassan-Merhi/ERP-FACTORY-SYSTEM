/**
 * factoryMixBatchRoutes: FactoryMixBatchConsume endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches, factoryMixBatchSources, factoryDailyUsages } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";

export function registerFactoryMixBatchConsumeRoutes(app: Express) {
  app.post("/api/factory/mix-batches/consume", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { usages, operatorUser, usedDate } = req.body as {
        usages: Array<{ batchId: number; kgUsed: number; notes?: string }>;
        operatorUser?: string;
        usedDate: string;
      };

      if (!Array.isArray(usages) || usages.length === 0) {
        return res.status(400).json({ message: "usages array is required" });
      }
      if (!usedDate) return res.status(400).json({ message: "usedDate is required" });

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
        for (const u of usages) {
          const { batchId, kgUsed, notes } = u;
          if (!batchId || !(kgUsed > 0)) continue;

          const [batch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, batchId), eq(factoryMixBatches.companyId, companyId)))
            .for("update");
          if (!batch) throw new Error(`Batch ${batchId} not found`);

          const total = parseFloat(batch.totalWeightKg) || 0;
          const alreadyUsed = parseFloat(batch.usedKg) || 0;
          const remaining = total - alreadyUsed;

          if (kgUsed > remaining + 0.001) {
            throw new Error(
              `Cannot consume ${kgUsed} kg from batch ${batch.batchCode}: only ${remaining.toFixed(3)} kg remaining`
            );
          }

          const now = new Date();
          await tx.insert(factoryDailyUsages).values({
            companyId,
            mixBatchId: batchId,
            kgUsed: String(kgUsed),
            operatorUser: operatorUser || null,
            usedDate,
            notes: notes || null,
          });

          const isFullyConsumed = kgUsed >= remaining - 0.001;

          if (isFullyConsumed) {
            await tx
              .update(factoryMixBatches)
              .set({ usedKg: batch.totalWeightKg, status: "CLOSED", updatedAt: now })
              .where(eq(factoryMixBatches.id, batchId));
            results.push({ batchId, action: "closed", carryForwardId: null });
          } else {
            const leftoverKg = remaining - kgUsed;
            const costPerKg = parseFloat(batch.costPerKg) || 0;
            const leftoverCost = leftoverKg * costPerKg;

            await tx
              .update(factoryMixBatches)
              .set({ usedKg: String(total), status: "CLOSED", updatedAt: now })
              .where(eq(factoryMixBatches.id, batchId));

            const year = new Date().getFullYear();
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
                totalWeightKg: String(leftoverKg),
                costPerKg: String(costPerKg),
                totalCost: String(leftoverCost),
                notes: batch.notes || null,
                operatorUser: operatorUser || batch.operatorUser || null,
                batchDate: usedDate || null,
                carryForwardFromId: batchId,
                status: "CARRY_FORWARD",
              })
              .returning();

            results.push({
              batchId,
              action: "carry_forward",
              carryForwardId: cfBatch.id,
              carryForwardCode: cfBatch.batchCode,
              leftoverKg,
            });
          }
        }
      });

      res.json({ success: true, results });
    } catch (error: unknown) {
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
