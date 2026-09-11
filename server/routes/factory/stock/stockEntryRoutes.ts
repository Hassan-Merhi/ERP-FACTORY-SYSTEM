/**
 * factoryStockRoutes: FactoryStockEntry endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { resolveStockEntryProductionAttributions } from "../../../services/factory/stockEntryProductionAttribution";
import { writeDaybookEntry } from "../_helpers";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryMixBatches,
  factoryBales,
  factoryBaleSequences,
  factoryBaleProductionAttributions,
  stockItems,
  stockGroups,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerFactoryStockEntryRoutes(app: Express) {
  app.post("/api/factory/stock-entry", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { items, erpLocationId, mixBatchId, entryDate } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "items array is required" });
      }
      if (!erpLocationId) {
        return res.status(400).json({ message: "Location is required" });
      }

      // Parse optional backdated entry date; default to today so history is always populated
      let effectiveEntryDate: Date | null = null;
      let effectiveDateStr: string = getClientDate(req);
      if (entryDate && typeof entryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
        effectiveEntryDate = new Date(entryDate + "T00:00:00.000Z");
        effectiveDateStr = entryDate;
      }

      const result = await db.transaction(async (tx) => {
        let mixBatch = null;
        if (mixBatchId) {
          const [mb] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, mixBatchId), eq(factoryMixBatches.companyId, companyId)))
            .for("update");
          if (!mb) throw new Error("Mix batch not found");
          mixBatch = mb;
        }

        const totalExpected = items.reduce((sum: number, item) => sum + parseInt(item.quantity || item.qty || "1"), 0);

        const [seqRecord] = await tx
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        // Always derive safe floor from actual DB max to handle stale sequences
        const [maxRow] = await tx
          .select({
            m: sql<number>`COALESCE(MAX(CAST(REGEXP_REPLACE(reference_number, '[^0-9]', '', 'g') AS BIGINT)), 100875)`,
          })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), sql`reference_number ~ '^REF[0-9]+'`));
        const dbMax = Math.max((Number(maxRow?.m) || 199999) + 1, 200000);

        let nextNumber: number;
        if (seqRecord) {
          nextNumber = Math.max(seqRecord.nextNumber, dbMax);
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + totalExpected })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = dbMax;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: nextNumber + totalExpected,
          });
        }

        const now = new Date();
        const finalizedAtTs = effectiveEntryDate ?? now;
        let baleIndex = 0;
        let totalWeight = 0;

        const productIds: number[] = [];
        for (const item of items) {
          if (item.productId && !productIds.includes(item.productId)) productIds.push(item.productId);
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

        // Resolve worker and production-position attribution against the exact
        // stock-entry date. This validates company scope and effective-dated
        // membership, auto-selects a single eligible position, and requires an
        // explicit choice when a worker belongs to multiple positions.
        const productionAttributions = await resolveStockEntryProductionAttributions(
          tx,
          companyId,
          effectiveDateStr,
          items
        );

        // ── Build all bale rows in memory, track per-bale metadata for later ──
        const baleValues: (typeof factoryBales.$inferInsert)[] = [];
        const baleProductRefs: (typeof factoryBaleProducts.$inferSelect)[] = [];
        const baleAttributionRefs: Awaited<ReturnType<typeof resolveStockEntryProductionAttributions>>[number][] = [];

        for (const [itemIndex, item] of items.entries()) {
          const qty = parseInt(item.quantity || item.qty || "1");
          const rawWeight = item.weightPerBale ?? item.weightPerBaleKg ?? "25";
          const weight = parseFloat(String(rawWeight)) || 25;
          const product = productMap.get(item.productId);
          if (!product) throw new Error(`Product ID ${item.productId} not found`);
          const categoryName: string | null = product.categoryId
            ? categoryMap.get(product.categoryId)?.name || null
            : null;
          const attribution = productionAttributions[itemIndex];
          const isGarbage = product.articleCode?.startsWith("HMD16");
          const productionCostPerKg = parseFloat(product.productionPrice || "0");
          const effectiveCostPerKg = isGarbage ? 0 : productionCostPerKg;
          const baleTotalCost = weight * effectiveCostPerKg;

          for (let i = 0; i < qty; i++) {
            const refNum = `REF${String(nextNumber + baleIndex).padStart(6, "0")}`;
            baleValues.push({
              companyId,
              mixBatchId: mixBatchId || null,
              productId: item.productId,
              erpLocationId,
              baleCode: product.code,
              referenceNumber: refNum,
              articleCode: product.articleCode,
              productName: product.name,
              category: categoryName,
              weightKg: String(weight),
              costPerKg: String(effectiveCostPerKg),
              totalCost: String(baleTotalCost),
              status: "IN_STOCK",
              finalizedAt: finalizedAtTs,
              finalizedBy: attribution.workerId,
              workerName: attribution.workerName,
              stockEntryDate: effectiveDateStr,
            });
            baleProductRefs.push(product);
            baleAttributionRefs.push(attribution);
            totalWeight += weight;
            baleIndex++;
          }
        }

        // ── Single bulk INSERT for all bales ──
        const insertedBales = await tx.insert(factoryBales).values(baleValues).returning();

        // Keep the worker + production-position snapshot atomically attached to
        // every new Stock Entry bale. Null position is intentional for workers
        // with no configured production position and for unassigned bales.
        if (insertedBales.length > 0) {
          await tx.insert(factoryBaleProductionAttributions).values(
            insertedBales.map((bale, idx: number) => {
              const attribution = baleAttributionRefs[idx];
              return {
                companyId,
                baleId: bale.id,
                workerId: attribution.workerId,
                workerNameSnapshot: attribution.workerName,
                productionPositionId: attribution.productionPositionId,
                productionPositionNameSnapshot: attribution.productionPositionName,
                stockEntryDate: effectiveDateStr,
              };
            })
          );
        }

        const bales = insertedBales.map((b, idx: number) => {
          const attribution = baleAttributionRefs[idx];
          return {
            ...b,
            _product: baleProductRefs[idx],
            productionPositionId: attribution.productionPositionId,
            productionPositionName: attribution.productionPositionName,
          };
        });

        if (mixBatch) {
          const mixRemaining = parseFloat(mixBatch.totalWeightKg) - parseFloat(mixBatch.usedKg || "0");
          if (totalWeight > mixRemaining + 0.001) {
            throw new Error(
              `Not enough mix batch remaining. Need ${totalWeight.toFixed(3)} kg but only ${mixRemaining.toFixed(3)} kg available`
            );
          }

          await tx
            .update(factoryMixBatches)
            .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${totalWeight}`, updatedAt: now })
            .where(eq(factoryMixBatches.id, mixBatchId));
        }

        const stockGroupCache = new Map<string, number>();
        const stockItemCache = new Map<string, number>();
        // Accumulate inventory adjustments per stockItemId instead of per bale
        const inventoryAdjMap = new Map<number, { qty: number; totalCost: number }>();

        for (const bale of bales) {
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

          // Accumulate instead of calling adjustInventory per bale
          const baleWeight = parseFloat(bale.weightKg);
          const baleRate = baleWeight * parseFloat(bale.costPerKg || "0");
          const prev = inventoryAdjMap.get(erpStockItemId!) ?? { qty: 0, totalCost: 0 };
          inventoryAdjMap.set(erpStockItemId!, { qty: prev.qty + 1, totalCost: prev.totalCost + baleRate });
        }

        // A stock entry has no header row of its own — it writes a batch of
        // bales — so the canonical journal keys its evidence on the smallest
        // bale id in the batch. That is unique to this entry, deterministic
        // from the rows written in this transaction, and stable afterwards
        // because bale ids are never reused.
        const canonicalBatchKey = insertedBales.length
          ? String(Math.min(...insertedBales.map((bale: { id: number }) => Number(bale.id))))
          : null;

        // ── One adjustInventory call per unique stock item ──
        for (const [stockItemId, { qty, totalCost }] of inventoryAdjMap) {
          const avgRatePerBale = qty > 0 ? totalCost / qty : 0;
          await adjustInventory(tx, erpLocationId, stockItemId, qty, companyId, avgRatePerBale);

          // Canonical evidence for the stock this entry received, on the same
          // transaction that applied it. The unit cost is the batch's average
          // cost per bale for this item, which is the rate the inventory was
          // updated with.
          if (canonicalBatchKey && qty > 0) {
            await postStockMovementTx(
              tx,
              {
                companyId,
                stockItemId,
                kind: "receipt",
                quantity: String(qty),
                unitCost: avgRatePerBale.toFixed(6),
                toLocationId: erpLocationId,
                occurredAt: new Date().toISOString(),
                source: {
                  sourceType: "factory-stock-entry",
                  sourceId: canonicalBatchKey,
                  idempotencyKey: `factory-stock-entry:${canonicalBatchKey}:${stockItemId}`,
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }
        }

        return { bales, totalWeight };
      });

      const today = effectiveDateStr || getClientDate(req);
      // Build a meaningful description with product names and reference codes
      const productGroups = new Map<string, string[]>();
      for (const bale of result.bales) {
        const name = bale.productName || bale.articleCode || "Unknown";
        const ref = bale.referenceNumber || bale.baleCode || "";
        if (!productGroups.has(name)) productGroups.set(name, []);
        if (ref) productGroups.get(name)!.push(ref);
      }
      const descParts = Array.from(productGroups.keys());
      const stockEntryDesc = `${result.bales.length} bale${result.bales.length !== 1 ? "s" : ""} - ${descParts.join(" | ")}`;
      const totalBaleValue = result.bales.reduce((sum: number, b) => {
        const prodPrice = parseFloat(b._product?.productionPrice || "0");
        return sum + prodPrice;
      }, 0);
      const baleMetaJson = JSON.stringify({
        bales: result.bales.map((b) => ({
          id: b.id,
          ref: b.referenceNumber,
          productName: b.productName || b.articleCode || "Unknown",
          weightKg: b.weightKg,
          status: b.status || "IN_STOCK",
          workerId: b.finalizedBy ?? null,
          workerName: b.workerName ?? null,
          productionPositionId: b.productionPositionId ?? null,
          productionPositionName: b.productionPositionName ?? null,
        })),
      });
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_STOCK_ENTRY",
        description: stockEntryDesc,
        amountCurrency: totalBaleValue,
        amountUsd: totalBaleValue,
        metaJson: baleMetaJson,
      });

      res.json({ bales: result.bales, totalWeight: result.totalWeight });
    } catch (error: unknown) {
      logger.error("Error in stock entry:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // BALE IMPORT - Historical bales from Excel
  // ───────────────────────────────────────────────

  app.post("/api/factory/bales/import", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { erpLocationId, bales } = req.body;
      if (!erpLocationId) return res.status(400).json({ message: "Location is required" });
      if (!bales || !Array.isArray(bales) || bales.length === 0) {
        return res.status(400).json({ message: "No bales to import" });
      }

      for (const b of bales) {
        if (!b.itemName || !b.barcode || !b.weight) {
          return res.status(400).json({
            message: `Each bale must have itemName, barcode, and weight. Problem row: ${b.itemName || b.barcode || "unknown"}`,
          });
        }
        if (isNaN(parseFloat(b.weight)) || parseFloat(b.weight) <= 0) {
          return res.status(400).json({ message: `Invalid weight for ${b.itemName}: ${b.weight}` });
        }
      }

      const allIntendedRefs: string[] = [];
      const payloadDupes = new Set<string>();
      for (const b of bales) {
        const base = b.refNumber && b.refNumber.trim() ? b.refNumber.trim() : b.barcode.trim();
        const qty = parseInt(b.quantity) || 1;
        const refs = qty === 1 ? [base] : Array.from({ length: qty }, (_, i) => `${base}-${i + 1}`);
        for (const ref of refs) {
          if (allIntendedRefs.includes(ref)) payloadDupes.add(ref);
          allIntendedRefs.push(ref);
        }
      }
      if (payloadDupes.size > 0) {
        return res
          .status(400)
          .json({ message: `Duplicate ref numbers within import file: ${Array.from(payloadDupes).join(", ")}` });
      }

      const result = await db.transaction(async (tx) => {
        const existingBarcodes = await tx
          .select({ referenceNumber: factoryBales.referenceNumber })
          .from(factoryBales)
          .where(eq(factoryBales.companyId, companyId));
        const existingRefSet = new Set(existingBarcodes.map((b) => b.referenceNumber));

        const conflicting = allIntendedRefs.filter((ref) => existingRefSet.has(ref));
        if (conflicting.length > 0) {
          throw new Error(
            `Barcodes already exist in system: ${conflicting.slice(0, 10).join(", ")}${conflicting.length > 10 ? ` and ${conflicting.length - 10} more` : ""}`
          );
        }

        const allProducts = await tx
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.companyId, companyId));
        type ImportedStockProduct = (typeof allProducts)[number];
        const productByName = new Map<string, ImportedStockProduct>(
          allProducts.map((p: ImportedStockProduct) => [p.name.toLowerCase(), p] as const)
        );

        const createdBales: (typeof factoryBales.$inferSelect)[] = [];
        let totalWeight = 0;

        for (const b of bales) {
          const itemName = b.itemName.trim();
          const weight = parseFloat(b.weight);
          const qty = parseInt(b.quantity) || 1;
          const barcode = b.barcode.trim();

          let product = productByName.get(itemName.toLowerCase());
          if (!product) {
            const autoPrefix = "HMD00";
            const autoPrefixLen = autoPrefix.length;
            const [autoMaxResult] = await tx
              .select({
                maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${factoryBaleProducts.articleCode} FROM ${autoPrefixLen + 1}) AS INTEGER)), 0)`,
              })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  sql`${factoryBaleProducts.articleCode} LIKE ${autoPrefix + "%"}`,
                  sql`SUBSTRING(${factoryBaleProducts.articleCode} FROM ${autoPrefixLen + 1}) ~ '^[0-9]+$'`
                )
              );
            let autoNextNum = (autoMaxResult?.maxNum || 0) + 1;
            let articleCode = `${autoPrefix}${String(autoNextNum).padStart(3, "0")}`;
            let autoAttempts = 0;
            while (autoAttempts < 100) {
              const [dupCheck] = await tx
                .select({ id: factoryBaleProducts.id })
                .from(factoryBaleProducts)
                .where(
                  and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, articleCode))
                );
              if (!dupCheck) break;
              autoNextNum++;
              articleCode = `${autoPrefix}${String(autoNextNum).padStart(3, "0")}`;
              autoAttempts++;
            }
            const code = articleCode;

            const [newProduct] = await tx
              .insert(factoryBaleProducts)
              .values({
                companyId,
                code,
                articleCode,
                name: itemName,
                active: true,
              })
              .returning();
            product = newProduct;
            productByName.set(itemName.toLowerCase(), product);
          }

          for (let i = 0; i < qty; i++) {
            const pressedAt = b.productionDate ? new Date(b.productionDate) : null;
            const refBase = b.refNumber && b.refNumber.trim() ? b.refNumber.trim() : barcode;
            const refNum = qty === 1 ? refBase : `${refBase}-${i + 1}`;

            const [bale] = await tx
              .insert(factoryBales)
              .values({
                companyId,
                productId: product.id,
                erpLocationId,
                baleCode: product.code,
                referenceNumber: refNum,
                articleCode: product.articleCode,
                productName: product.name,
                weightKg: String(weight),
                costPerKg: "0",
                totalCost: "0",
                status: "IN_STOCK",
                finalizedAt: new Date(),
                ...(pressedAt && !isNaN(pressedAt.getTime()) ? { pressedAt } : {}),
              })
              .returning();

            createdBales.push(bale);
            totalWeight += weight;
          }
        }

        const stockItemCache = new Map<string, number>();

        for (const bale of createdBales) {
          const product = productByName.get((bale.productName as string).toLowerCase());
          if (!product) continue;
          const itemCode: string = product.articleCode || product.code;
          if (!itemCode) continue;

          let erpStockItemId = stockItemCache.get(itemCode);
          if (!erpStockItemId) {
            const [existing] = await tx
              .select({ id: stockItems.id })
              .from(stockItems)
              .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));

            if (existing) {
              erpStockItemId = existing.id;
            } else {
              const [created] = await tx
                .insert(stockItems)
                .values({ companyId, code: itemCode, name: product.name as string, uom: "BALE", active: true })
                .returning({ id: stockItems.id });
              erpStockItemId = created.id;
            }
            stockItemCache.set(itemCode, erpStockItemId!);
          }

          await adjustInventory(tx, erpLocationId, erpStockItemId!, 1, companyId, 0);
        }

        return { bales: createdBales, totalWeight, count: createdBales.length };
      });

      const today = getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_IMPORT",
        description: `Imported ${result.count} historical bale(s) into stock (${result.totalWeight.toFixed(1)} kg)`,
      });

      res.json({ imported: result.count, totalWeight: result.totalWeight, bales: result.bales });
    } catch (error: unknown) {
      logger.error("Error importing bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
