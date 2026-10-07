/**
 * factoryBalesRoutes: BalesFinalize endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { isFactorySessionLocation } from "../../helpers/companyOwnership";
import { requireAuth } from "../../../auth";

import { adjustInventory } from "../../../inventoryHelper";
import { writeDaybookEntry, checkFactoryAdmin } from "../_helpers";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryPressingBatches,
  factoryBales,
  stockItems,
  stockGroups,
  locations,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

/** Bale cost columns are numeric(20, 7). */
const BALE_COST_SCALE = 7;

/**
 * Blended cost per kg of a mix batch's sources, each priced at its
 * container's raw-stock cost when there is one; null when the sources
 * weigh nothing.
 */
function blendedSourceCost(
  sources: Array<{ weightKg: string; costPerKg: string; containerId: number | null }>,
  rawStockCostMap: Map<number, Decimal>
): Decimal | null {
  let totalCost = new MoneyDecimal(0);
  let totalWeight = new MoneyDecimal(0);
  for (const src of sources) {
    const w = toMoney(src.weightKg);
    const c = (src.containerId && rawStockCostMap.get(src.containerId)) || toMoney(src.costPerKg);
    totalCost = totalCost.plus(w.times(c));
    totalWeight = totalWeight.plus(w);
  }
  return totalWeight.greaterThan(0) ? totalCost.dividedBy(totalWeight) : null;
}
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerBalesFinalizeRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 9. Factory Finalize
  // ───────────────────────────────────────────────

  app.post("/api/factory/finalize", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { pressingBatchId, scannedBaleIds, erpLocationId, mixBatchId } = req.body;

      if (!pressingBatchId || !scannedBaleIds || !erpLocationId || !mixBatchId) {
        return res
          .status(400)
          .json({ message: "pressingBatchId, scannedBaleIds, erpLocationId, and mixBatchId are required" });
      }
      if (!(await isFactorySessionLocation(req.session, erpLocationId))) {
        return res.status(400).json({ message: "Location not found" });
      }

      const result = await db.transaction(async (tx) => {
        const [pressingBatch] = await tx
          .select()
          .from(factoryPressingBatches)
          .where(and(eq(factoryPressingBatches.id, pressingBatchId), eq(factoryPressingBatches.companyId, companyId)));

        if (!pressingBatch) throw new Error("Pressing batch not found");
        if (pressingBatch.status === "FINALIZED") throw new Error("Pressing batch is already fully finalized");

        const [mixBatch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, mixBatchId), eq(factoryMixBatches.companyId, companyId)))
          .for("update");

        if (!mixBatch) throw new Error("Mix batch not found");

        const mixRemaining = toMoney(mixBatch.totalWeightKg).minus(toMoney(mixBatch.usedKg));

        const pendingBales = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.pressingBatchId, pressingBatchId), eq(factoryBales.status, "PENDING_PRESSING")));

        const scannedSet = new Set(scannedBaleIds);
        const pendingBaleIds = new Set(pendingBales.map((b) => b.id));
        for (const scannedId of scannedBaleIds) {
          if (!pendingBaleIds.has(scannedId)) {
            throw new Error(`Bale ID ${scannedId} is not a valid pending bale for this pressing batch`);
          }
        }

        const balesToFinalize = pendingBales.filter((b) => scannedSet.has(b.id));
        const missingBales = pendingBales.filter((b) => !scannedSet.has(b.id));

        let totalWeight = new MoneyDecimal(0);
        for (const bale of balesToFinalize) {
          totalWeight = totalWeight.plus(toMoney(bale.weightKg));
        }

        if (totalWeight.greaterThan(mixRemaining.plus(0.001))) {
          throw new Error(
            `Not enough mix batch remaining. Need ${totalWeight.toFixed(3)} kg but only ${mixRemaining.toFixed(3)} kg available`
          );
        }

        // Derive bale cost from raw stock source prices (not mix batch blended cost).
        // This ensures duty updates after mix batch creation are reflected in bale costs.
        const mixSources = await tx
          .select({
            weightKg: factoryMixBatchSources.weightKg,
            costPerKg: factoryMixBatchSources.costPerKg,
            containerId: factoryMixBatchSources.containerId,
          })
          .from(factoryMixBatchSources)
          .where(eq(factoryMixBatchSources.mixBatchId, mixBatchId));

        let costPerKg: Decimal;
        if (mixSources.length > 0) {
          const sourceContainerIds = mixSources.map((s) => s.containerId).filter(Boolean) as number[];
          const rawStockCostMap = new Map<number, Decimal>();
          if (sourceContainerIds.length > 0) {
            const rawStockRecs = await tx
              .select({ containerId: factoryRawStock.containerId, costPerKg: factoryRawStock.costPerKg })
              .from(factoryRawStock)
              .where(inArray(factoryRawStock.containerId, sourceContainerIds));
            for (const r of rawStockRecs) {
              rawStockCostMap.set(r.containerId, toMoney(r.costPerKg));
            }
          }
          costPerKg = blendedSourceCost(mixSources, rawStockCostMap) ?? toMoney(mixBatch.costPerKg);
        } else {
          costPerKg = toMoney(mixBatch.costPerKg);
        }

        const now = new Date();
        const updatedBales = [];

        for (const bale of balesToFinalize) {
          const baleTotalCost = toMoney(bale.weightKg).times(costPerKg);

          const [updated] = await tx
            .update(factoryBales)
            .set({
              status: "IN_STOCK",
              erpLocationId,
              mixBatchId,
              costPerKg: costPerKg.toFixed(BALE_COST_SCALE),
              totalCost: baleTotalCost.toFixed(BALE_COST_SCALE),
              finalizedAt: now,
              updatedAt: now,
            })
            .where(eq(factoryBales.id, bale.id))
            .returning();

          updatedBales.push(updated);
        }

        await tx
          .update(factoryMixBatches)
          .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${totalWeight.toFixed()}`, updatedAt: now })
          .where(eq(factoryMixBatches.id, mixBatchId));

        const isFullyFinalized = missingBales.length === 0;
        await tx
          .update(factoryPressingBatches)
          .set({
            status: isFullyFinalized ? "FINALIZED" : "PARTIALLY_FINALIZED",
            mixBatchId,
            finalizedAt: isFullyFinalized ? now : null,
            finalizedLocationId: erpLocationId,
          })
          .where(eq(factoryPressingBatches.id, pressingBatchId));

        const productIds: number[] = [];
        for (const b of balesToFinalize) {
          if (b.productId && !productIds.includes(b.productId)) productIds.push(b.productId);
        }
        const factoryProducts =
          productIds.length > 0
            ? await tx.select().from(factoryBaleProducts).where(inArray(factoryBaleProducts.id, productIds))
            : [];

        const productMap = new Map(factoryProducts.map((p) => [p.id, p]));

        const categoryIdSet = new Set<number>();
        factoryProducts.forEach((p) => {
          if (p.categoryId) categoryIdSet.add(p.categoryId);
        });
        const categoryIds = Array.from(categoryIdSet);
        const factoryCats =
          categoryIds.length > 0
            ? await tx.select().from(factoryCategories).where(inArray(factoryCategories.id, categoryIds))
            : [];
        const categoryMap = new Map(factoryCats.map((c) => [c.id, c]));

        const stockGroupCache = new Map<string, number>();

        const stockItemCache = new Map<string, number>();

        for (const bale of balesToFinalize) {
          const factoryProduct = productMap.get(bale.productId as number);
          if (!factoryProduct) continue;

          const itemCode: string = factoryProduct.articleCode || factoryProduct.code;
          if (!itemCode) continue;

          let stockGroupId: number | null = null;
          if (factoryProduct.categoryId) {
            const cat = categoryMap.get(factoryProduct.categoryId);
            if (cat) {
              const catName = cat.name as string;
              const catId = cat.id as number;
              const cacheKey = String(catId || catName);
              const cached = stockGroupCache.get(cacheKey);
              if (cached) {
                stockGroupId = cached;
              } else {
                const [existingGroup] = await tx
                  .select({ id: stockGroups.id })
                  .from(stockGroups)
                  .where(and(eq(stockGroups.companyId, companyId), eq(stockGroups.name, catName)));

                if (existingGroup) {
                  stockGroupId = existingGroup.id;
                } else {
                  // Use the category's own ID for a collision-free code
                  const groupCode = catId
                    ? `FCAT-${catId}`
                    : "F-" +
                      catName
                        .replace(/[^A-Z0-9]/gi, "")
                        .substring(0, 10)
                        .toUpperCase();
                  const [created] = await tx
                    .insert(stockGroups)
                    .values({ companyId, name: catName, code: groupCode })
                    .onConflictDoNothing()
                    .returning({ id: stockGroups.id });
                  if (created) {
                    stockGroupId = created.id;
                  } else {
                    const [byCode] = await tx
                      .select({ id: stockGroups.id })
                      .from(stockGroups)
                      .where(and(eq(stockGroups.companyId, companyId), eq(stockGroups.code, groupCode)));
                    stockGroupId = byCode?.id;
                  }
                }
                stockGroupCache.set(cacheKey, stockGroupId!);
              }
            }
          }

          let erpStockItemId: number | undefined = stockItemCache.get(itemCode);

          if (!erpStockItemId) {
            const [existing] = await tx
              .select({ id: stockItems.id, stockGroupId: stockItems.stockGroupId })
              .from(stockItems)
              .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));

            if (existing) {
              erpStockItemId = existing.id;
              if (stockGroupId && !existing.stockGroupId) {
                await tx.update(stockItems).set({ stockGroupId }).where(eq(stockItems.id, existing.id));
              }
            } else {
              const [created] = await tx
                .insert(stockItems)
                .values({
                  companyId,
                  code: itemCode,
                  name: factoryProduct.name as string,
                  uom: "BALE",
                  active: true,
                  ...(stockGroupId ? { stockGroupId } : {}),
                })
                .returning({ id: stockItems.id });
              erpStockItemId = created.id;
            }
            stockItemCache.set(itemCode, erpStockItemId!);
          }

          const baleRate = toMoney(bale.weightKg).times(toMoney(bale.costPerKg));

          await adjustInventory(tx, erpLocationId, erpStockItemId!, 1, companyId, baleRate.toNumber());

          // Canonical evidence for the bale this finalisation brought into ERP
          // stock, on the same transaction that raised the inventory. A bale is
          // one unit at its own cost, and its id is the natural document key —
          // finalising the same bale twice is a replay, not a second unit.
          await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId: erpStockItemId!,
              kind: "receipt",
              quantity: "1",
              unitCost: baleRate.toFixed(6),
              toLocationId: erpLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "factory-bale-finalize",
                sourceId: String(bale.id),
                idempotencyKey: `factory-bale-finalize:${bale.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        return {
          updated: updatedBales.length,
          bales: updatedBales,
          missingBales: missingBales.map((b) => ({
            id: b.id,
            referenceNumber: b.referenceNumber,
            productName: b.productName,
            articleCode: b.articleCode,
            weightKg: b.weightKg,
          })),
          isFullyFinalized,
        };
      });

      const today = req.body.txDate || getClientDate(req);
      const [finalizeLocation] = await db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, erpLocationId));
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_FINALIZE",
        referenceId: pressingBatchId,
        description: `Finalized ${result.updated} bale${result.updated !== 1 ? "s" : ""} to ${finalizeLocation?.name || `location #${erpLocationId}`}`,
        amountCurrency: 0,
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error finalizing pressing batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Backfill historical bale costs from raw stock source prices
  app.post("/api/factory/bales/backfill-costs", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const balesWithMix = await db
        .select({
          id: factoryBales.id,
          weightKg: factoryBales.weightKg,
          mixBatchId: factoryBales.mixBatchId,
          articleCode: factoryBales.articleCode,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.status, "IN_STOCK"),
            sql`${factoryBales.mixBatchId} IS NOT NULL`
          )
        );

      if (balesWithMix.length === 0) return res.json({ updated: 0 });

      const uniqueMixIds = [...new Set(balesWithMix.map((b) => b.mixBatchId))] as number[];

      const allSources = await db
        .select({
          mixBatchId: factoryMixBatchSources.mixBatchId,
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          containerId: factoryMixBatchSources.containerId,
        })
        .from(factoryMixBatchSources)
        .where(inArray(factoryMixBatchSources.mixBatchId, uniqueMixIds));

      const allContainerIds = [...new Set(allSources.map((s) => s.containerId).filter(Boolean))] as number[];
      const rawStockCostMap = new Map<number, Decimal>();
      if (allContainerIds.length > 0) {
        const rawStockRecs = await db
          .select({ containerId: factoryRawStock.containerId, costPerKg: factoryRawStock.costPerKg })
          .from(factoryRawStock)
          .where(inArray(factoryRawStock.containerId, allContainerIds));
        for (const r of rawStockRecs) {
          rawStockCostMap.set(r.containerId, toMoney(r.costPerKg));
        }
      }

      const mixCostMap = new Map<number, Decimal>();
      for (const mixId of uniqueMixIds) {
        const sources = allSources.filter((s) => s.mixBatchId === mixId);
        if (sources.length === 0) continue;
        const blended = blendedSourceCost(sources, rawStockCostMap);
        if (blended) mixCostMap.set(mixId, blended);
      }

      let updated = 0;
      const now = new Date();
      for (const bale of balesWithMix) {
        const isGarbage = bale.articleCode?.startsWith("HMD16");
        if (isGarbage) continue;
        const newCost = bale.mixBatchId ? mixCostMap.get(bale.mixBatchId) : undefined;
        if (newCost === undefined) continue;
        const newTotal = toMoney(bale.weightKg).times(newCost);
        await db
          .update(factoryBales)
          .set({
            costPerKg: newCost.toFixed(BALE_COST_SCALE),
            totalCost: newTotal.toFixed(BALE_COST_SCALE),
            updatedAt: now,
          })
          .where(eq(factoryBales.id, bale.id));
        updated++;
      }

      res.json({ updated, message: `Updated cost for ${updated} finalized bales using raw stock prices.` });
    } catch (error: unknown) {
      logger.error("Error backfilling bale costs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
