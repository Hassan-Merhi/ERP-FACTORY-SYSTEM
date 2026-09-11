/**
 * inventoryMovementRoutes: LocationImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, checkPOSLocation } from "../../auth";
import {
  privilegedConcurrencyLimit,
  privilegedMutationRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import { stockItemCodeAliases } from "@shared/schema";

const locationImportBudget = privilegedRequestBudget({
  maxBodyBytes: 1024 * 1024,
  maxCollectionItems: 2_000,
});
const locationImportConcurrency = privilegedConcurrencyLimit({ scope: "location-import" });

export function registerLocationImportRoutes(app: Express) {
  // Update cost prices by barcode for a location
  app.post(
    "/api/locations/:locationId/import-cost-prices",
    requireAuth,
    requireRole("Developer"),
    checkPOSLocation,
    privilegedMutationRateLimit,
    locationImportBudget,
    locationImportConcurrency,
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) {
          return res.status(400).json({ message: "Invalid location ID" });
        }

        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const location = await storage.getLocationById(locationId);
        if (!location) {
          return res.status(404).json({ message: "Location not found" });
        }

        if (location.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({
            message: "Access denied: Location belongs to a different company",
          });
        }

        const { updates } = req.body;
        if (!Array.isArray(updates)) {
          return res.status(400).json({ message: "Updates must be an array" });
        }

        const result = await storage.updateCostPricesByBarcode(locationId, req.session.currentCompanyId, updates);
        res.json(result);
      } catch (error: unknown) {
        logger.error("Error updating cost prices:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Bulk import inventory for a location
  app.post(
    "/api/locations/:locationId/import-inventory",
    requireAuth,
    checkPOSLocation,
    privilegedMutationRateLimit,
    locationImportBudget,
    locationImportConcurrency,
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) {
          return res.status(400).json({ message: "Invalid location ID" });
        }

        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        // Validate location exists and belongs to current company
        const location = await storage.getLocationById(locationId);
        if (!location) {
          return res.status(404).json({ message: "Location not found" });
        }

        if (location.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({
            message: "Access denied: Location belongs to a different company",
          });
        }

        const { items } = req.body;
        if (!Array.isArray(items)) {
          return res.status(400).json({ message: "Items must be an array" });
        }

        // Get all stock items and stock groups for code matching
        const allStockItems = await storage.getAllStockItems(req.session.currentCompanyId);
        const allStockGroups = await storage.getAllStockGroups(req.session.currentCompanyId);

        const results = {
          created: [] as { code: unknown; itemName: string; quantity: number }[],
          updated: [] as { code: unknown; itemName: string; addedQuantity: number; newQuantity: number }[],
          skipped: [],
          errors: [] as { code?: unknown; reason?: string; error?: string }[],
        };

        // Per-session barcode registry: once a barcode resolves to an item it
        // ALWAYS resolves to that same item for the rest of this import run.
        // This prevents the same barcode from ever mapping to more than one product.
        const barcodeItemMap = new Map();

        for (const item of items) {
          try {
            const barcodeKey = item.Item_barcode.trim().toLowerCase();

            // 1. Check session-local registry first (fastest, no DB hit)
            let stockItem = barcodeItemMap.get(barcodeKey) ?? null;

            // 2. If not seen this session, look up in DB (code field OR alias)
            if (!stockItem) {
              stockItem =
                (await storage.getStockItemByCodeOrAlias(item.Item_barcode, req.session.currentCompanyId)) ?? null;
              if (stockItem) barcodeItemMap.set(barcodeKey, stockItem);
            }

            // If stock item doesn't exist, create it
            if (!stockItem) {
              // ── Name-match check: if an existing item's NAME equals the
              //    uploaded barcode string, register the barcode as an alias
              //    and reuse that item instead of creating a duplicate. ─────
              const nameMatch = allStockItems.find((si) => si.name.trim().toLowerCase() === barcodeKey);

              if (nameMatch) {
                // Guard: only register alias if the barcode isn't already the
                // primary code of a *different* item (belt-and-suspenders check)
                const alreadyACode = allStockItems.find(
                  (si) => si.id !== nameMatch.id && si.code.trim().toLowerCase() === barcodeKey
                );
                if (!alreadyACode) {
                  await db
                    .insert(stockItemCodeAliases)
                    .values({
                      stockItemId: nameMatch.id,
                      aliasCode: item.Item_barcode.trim(),
                      companyId: req.session.currentCompanyId!,
                    })
                    .onConflictDoNothing();
                }
                stockItem = alreadyACode ?? nameMatch;
                barcodeItemMap.set(barcodeKey, stockItem);
              } else {
                // Auto-detect stock group from item code prefix (first 2-3 uppercase letters)
                let stockGroupId: number | null = null;

                // Normalize and try to extract prefix from Item_barcode
                const normalizedCode = item.Item_barcode.trim().toUpperCase();

                // Try 3-letter prefix first, then 2-letter (e.g., "UN259" -> "UN", "GCC123" -> "GCC")
                const prefixes = [];
                if (normalizedCode.length >= 3) prefixes.push(normalizedCode.substring(0, 3));
                if (normalizedCode.length >= 2) prefixes.push(normalizedCode.substring(0, 2));

                for (const prefix of prefixes) {
                  const stockGroup = allStockGroups.find((sg) => sg.code.toUpperCase() === prefix);
                  if (stockGroup) {
                    stockGroupId = stockGroup.id;
                    break; // Found a match, stop searching
                  }
                }

                // Fall back to stockGroupCode column if provided and prefix didn't match
                if (!stockGroupId && item.stockGroupCode) {
                  const stockGroup = allStockGroups.find(
                    (sg) => (sg.code || "").toLowerCase() === (item.stockGroupCode || "").toLowerCase()
                  );
                  if (stockGroup) {
                    stockGroupId = stockGroup.id;
                  }
                }

                // Require valid stock group - reject if none found
                if (!stockGroupId) {
                  results.errors.push({
                    code: item.Item_barcode,
                    reason: `No matching stock group found for code prefix. Please create stock item "${item.Item_barcode}" manually with a valid stock group first.`,
                  });
                  continue;
                }

                // Create the stock item
                const newStockItem = await storage.createStockItem({
                  companyId: req.session.currentCompanyId,
                  code: item.Item_barcode,
                  name: item.Item_barcode, // Use Item_barcode as name if not provided
                  uom: "PCS", // Default unit
                  stockGroupId: stockGroupId,
                  active: true,
                });

                stockItem = newStockItem;
                allStockItems.push(newStockItem); // Add to cache for subsequent rows
                barcodeItemMap.set(barcodeKey, newStockItem); // lock barcode in session registry
              } // end else (no name match → create new)
            }

            const quantity = parseFloat(item.quantity || "0");
            const rate = parseFloat(item.rate || "0");
            const value = parseFloat(item.value || (quantity * rate).toString());

            // Check if inventory already exists for this item at this location
            const existingInventory = await storage.getLocationInventory(req.session.currentCompanyId!, locationId);
            const existing = existingInventory.find((inv) => inv.stockItemId === stockItem.id);

            if (existing) {
              // Update existing inventory - add to existing quantities
              const newQuantity = parseFloat(existing.quantity) + quantity;
              const newTotalValue = parseFloat(existing.totalValue) + value;
              const newAverageRate = newQuantity > 0 ? newTotalValue / newQuantity : 0;

              await storage.updateInventory(
                locationId,
                stockItem.id,
                newQuantity.toString(),
                newAverageRate.toString(),
                newTotalValue.toString()
              );

              results.updated.push({
                code: item.Item_barcode,
                itemName: stockItem.name,
                addedQuantity: quantity,
                newQuantity: newQuantity,
              });
            } else {
              // Create new inventory record
              await storage.updateInventory(
                locationId,
                stockItem.id,
                quantity.toString(),
                rate.toString(),
                value.toString()
              );

              results.created.push({
                code: item.Item_barcode,
                itemName: stockItem.name,
                quantity: quantity,
              });
            }
          } catch (error: unknown) {
            results.errors.push({
              code: item.code,
              error: getErrorMessage(error),
            });
          }
        }

        res.json({
          message: `Import completed: ${results.created.length} created, ${results.updated.length} updated, ${results.skipped.length} skipped, ${results.errors.length} errors`,
          results,
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
