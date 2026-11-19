/**
 * stockMergeRoutes: StockItemMerge endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { addInventoryValues, toInventoryDecimal } from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { inventory, stockItems, stockItemCodeAliases, locations } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { registerStockItemMergeRoutesPart1 } from "./registerStockItemMergeRoutesPart1";

/** A stored inventory numeric as a plain number for the preview; missing is 0. */
function previewNumber(value: string | null | undefined): number {
  return toInventoryDecimal(value).toNumber() || 0;
}

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
        // The preview adds exactly, as the merge itself does below.
        const combinedQty = addInventoryValues(keptRow?.quantity, dupRow.quantity);
        const combinedValue = addInventoryValues(keptRow?.totalValue, dupRow.totalValue);
        impactLocations.push({
          locationId: locId,
          locationName: locationNameMap.get(locId) ?? `Location ${locId}`,
          keptQty: previewNumber(keptRow?.quantity),
          keptValue: previewNumber(keptRow?.totalValue),
          keptRate: previewNumber(keptRow?.averageRate),
          dupQty: previewNumber(dupRow.quantity),
          dupValue: previewNumber(dupRow.totalValue),
          dupRate: previewNumber(dupRow.averageRate),
          combinedQty: combinedQty.toNumber(),
          combinedValue: combinedValue.toNumber(),
          combinedRate: combinedQty.greaterThan(0) ? combinedValue.dividedBy(combinedQty).toNumber() : 0,
          action: keptRow ? "combine" : "reassign",
        });
      }
      for (const locId of Array.from(keptMap.keys())) {
        if (!dupMap.has(locId)) {
          const r = keptMap.get(locId)!;
          impactLocations.push({
            locationId: locId,
            locationName: locationNameMap.get(locId) ?? `Location ${locId}`,
            keptQty: previewNumber(r.quantity),
            keptValue: previewNumber(r.totalValue),
            keptRate: previewNumber(r.averageRate),
            dupQty: 0,
            dupValue: 0,
            dupRate: 0,
            combinedQty: previewNumber(r.quantity),
            combinedValue: previewNumber(r.totalValue),
            combinedRate: previewNumber(r.averageRate),
            action: "no_change",
          });
        }
      }

      const totalValueBefore = addInventoryValues(...[...keptInv, ...dupInv].map((row) => row.totalValue)).toNumber();
      const totalValueAfter = addInventoryValues(...impactLocations.map((l) => l.combinedValue)).toNumber();

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

  registerStockItemMergeRoutesPart1(app);
}
