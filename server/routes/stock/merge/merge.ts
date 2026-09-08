/**
 * stockMergeRoutes: StockItemMerge endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
} from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  inventory,
  stockItems,
  stockItemCodeAliases,
  stockItemMergeLogs,
  stockItemLocationPrices,
  poLineItems,
  locations,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

export function registerStockItemMergeRoutes(app: Express) {
  app.get("/api/stock-items/:id/merge-preview", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const keptId = parseInt(req.params.id);
      const duplicateId = parseInt(req.query.duplicateId as string);
      if (isNaN(keptId) || isNaN(duplicateId)) return res.status(400).json({ message: "Invalid item IDs" });
      if (keptId === duplicateId) return res.status(400).json({ message: "Cannot merge an item into itself" });

      const [keptItem] = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.id, keptId), eq(stockItems.companyId, companyId)));
      const [duplicateItem] = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.id, duplicateId), eq(stockItems.companyId, companyId)));

      if (!keptItem) return res.status(404).json({ message: "Kept item not found in this company" });
      if (!duplicateItem) return res.status(404).json({ message: "Duplicate item not found in this company" });
      if (duplicateItem.deletedAt)
        return res.status(400).json({ message: "Duplicate item is already deleted or merged" });

      const warnings: string[] = [];
      if (keptItem.uom !== duplicateItem.uom) {
        warnings.push(
          `UOM mismatch: kept item is "${keptItem.uom}", duplicate is "${duplicateItem.uom}". Phase 1 blocks this merge.`
        );
      }

      const keptInv = await db
        .select()
        .from(inventory)
        .where(and(eq(inventory.stockItemId, keptId), eq(inventory.companyId, companyId)));
      const dupInv = await db
        .select()
        .from(inventory)
        .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.companyId, companyId)));

      const allLocationIds = [...new Set([...keptInv.map((r) => r.locationId), ...dupInv.map((r) => r.locationId)])];
      const locationRows =
        allLocationIds.length > 0
          ? await db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(inArray(locations.id, allLocationIds))
          : [];
      const locationNameMap = new Map(locationRows.map((l) => [l.id, l.name]));

      const keptMap = new Map(keptInv.map((r) => [r.locationId, r]));
      const dupMap = new Map(dupInv.map((r) => [r.locationId, r]));

      const impactLocations = [];
      for (const locId of Array.from(dupMap.keys())) {
        const dupRow = dupMap.get(locId)!;
        const keptRow = keptMap.get(locId);
        const dupQty = parseFloat(dupRow.quantity);
        const dupValue = parseFloat(dupRow.totalValue);
        const dupRate = parseFloat(dupRow.averageRate);
        const keptQty = keptRow ? parseFloat(keptRow.quantity) : 0;
        const keptValue = keptRow ? parseFloat(keptRow.totalValue) : 0;
        const keptRate = keptRow ? parseFloat(keptRow.averageRate) : 0;
        const combinedQty = keptQty + dupQty;
        const combinedValue = keptValue + dupValue;
        const combinedRate = combinedQty > 0 ? combinedValue / combinedQty : 0;
        impactLocations.push({
          locationId: locId,
          locationName: locationNameMap.get(locId) ?? `Location ${locId}`,
          keptQty,
          keptValue,
          keptRate,
          dupQty,
          dupValue,
          dupRate,
          combinedQty,
          combinedValue,
          combinedRate,
          action: keptRow ? "combine" : "reassign",
        });
      }
      for (const locId of Array.from(keptMap.keys())) {
        if (!dupMap.has(locId)) {
          const r = keptMap.get(locId)!;
          impactLocations.push({
            locationId: locId,
            locationName: locationNameMap.get(locId) ?? `Location ${locId}`,
            keptQty: parseFloat(r.quantity),
            keptValue: parseFloat(r.totalValue),
            keptRate: parseFloat(r.averageRate),
            dupQty: 0,
            dupValue: 0,
            dupRate: 0,
            combinedQty: parseFloat(r.quantity),
            combinedValue: parseFloat(r.totalValue),
            combinedRate: parseFloat(r.averageRate),
            action: "no_change",
          });
        }
      }

      const totalValueBefore = [...keptInv, ...dupInv].reduce((s, r) => s + parseFloat(r.totalValue), 0);
      const totalValueAfter = impactLocations.reduce((s, l) => s + l.combinedValue, 0);

      const keptAliases = await db
        .select()
        .from(stockItemCodeAliases)
        .where(eq(stockItemCodeAliases.stockItemId, keptId));
      const dupAliases = await db
        .select()
        .from(stockItemCodeAliases)
        .where(eq(stockItemCodeAliases.stockItemId, duplicateId));
      const keptAliasCodes = new Set([keptItem.code, ...keptAliases.map((a) => a.aliasCode)]);
      const conflictCount =
        dupAliases.filter((a) => keptAliasCodes.has(a.aliasCode)).length +
        (keptAliasCodes.has(duplicateItem.code) ? 1 : 0);
      if (conflictCount > 0) {
        warnings.push(`${conflictCount} alias code(s) conflict with kept item codes and will be skipped.`);
      }

      return res.json({
        keptItem: { id: keptItem.id, code: keptItem.code, name: keptItem.name, uom: keptItem.uom },
        duplicateItem: {
          id: duplicateItem.id,
          code: duplicateItem.code,
          name: duplicateItem.name,
          uom: duplicateItem.uom,
        },
        uomMismatch: keptItem.uom !== duplicateItem.uom,
        inventoryImpact: impactLocations,
        totalValueBefore,
        totalValueAfter,
        warnings,
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-items/:id/merge", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // `users.id` is a varchar UUID and `session.userId` is a string; the old
      // `: number` annotation was untrue and only survived because `req` was `any`.
      const userId = req.user?.id ?? req.session.userId ?? "";

      const keptId = parseInt(req.params.id);
      const duplicateId = parseInt(req.body.duplicateId);
      const { confirm, notes } = req.body;

      if (isNaN(keptId) || isNaN(duplicateId)) return res.status(400).json({ message: "Invalid item IDs" });
      if (keptId === duplicateId) return res.status(400).json({ message: "Cannot merge an item into itself" });
      if (confirm !== "MERGE") return res.status(400).json({ message: 'Type "MERGE" to confirm' });

      const [keptItem] = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.id, keptId), eq(stockItems.companyId, companyId)));
      const [duplicateItem] = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.id, duplicateId), eq(stockItems.companyId, companyId)));

      if (!keptItem) return res.status(404).json({ message: "Kept item not found in this company" });
      if (!duplicateItem) return res.status(404).json({ message: "Duplicate item not found in this company" });
      if (duplicateItem.deletedAt)
        return res.status(400).json({ message: "Duplicate item is already deleted or merged" });
      if (keptItem.uom !== duplicateItem.uom) {
        return res.status(400).json({
          message: `UOM mismatch: "${keptItem.uom}" vs "${duplicateItem.uom}". Phase 1 blocks UOM mismatches.`,
        });
      }

      const keptInvBefore = await db
        .select()
        .from(inventory)
        .where(and(eq(inventory.stockItemId, keptId), eq(inventory.companyId, companyId)));
      const dupInvBefore = await db
        .select()
        .from(inventory)
        .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.companyId, companyId)));

      const totalValueBefore = addInventoryValues(...[...keptInvBefore, ...dupInvBefore].map((row) => row.totalValue));

      const snapshotBefore: Record<string, unknown> = {};
      for (const r of [...keptInvBefore, ...dupInvBefore]) {
        snapshotBefore[`${r.stockItemId}_${r.locationId}`] = {
          stockItemId: r.stockItemId,
          locationId: r.locationId,
          quantity: r.quantity,
          averageRate: r.averageRate,
          totalValue: r.totalValue,
        };
      }

      // Captured from inside the transaction callback. The previous version
      // stashed it on `req` as an undeclared property, which only compiled
      // because `req` was `any`.
      let mergeSnapshotAfter: Record<string, unknown> = {};
      await db.transaction(async (tx) => {
        const keptMap = new Map(keptInvBefore.map((r) => [r.locationId, r]));

        for (const dupRow of dupInvBefore) {
          const locId = dupRow.locationId;
          const keptRow = keptMap.get(locId);
          if (!keptRow) {
            await tx
              .update(inventory)
              .set({ stockItemId: keptId, lastUpdated: new Date() })
              .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.locationId, locId)));
          } else {
            const combinedQty = addInventoryValues(keptRow.quantity, dupRow.quantity);
            const combinedValue = addInventoryValues(keptRow.totalValue, dupRow.totalValue);
            const combinedRate = divideInventoryValues(combinedValue, combinedQty);
            await tx
              .update(inventory)
              .set({
                quantity: inventoryQuantity(combinedQty),
                totalValue: inventoryMoney(combinedValue),
                averageRate: inventoryUnitCost(combinedRate),
                lastUpdated: new Date(),
              })
              .where(and(eq(inventory.stockItemId, keptId), eq(inventory.locationId, locId)));
            await tx
              .delete(inventory)
              .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.locationId, locId)));
          }
        }

        const dupAliases = await tx
          .select()
          .from(stockItemCodeAliases)
          .where(eq(stockItemCodeAliases.stockItemId, duplicateId));
        const keptAliases = await tx
          .select()
          .from(stockItemCodeAliases)
          .where(eq(stockItemCodeAliases.stockItemId, keptId));
        const keptAliasCodes = new Set([keptItem.code, ...keptAliases.map((a) => a.aliasCode)]);
        for (const alias of dupAliases) {
          if (keptAliasCodes.has(alias.aliasCode)) continue;
          await tx
            .update(stockItemCodeAliases)
            .set({ stockItemId: keptId })
            .where(eq(stockItemCodeAliases.id, alias.id));
          keptAliasCodes.add(alias.aliasCode);
        }
        if (!keptAliasCodes.has(duplicateItem.code)) {
          await tx.insert(stockItemCodeAliases).values({
            companyId,
            stockItemId: keptId,
            aliasCode: duplicateItem.code,
            description: `Merged from: ${duplicateItem.name}`,
          });
        }

        const dupPrices = await tx
          .select()
          .from(stockItemLocationPrices)
          .where(eq(stockItemLocationPrices.stockItemId, duplicateId));
        const keptPrices = await tx
          .select()
          .from(stockItemLocationPrices)
          .where(eq(stockItemLocationPrices.stockItemId, keptId));
        const keptPriceLocations = new Set(keptPrices.map((p) => p.locationId));
        for (const price of dupPrices) {
          if (!keptPriceLocations.has(price.locationId)) {
            await tx
              .update(stockItemLocationPrices)
              .set({ stockItemId: keptId })
              .where(eq(stockItemLocationPrices.id, price.id));
          } else {
            await tx.delete(stockItemLocationPrices).where(eq(stockItemLocationPrices.id, price.id));
          }
        }

        await tx
          .update(poLineItems)
          .set({ stockItemId: keptId, itemName: keptItem.name })
          .where(eq(poLineItems.stockItemId, duplicateId));

        await tx
          .update(stockItems)
          .set({ active: false, deletedAt: new Date(), name: `[MERGED] ${duplicateItem.name}` })
          .where(eq(stockItems.id, duplicateId));

        const keptInvAfter = await tx
          .select()
          .from(inventory)
          .where(and(eq(inventory.stockItemId, keptId), eq(inventory.companyId, companyId)));
        const totalValueAfter = addInventoryValues(...keptInvAfter.map((row) => row.totalValue));
        if (totalValueAfter.minus(totalValueBefore).abs().greaterThan("0.02")) {
          throw new Error(
            `Value integrity check failed — before: ${inventoryMoney(totalValueBefore)}, after: ${inventoryMoney(totalValueAfter)}`
          );
        }

        const snapshotAfter: Record<string, unknown> = {};
        for (const r of keptInvAfter) {
          snapshotAfter[`${r.stockItemId}_${r.locationId}`] = {
            stockItemId: r.stockItemId,
            locationId: r.locationId,
            quantity: r.quantity,
            averageRate: r.averageRate,
            totalValue: r.totalValue,
          };
        }
        mergeSnapshotAfter = snapshotAfter;
      });

      try {
        await db.insert(stockItemMergeLogs).values({
          companyId,
          keptItemId: keptId,
          keptItemCode: keptItem.code.slice(0, 50),
          keptItemName: keptItem.name,
          mergedItemId: duplicateId,
          mergedItemCode: duplicateItem.code.slice(0, 50),
          mergedItemName: duplicateItem.name,
          snapshotBefore,
          snapshotAfter: mergeSnapshotAfter,
          mergedByUserId: String(userId),
          notes: notes ?? null,
        });
      } catch (auditErr: unknown) {
        logger.error("[Merge] Audit log insert failed (merge succeeded):", { error: getErrorMessage(auditErr) });
      }

      return res.json({ success: true, keptItemId: keptId, mergedItemId: duplicateId });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
