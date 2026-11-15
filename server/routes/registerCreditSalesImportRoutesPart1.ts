// Extracted from ./creditSalesImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { readExcel, sheetToJson } from "../excelHelper";
import { parseMoneyInput, sumMoney, toMoney } from "../lib/money";
import type Decimal from "decimal.js";
import { inventory } from "@shared/schema";

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/** An import row's quantity and rate, read as parseFloat reads them; null unless both are positive. */
export function importLineAmounts(quantity: unknown, rate: unknown) {
  const q = parseMoneyInput(String(quantity ?? ""));
  const r = parseMoneyInput(String(rate ?? ""));
  if (!q || !r || !q.gt(0) || !r.gt(0)) return null;
  return { quantity: q, rate: r };
}

export function registerCreditSalesImportRoutesPart1(app: Express) {
  // ============= Credit Sales Import Endpoints =============

  // Credit Sales Import - Parse and Preview Excel (same as POS but for credit sales)
  app.post("/api/credit-sales-import/parse", requireAuth, spreadsheetUpload.single("file"), async (req, res) => {
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

      const rows = rawData;
      const items: { rowNum: number; barcode: string; quantity: number; rate: number; value: number }[] = [];
      const values: Decimal[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        const barcode = row.Barcode || row.barcode || row.Code || row.code;
        const amounts = importLineAmounts(
          row.Quantity || row.quantity || row.Qty || row.qty || "0",
          row.Rate || row.rate || row.Price || row.price || "0"
        );

        if (!barcode) {
          continue;
        }

        if (!amounts) {
          continue;
        }

        const itemValue = amounts.quantity.times(amounts.rate);
        values.push(itemValue);

        items.push({
          rowNum,
          barcode: String(barcode).trim(),
          quantity: amounts.quantity.toNumber(),
          rate: amounts.rate.toNumber(),
          value: itemValue.toNumber(),
        });
      }

      res.json({
        items,
        totalValue: sumMoney(values).toNumber(),
        fileName: req.file.originalname,
      });
    } catch (error: unknown) {
      logger.error("Credit Sales Import parse error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Credit Sales Import - Validate data before import
  app.post("/api/credit-sales-import/validate", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { locationId, items } = req.body;

      if (!locationId || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      const validatedItems: Record<string, unknown>[] = [];

      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== req.session.currentCompanyId) {
        errors.push("Selected location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      for (const item of items) {
        const validatedItem = { ...item };

        const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);

        if (!stockItem) {
          validatedItem.error = `Barcode '${item.barcode}' not found in stock items`;
          errors.push(`Row ${item.rowNum}: Barcode '${item.barcode}' not found`);
        } else {
          validatedItem.stockItemId = stockItem.id;
          validatedItem.stockItemName = stockItem.name;
          validatedItem.stockItemUom = stockItem.uom;

          const inventoryItem = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, stockItem.id), eq(inventory.locationId, locationId)))
            .limit(1);

          if (inventoryItem.length > 0) {
            validatedItem.costPrice = toMoney(inventoryItem[0].averageRate).toNumber();
            const currentQty = toMoney(inventoryItem[0].quantity);
            const saleQty = toMoney(item.quantity);
            const remainingQty = currentQty.minus(saleQty);

            validatedItem.currentStock = currentQty.toNumber();
            validatedItem.remainingStock = remainingQty.toNumber();

            if (remainingQty.lt(0)) {
              validatedItem.warning = `Stock will go negative (${remainingQty.toFixed(2)} ${stockItem.uom})`;
              warnings.push(
                `${stockItem.name}: Stock will go negative (Current: ${currentQty.toFixed(2)}, Selling: ${saleQty.toFixed(2)}, Remaining: ${remainingQty.toFixed(2)} ${stockItem.uom})`
              );
            } else if (remainingQty.isZero()) {
              validatedItem.warning = `Stock will reach zero`;
              warnings.push(
                `${stockItem.name}: Stock will reach zero (Current: ${currentQty.toFixed(2)}, Selling: ${saleQty.toFixed(2)} ${stockItem.uom})`
              );
            }
          } else {
            validatedItem.currentStock = 0;
            validatedItem.remainingStock = toMoney(item.quantity).neg().toNumber();
            validatedItem.warning = `No stock at this location, will go negative`;
            warnings.push(`${stockItem.name}: No stock at this location (Selling: ${item.quantity} ${stockItem.uom})`);
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
      logger.error("Credit Sales Import validation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
