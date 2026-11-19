// Extracted from ./stockTransferImportRoutes.ts to keep that module under the source-size cap.
import type { Express, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { readExcel, sheetToJson } from "../excelHelper";
import { inventory } from "@shared/schema";
import { toMoney } from "../lib/money";
import { resolveTransferLocations } from "./helpers/transferLocations";
import type { ParsedStockTransferItem, SpreadsheetRow, ValidatedStockTransferItem } from "./stockTransferImportTypes";
import { type Decimal, requestQuantity, rowQuantity } from "./stockTransferImportQuantity";
import { type ProvisionalRateBasis, StockTransferImportSourceMissingError } from "./stockTransferImportPosting";
import { sendBaleMirrorMovementRefusal } from "../services/accounting/perpetualInventory/cutoverRefusal";

/** Sends a wave 11/15 refusal (bale mirror, missing source after the cut-over); returns whether it did. */
/** The lines moved at a provisional cost (wave 17 B), for the response. */
export function provisionalRatesOf(
  lines: ReadonlyArray<{ stockItemId: number; rate: Decimal; provisional?: ProvisionalRateBasis }>
): Array<{ stockItemId: number; rate: string; basis: ProvisionalRateBasis }> {
  return lines
    .filter((line) => line.provisional)
    .map((line) => ({ stockItemId: line.stockItemId, rate: line.rate.toFixed(2), basis: line.provisional! }));
}

export function sendStockTransferImportRefusal(res: Response, error: unknown): boolean {
  if (sendBaleMirrorMovementRefusal(res, error)) return true;
  if (!(error instanceof StockTransferImportSourceMissingError)) return false;
  res.status(409).json({ code: error.code, message: error.message, lines: error.lines });
  return true;
}

export function registerStockTransferImportRoutesPart1(app: Express) {
  // ============= Stock Transfer Import Endpoints =============

  // Stock Transfer Import - Parse and Preview Excel
  app.post("/api/stock-transfer-import/parse", requireAuth, spreadsheetUpload.single("file"), async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rawData = sheetToJson(worksheet);

      if (rawData.length === 0) {
        return res.status(400).json({ message: "Excel file is empty" });
      }

      // Parse rows
      const rows = rawData as SpreadsheetRow[];
      const items: ParsedStockTransferItem[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        // Expected columns: Barcode, Quantity
        const barcode = row.Barcode || row.barcode || row.Code || row.code;
        const quantity = rowQuantity(row);

        if (!barcode) {
          continue; // Skip rows without barcode
        }

        if (quantity <= 0) {
          continue; // Skip invalid quantities
        }

        items.push({
          rowNum,
          barcode: barcode.toString().trim(),
          quantity,
        });
      }

      res.json({
        items,
        totalItems: items.length,
        fileName: req.file.originalname,
      });
    } catch (error: unknown) {
      logger.error("Stock Transfer Import parse error:", { error: error });
      // File-parse errors are client errors (bad/corrupt file) — return 400, not 500
      res.status(400).json({ message: getErrorMessage(error) || "Failed to parse Excel file" });
    }
  });

  // Stock Transfer Import - Validate data before import
  app.post("/api/stock-transfer-import/validate", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { sourceLocationId, destinationLocationId, items } = req.body;

      if (!sourceLocationId || !destinationLocationId || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (sourceLocationId && sourceLocationId === destinationLocationId) {
        return res.status(400).json({ message: "Source and destination must be different" });
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      const validatedItems: ValidatedStockTransferItem[] = [];

      // Validate locations exist in this company (body ids are outside the path-based scope).
      const { sourceLocation, destLocation, foreignItemSource } = await resolveTransferLocations(
        req.session.currentCompanyId,
        sourceLocationId,
        destinationLocationId,
        items
      );

      if (!sourceLocation) {
        errors.push("Source location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      if (!destLocation) {
        errors.push("Destination location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      if (foreignItemSource) {
        errors.push("Source location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      // Validate each item
      for (const item of items) {
        const validatedItem: ValidatedStockTransferItem = { ...item };

        // Find stock item by barcode (code or alias)
        const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);

        if (!stockItem) {
          validatedItem.error = `Barcode '${item.barcode}' not found in stock items`;
          errors.push(`Row ${item.rowNum}: Barcode '${item.barcode}' not found`);
        } else {
          validatedItem.stockItemId = stockItem.id;
          validatedItem.stockItemName = stockItem.name;
          validatedItem.stockItemUom = stockItem.uom;

          // Check source location inventory
          const [inventoryItem] = await db
            .select()
            .from(inventory)
            .where(
              and(
                eq(inventory.stockItemId, stockItem.id),
                eq(inventory.locationId, item.sourceLocationId || sourceLocationId)
              )
            )
            .limit(1);

          if (inventoryItem) {
            const currentQty = toMoney(inventoryItem.quantity).toNumber();
            const transferQty = requestQuantity(item.quantity).toNumber();
            const remainingQty = currentQty - transferQty;

            validatedItem.currentStock = currentQty;
            validatedItem.remainingStock = remainingQty;
            validatedItem.averageRate = inventoryItem.averageRate;

            if (remainingQty < 0) {
              validatedItem.warning = `Stock will go negative (Available: ${currentQty.toFixed(2)})`;
              warnings.push(
                `${stockItem.name}: Stock will go negative (Available: ${currentQty.toFixed(2)}, Requested: ${transferQty.toFixed(2)})`
              );
            }
          } else {
            validatedItem.currentStock = 0;
            validatedItem.remainingStock = -requestQuantity(item.quantity).toNumber();
            validatedItem.averageRate = "0";
            validatedItem.warning = `No stock at source location, will go negative`;
            warnings.push(`${stockItem.name}: No stock at source location`);
          }
        }

        validatedItems.push(validatedItem);
      }

      res.json({
        errors,
        warnings,
        validatedItems,
      });
    } catch (error: unknown) {
      logger.error("Stock Transfer Import validation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
