// Extracted from ./productionRawStockRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { productionRawStock, mixBatches, mixBatchSources } from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../lib/money";

export function registerProductionRawStockRoutesPart1(app: Express) {
  app.get("/api/mix-batches/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid mix batch ID" });
      }

      const batch = await storage.getMixBatchById(id, companyId);

      if (!batch) {
        return res.status(404).json({ message: "Mix batch not found" });
      }

      res.json(batch);
    } catch (error: unknown) {
      logger.error("Error fetching mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/mix-batches", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId || !userId) return res.status(400).json({ message: "No company or user session" });
      if (req.body?.companyId !== undefined && Number(req.body.companyId) !== companyId) {
        return res.status(403).json({
          message: "Access denied: Mix batch belongs to a different company",
        });
      }

      const { sources, batchSources, name, ...batchData } = req.body;

      const hasSources = sources && Array.isArray(sources) && sources.length > 0;
      const hasBatchSources = batchSources && Array.isArray(batchSources) && batchSources.length > 0;

      if (!hasSources && !hasBatchSources) {
        return res.status(400).json({ message: "At least one container or batch source is required" });
      }

      const result = await db.transaction(async (tx) => {
        const year = new Date().getFullYear();
        const existingBatches = await tx
          .select({ id: mixBatches.id })
          .from(mixBatches)
          .where(eq(mixBatches.companyId, companyId));
        const batchNum = existingBatches.length + 1;
        const batchCode = batchData.batchCode || `MB-${year}-${String(batchNum).padStart(3, "0")}`;

        let totalWeightKg = new MoneyDecimal(0);
        let totalCost = new MoneyDecimal(0);
        const validatedSources: Array<{
          containerId?: number;
          sourceBatchId?: number;
          weightKg: Decimal;
          costPerKg: Decimal;
          totalCost: Decimal;
        }> = [];

        // Process container sources
        if (hasSources) {
          for (const source of sources) {
            const cId = parseInt(source.containerId);
            const wKg = parseMoneyInput(source.weightKg);
            const cPKg = parseMoneyInput(source.costPerKg);

            if (isNaN(cId) || !wKg || !cPKg || wKg.lessThanOrEqualTo(0)) {
              throw new Error("Invalid container source data");
            }

            const [rawStock] = await tx
              .select()
              .from(productionRawStock)
              .where(and(eq(productionRawStock.companyId, companyId), eq(productionRawStock.containerId, cId)))
              .for("update");

            if (!rawStock) {
              throw new Error(`Container ${cId} not found in production raw stock. Offload it first.`);
            }

            const remaining = toMoney(rawStock.receivedKg).minus(toMoney(rawStock.usedKg));
            if (wKg.greaterThan(remaining.plus(0.001))) {
              throw new Error(
                `Container ${rawStock.containerId} only has ${remaining.toFixed(3)} kg remaining, requested ${wKg}`
              );
            }

            const newUsed = toMoney(rawStock.usedKg).plus(wKg);
            await tx
              .update(productionRawStock)
              .set({ usedKg: newUsed.toFixed(3) })
              .where(eq(productionRawStock.id, rawStock.id));

            const sCost = wKg.times(cPKg);
            totalWeightKg = totalWeightKg.plus(wKg);
            totalCost = totalCost.plus(sCost);
            validatedSources.push({ containerId: cId, weightKg: wKg, costPerKg: cPKg, totalCost: sCost });
          }
        }

        // Process existing batch sources
        if (hasBatchSources) {
          for (const bSrc of batchSources) {
            const srcBatchId = parseInt(bSrc.sourceBatchId);
            const wKg = parseMoneyInput(bSrc.weightKg);

            if (isNaN(srcBatchId) || !wKg || wKg.lessThanOrEqualTo(0)) {
              throw new Error("Invalid batch source data");
            }

            const [srcBatch] = await tx
              .select()
              .from(mixBatches)
              .where(and(eq(mixBatches.id, srcBatchId), eq(mixBatches.companyId, companyId)))
              .for("update");

            if (!srcBatch) {
              throw new Error(`Source batch ${srcBatchId} not found`);
            }

            const srcTotal = toMoney(srcBatch.totalWeightKg);
            const srcUsed = toMoney(srcBatch.usedKg);
            const srcRemaining = srcTotal.minus(srcUsed);

            if (wKg.greaterThan(srcRemaining.plus(0.001))) {
              throw new Error(
                `Batch ${srcBatch.batchCode} only has ${srcRemaining.toFixed(3)} kg remaining, requested ${wKg}`
              );
            }

            // Deduct from source batch's usedKg
            const newUsed = srcUsed.plus(wKg);
            await tx
              .update(mixBatches)
              .set({
                usedKg: newUsed.toFixed(3),
                status: newUsed.greaterThanOrEqualTo(srcTotal.minus(0.001)) ? "COMPLETED" : srcBatch.status,
              })
              .where(eq(mixBatches.id, srcBatchId));

            const srcCostPerKg = toMoney(srcBatch.costPerKg);
            const sCost = wKg.times(srcCostPerKg);
            totalWeightKg = totalWeightKg.plus(wKg);
            totalCost = totalCost.plus(sCost);
            validatedSources.push({
              sourceBatchId: srcBatchId,
              weightKg: wKg,
              costPerKg: srcCostPerKg,
              totalCost: sCost,
            });
          }
        }

        const blendedCostPerKg = totalWeightKg.greaterThan(0)
          ? totalCost.dividedBy(totalWeightKg)
          : new MoneyDecimal(0);

        const [batch] = await tx
          .insert(mixBatches)
          .values({
            companyId,
            batchCode,
            name: name || batchCode,
            totalWeightKg: totalWeightKg.toFixed(3),
            usedKg: "0",
            costPerKg: blendedCostPerKg.toFixed(4),
            totalCost: totalCost.toFixed(2),
            notes: batchData.notes || null,
            status: "ACTIVE",
          })
          .returning();

        for (const src of validatedSources) {
          await tx.insert(mixBatchSources).values({
            mixBatchId: batch.id,
            containerId: src.containerId || null,
            sourceBatchId: src.sourceBatchId || null,
            weightKg: src.weightKg.toFixed(3),
            costPerKg: src.costPerKg.toFixed(4),
            totalCost: src.totalCost.toFixed(2),
          });
        }

        return batch;
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating mix batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
