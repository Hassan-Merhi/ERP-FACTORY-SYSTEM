/**
 * factoryMixBatchRoutes: FactoryMixBatchSource endpoints.
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
import {
  factorySuppliers,
  factoryContainers,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { MoneyDecimal, sumMoney, toMoney } from "../../../lib/money";
import { getClientDate } from "../../../lib/dateUtils";
import {
  baleCostFromMix,
  FACTORY_COST_SCALE,
  mixCostForPressing,
  rawSourceUsdRate,
  sendFactoryCostBasisRefusal,
} from "../../../services/factory/baleCostBasis";

export function registerFactoryMixBatchSourceRoutes(app: Express) {
  // Assign existing (unlinked) bales to a mix batch
  app.post("/api/factory/mix-batches/:id/assign-bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const mixBatchId = parseId(req.params.id);

      if (mixBatchId === null) return res.status(400).json({ message: "Invalid id" });
      const { baleIds } = req.body as { baleIds: number[] };

      if (!Array.isArray(baleIds) || baleIds.length === 0) {
        return res.status(400).json({ message: "baleIds must be a non-empty array" });
      }

      const [batch] = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, mixBatchId), eq(factoryMixBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Mix batch not found" });

      const bales = await db
        .select({
          id: factoryBales.id,
          weightKg: factoryBales.weightKg,
          mixBatchId: factoryBales.mixBatchId,
          status: factoryBales.status,
        })
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));

      if (bales.length !== baleIds.length) {
        return res.status(400).json({ message: "One or more bale IDs are invalid" });
      }
      const alreadyLinked = bales.filter((b) => b.mixBatchId !== null);
      if (alreadyLinked.length > 0) {
        return res.status(400).json({ message: `${alreadyLinked.length} bale(s) are already linked to a mix batch` });
      }

      const totalKg = sumMoney(bales.map((b) => b.weightKg));
      const availableKg = toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg));

      if (totalKg.greaterThan(availableKg.plus(0.001))) {
        return res.status(400).json({
          message: `Not enough remaining kg in this batch (need ${totalKg.toFixed(3)}, have ${availableKg.toFixed(3)})`,
        });
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(factoryBales).set({ mixBatchId, updatedAt: now }).where(inArray(factoryBales.id, baleIds));

        // Wave 11: a bale from a mix costs weight × the mix's USD cost per kg, so
        // the mix weight this relieves is the bale value. Unsold bales take it;
        // sold bales keep the cost their sale took. A mix with no cost refuses
        // under perpetual inventory and leaves the bales' cost before it.
        const mixCost = await mixCostForPressing(tx, companyId, getClientDate(req), batch);
        if (mixCost.gt(0)) {
          for (const bale of bales) {
            if (
              !["IN_STOCK", "RESERVED_FOR_ORDER", "RESERVED_FOR_DISPATCH", "PENDING_PRESSING"].includes(bale.status)
            ) {
              continue;
            }
            const cost = baleCostFromMix(bale.weightKg, mixCost);
            await tx
              .update(factoryBales)
              .set({
                costPerKg: cost.costPerKg.toFixed(FACTORY_COST_SCALE),
                totalCost: cost.totalCost.toFixed(FACTORY_COST_SCALE),
              })
              .where(and(eq(factoryBales.id, bale.id), eq(factoryBales.companyId, companyId)));
          }
        }

        await tx
          .update(factoryMixBatches)
          .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${totalKg.toFixed(3)}`, updatedAt: now })
          .where(eq(factoryMixBatches.id, mixBatchId));
      });

      res.json({ success: true, balesUpdated: baleIds.length, totalKg: totalKg.toNumber() });
    } catch (error: unknown) {
      if (sendFactoryCostBasisRefusal(res, error)) return;
      logger.error("Error assigning bales to mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/mix-batches/:id/sources", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [batch] = await db
        .select({ id: factoryMixBatches.id })
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));
      if (!batch) return res.status(404).json({ message: "Mix batch not found" });

      const results = await db
        .select({
          id: factoryMixBatchSources.id,
          mixBatchId: factoryMixBatchSources.mixBatchId,
          containerId: factoryMixBatchSources.containerId,
          supplierId: factoryMixBatchSources.supplierId,
          sourceBatchId: factoryMixBatchSources.sourceBatchId,
          sourceType: factoryMixBatchSources.sourceType,
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          totalCost: factoryMixBatchSources.totalCost,
          createdAt: factoryMixBatchSources.createdAt,
          containerNumber: factoryContainers.containerNumber,
          supplierName: factorySuppliers.name,
          sourceBatchCode: sql<string>`(SELECT batch_code FROM factory_mix_batches WHERE id = ${factoryMixBatchSources.sourceBatchId})`,
        })
        .from(factoryMixBatchSources)
        .leftJoin(factoryContainers, eq(factoryMixBatchSources.containerId, factoryContainers.id))
        .leftJoin(factorySuppliers, eq(factoryMixBatchSources.supplierId, factorySuppliers.id))
        .where(eq(factoryMixBatchSources.mixBatchId, id));

      // For any source row with a stored costPerKg of 0 (or null), look up the
      // actual weighted-average cost from factoryRawStock so the breakdown
      // display always shows a meaningful number.
      const enriched = await Promise.all(
        results.map(async (src) => {
          if (toMoney(src.costPerKg).greaterThan(0)) return src;

          // Show the source's USD rate now (the supplier's locked rate, else the
          // container's landed USD cost; never a native-currency cost). A source
          // with none is flagged: its mix is unvalued (wave 11).
          const usdRate = await rawSourceUsdRate(db, companyId, {
            supplierId: src.supplierId,
            containerId: src.containerId,
          });
          const fallbackCost = usdRate?.rate ?? new MoneyDecimal(0);
          if (!fallbackCost.greaterThan(0)) return { ...src, noUsdRate: true };
          // Shown at the stored column scale (7 places), half up.
          return {
            ...src,
            costPerKg: fallbackCost.toFixed(7),
            totalCost: toMoney(src.weightKg).times(fallbackCost).toFixed(7),
          };
        })
      );

      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching mix batch sources:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 6b. Mix Batch Daily Consumption
  // ───────────────────────────────────────────────
}
