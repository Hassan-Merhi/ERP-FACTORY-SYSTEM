// Extracted from ./stockTransferImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { inventory } from "@shared/schema";
import { toMoney } from "../lib/money";
import type { ValidatedStockTransferItem } from "./stockTransferImportTypes";

export function registerStockTransferImportRoutesPart3(app: Express) {
  // Multi-source Stock Transfer Import - Validate
  app.post("/api/stock-transfer-import/validate-multi-source", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { destinationLocationId, items } = req.body;

      if (!destinationLocationId || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      const validatedItems: ValidatedStockTransferItem[] = [];

      // Validate destination location exists in this company
      const destLocation = await storage.getLocationById(destinationLocationId);
      if (!destLocation || destLocation.companyId !== req.session.currentCompanyId) {
        errors.push("Destination location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      // Get all locations for name lookup
      const allLocations = await storage.getAllLocations(req.session.currentCompanyId!);
      const locationsByName: Record<string, number> = {};
      allLocations.forEach((loc) => {
        locationsByName[(loc.name || "").toLowerCase().trim()] = loc.id;
      });

      // Validate each item
      for (const item of items) {
        const validatedItem: ValidatedStockTransferItem = { ...item };

        // Find source location by name
        const sourceLocationName = item.sourceLocation?.toLowerCase().trim();
        if (!sourceLocationName) {
          validatedItem.error = "Source location is required";
          errors.push(`Row ${item.rowNum}: Source location is required`);
          validatedItems.push(validatedItem);
          continue;
        }

        const sourceLocationId = locationsByName[sourceLocationName];
        if (!sourceLocationId) {
          validatedItem.error = `Source location '${item.sourceLocation}' not found`;
          errors.push(`Row ${item.rowNum}: Source location '${item.sourceLocation}' not found`);
          validatedItems.push(validatedItem);
          continue;
        }

        if (sourceLocationId && sourceLocationId === destinationLocationId) {
          validatedItem.error = "Source and destination cannot be the same";
          errors.push(`Row ${item.rowNum}: Source and destination cannot be the same`);
          validatedItems.push(validatedItem);
          continue;
        }

        validatedItem.sourceLocationId = sourceLocationId;

        // Find stock item by barcode (code or alias)
        const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);

        if (!stockItem) {
          validatedItem.error = `Barcode '${item.barcode}' not found in stock items`;
          errors.push(`Row ${item.rowNum}: Barcode '${item.barcode}' not found`);
        } else {
          validatedItem.stockItemId = stockItem.id;
          validatedItem.stockItemName = stockItem.name;

          // Check inventory at source location
          const inventoryResult = await db
            .select()
            .from(inventory)
            .where(
              and(
                eq(inventory.companyId, req.session.currentCompanyId!),
                eq(inventory.locationId, item.sourceLocationId || sourceLocationId),
                eq(inventory.stockItemId, stockItem.id)
              )
            )
            .limit(1);

          const invRecord = inventoryResult[0];
          if (!invRecord) {
            validatedItem.warning = `No inventory at source location '${item.sourceLocation}', will go negative`;
            validatedItem.currentStock = 0;
            validatedItem.rate = "0";
            warnings.push(`Row ${item.rowNum}: '${stockItem.name}' has no inventory at '${item.sourceLocation}'`);
          } else {
            const currentQty = toMoney(invRecord.quantity).toNumber();
            validatedItem.currentStock = currentQty;
            validatedItem.rate = invRecord.averageRate;

            if (item.quantity > currentQty) {
              validatedItem.warning = `Stock will go negative (available: ${currentQty.toFixed(2)})`;
              warnings.push(
                `Row ${item.rowNum}: '${stockItem.name}' - requested ${item.quantity}, available ${currentQty.toFixed(2)}`
              );
            }
          }
        }

        validatedItems.push(validatedItem);
      }

      res.json({
        success: errors.length === 0,
        errors,
        warnings,
        validatedItems,
      });
    } catch (error: unknown) {
      logger.error("Stock Transfer Validate error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
