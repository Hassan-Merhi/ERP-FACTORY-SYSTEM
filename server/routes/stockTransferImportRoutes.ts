/**
 * Stock-transfer Excel-import routes.
 *
 * Parse/validate/import of stock-transfer spreadsheets, including the
 * multi-source variants and their template downloads. Extracted from
 * importRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { upload } from "./_helpers";
import { adjustInventory } from "../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { readExcel, sheetToJson, createWorkbook, jsonToSheet, writeWorkbook } from "../excelHelper";
import { getClientDate } from "../lib/dateUtils";
import { sendTransferWhatsApp } from "../helpers/sendTransferWhatsApp";
import { inventory, stockTransferVouchers, stockTransferItems, vouchers } from "@shared/schema";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

type SpreadsheetCell = string | number | null | undefined;
type SpreadsheetRow = Record<string, SpreadsheetCell>;

interface ParsedStockTransferItem {
  rowNum: number;
  barcode: string;
  quantity: number;
  sourceLocation?: string;
}

interface ValidatedStockTransferItem extends ParsedStockTransferItem {
  sourceLocationId?: number;
  stockItemId?: number;
  stockItemName?: string;
  stockItemUom?: string;
  currentStock?: number;
  remainingStock?: number;
  averageRate?: string | null;
  rate?: string | null;
  error?: string;
  warning?: string;
}

export function registerStockTransferImportRoutes(app: Express) {
  // ============= Stock Transfer Import Endpoints =============

  // Stock Transfer Import - Parse and Preview Excel
  app.post("/api/stock-transfer-import/parse", requireAuth, upload.single("file"), async (req, res) => {
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
        const quantity = parseFloat(String(row.Quantity || row.quantity || row.Qty || row.qty || "0"));

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

      // Validate locations exist
      const sourceLocation = await storage.getLocationById(sourceLocationId);
      const destLocation = await storage.getLocationById(destinationLocationId);

      if (!sourceLocation) {
        errors.push("Source location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      if (!destLocation) {
        errors.push("Destination location not found");
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
            const currentQty = parseFloat(inventoryItem.quantity || "0");
            const transferQty = parseFloat(item.quantity);
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
            validatedItem.remainingStock = -parseFloat(item.quantity);
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

  // Stock Transfer Import - Create stock transfer
  app.post("/api/stock-transfer-import/import", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { sourceLocationId, destinationLocationId, transferDate, items, notes } = req.body;

      if (!sourceLocationId || !destinationLocationId || !transferDate || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Validate locations
      const sourceLocation = await storage.getLocationById(sourceLocationId);
      const destLocation = await storage.getLocationById(destinationLocationId);

      if (!sourceLocation) {
        return res.status(400).json({ message: "Source location not found" });
      }

      if (!destLocation) {
        return res.status(400).json({ message: "Destination location not found" });
      }

      let totalValue = 0;
      const transferItems: Array<{ stockItemId: number; quantity: string; rate: string }> = [];

      // Prepare items with rates from inventory
      for (const item of items) {
        const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);

        if (!stockItem) {
          return res.status(400).json({ message: `Stock item not found: ${item.barcode}` });
        }

        // Get rate from source inventory
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

        // Use inventory rate if available, otherwise use stock item's selling price as fallback
        const rate = inventoryItem
          ? parseFloat(inventoryItem.averageRate || "0")
          : parseFloat(stockItem.sellingPrice || "0");
        const quantity = parseFloat(item.quantity);

        totalValue += rate * quantity;

        transferItems.push({
          stockItemId: stockItem.id,
          quantity: quantity.toString(),
          rate: rate.toString(),
        });
      }

      const voucherNumber = `ST-${Date.now()}`;
      await db.transaction(async (tx) => {
        // Create stock transfer voucher

        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            locationId: sourceLocationId,
            locationName: sourceLocation.name,
            voucherNumber,
            voucherType: "Stock Transfer",
            voucherDate: transferDate,
            description:
              notes || `Excel Import - ${items.length} items from ${sourceLocation.name} to ${destLocation.name}`,
            totalAmount: totalValue.toString(),
          })
          .returning();

        // Create stock transfer record
        const [transferRecord] = await tx
          .insert(stockTransferVouchers)
          .values({
            voucherId: voucher.id,
            sourceLocationId: sourceLocationId,
            destinationLocationId,
          })
          .returning();

        // Process each item
        for (const item of transferItems) {
          const itemTotal = parseFloat(item.quantity) * parseFloat(item.rate);

          // Create stock transfer item
          const [transferItem] = await tx
            .insert(stockTransferItems)
            .values({
              transferId: transferRecord.id,
              stockItemId: item.stockItemId,
              sourceLocationId,
              quantity: item.quantity,
              rate: item.rate,
              totalAmount: itemTotal.toString(),
            })
            .returning({ id: stockTransferItems.id });

          // Reduce source inventory
          await adjustInventory(
            tx,
            sourceLocationId,
            item.stockItemId,
            -parseFloat(item.quantity),
            req.session.currentCompanyId!
          );

          // Add to destination inventory
          await adjustInventory(
            tx,
            destinationLocationId,
            item.stockItemId,
            parseFloat(item.quantity),
            req.session.currentCompanyId!,
            parseFloat(item.rate)
          );

          await postStockMovementTx(
            tx,
            {
              companyId: req.session.currentCompanyId!,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: item.quantity,
              unitCost: String(Math.max(parseFloat(item.rate) || 0, 0)),
              fromLocationId: sourceLocationId,
              toLocationId: destinationLocationId,
              occurredAt: new Date(`${transferDate}T00:00:00.000Z`).toISOString(),
              source: {
                sourceType: "stock-transfer-import",
                sourceId: String(voucher.id),
                idempotencyKey: `stock-transfer-import:${voucher.id}:${transferItem.id}`,
              },
              actor: {
                userId: req.session.userId,
                username: req.session.username,
                reason: notes || `Excel stock transfer ${voucherNumber}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      });

      res.json({
        success: true,
        itemsCount: items.length,
        totalValue: totalValue.toFixed(2),
      });

      // Fire-and-forget: send transfer image to destination WA group
      const waItems = transferItems.map((i) => ({
        stockItemId: i.stockItemId,
        quantity: parseFloat(i.quantity),
      }));
      const waVoucher = voucherNumber;
      const waSrcName = sourceLocation.name;
      const waDstName = destLocation.name;
      const waDstId = destinationLocationId;
      const waDate = transferDate;
      setImmediate(async () => {
        try {
          await sendTransferWhatsApp({
            destinationLocationId: waDstId,
            sourceLocationName: waSrcName,
            destLocationName: waDstName,
            items: waItems,
            voucherNumber: waVoucher,
            voucherDate: waDate,
          });
        } catch (e: unknown) {
          logger.error("[TransferWA] Failed to send:", { error: getErrorMessage(e) });
        }
      });
    } catch (error: unknown) {
      logger.error("Stock Transfer Import error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Download sample Stock Transfer import template
  app.get("/api/stock-transfer-import/template", async (_req, res) => {
    try {
      const sampleData = [
        {
          Barcode: "BC001",
          Quantity: 5,
        },
        {
          Barcode: "BC002",
          Quantity: 10,
        },
        {
          Barcode: "BC003",
          Quantity: 15,
        },
      ];

      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Stock Transfer");

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Disposition", "attachment; filename=Stock_Transfer_Import_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Multi-source Stock Transfer Import - Template
  app.get("/api/stock-transfer-import/template-multi-source", async (_req, res) => {
    try {
      const sampleData = [
        {
          "Source Location": "Warehouse A",
          Barcode: "BC001",
          Quantity: 5,
        },
        {
          "Source Location": "Warehouse B",
          Barcode: "BC002",
          Quantity: 10,
        },
        {
          "Source Location": "Warehouse A",
          Barcode: "BC003",
          Quantity: 15,
        },
      ];

      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Stock Transfer");

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Disposition", "attachment; filename=Stock_Transfer_Multi_Source_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Multi-source Stock Transfer Import - Parse Excel
  app.post(
    "/api/stock-transfer-import/parse-multi-source",
    requireAuth,
    requireNonPOS,
    upload.single("file"),
    async (req, res) => {
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

        const rows = rawData as SpreadsheetRow[];
        const items: ParsedStockTransferItem[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 2;

          // Expected columns: Source Location, Barcode, Quantity
          const sourceLocation = row["Source Location"] || row.SourceLocation || row.sourceLocation || row.source || "";
          const barcode = row.Barcode || row.barcode || row.Code || row.code;
          const quantity = parseFloat(String(row.Quantity || row.quantity || row.Qty || row.qty || "0"));

          if (!barcode) {
            continue; // Skip rows without barcode
          }

          if (quantity <= 0) {
            continue; // Skip invalid quantities
          }

          items.push({
            rowNum,
            sourceLocation: String(sourceLocation).trim(),
            barcode: barcode.toString().trim(),
            quantity,
          });
        }

        if (items.length === 0) {
          return res.status(400).json({
            message: "No valid items found in Excel file. Expected columns: Source Location, Barcode, Quantity",
          });
        }

        res.json({
          success: true,
          items,
        });
      } catch (error: unknown) {
        logger.error("Stock Transfer Parse error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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

      // Validate destination location exists
      const destLocation = await storage.getLocationById(destinationLocationId);
      if (!destLocation) {
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
            const currentQty = parseFloat(invRecord.quantity);
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

  // Multi-source Stock Transfer Import - Execute Import
  app.post("/api/stock-transfer-import/import-multi-source", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { destinationLocationId, transferDate, notes, items } = req.body;

      if (!destinationLocationId || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Validate all items have required fields
      for (const item of items) {
        if (!item.stockItemId || !item.sourceLocationId || !item.quantity || item.error) {
          return res.status(400).json({
            message: "Some items have validation errors. Please validate and fix before importing.",
          });
        }
      }

      // Get destination location for the name - verify it belongs to this company
      const destLocation = await storage.getLocationById(destinationLocationId);
      if (!destLocation || destLocation.companyId !== req.session.currentCompanyId) {
        return res.status(400).json({ message: "Destination location not found or access denied" });
      }

      // Get all locations for this company for name lookup and validation
      const allLocations = await storage.getAllLocations(req.session.currentCompanyId!);
      const locationsById: Record<number, string> = {};
      const validLocationIds = new Set<number>();
      allLocations.forEach((loc) => {
        locationsById[loc.id] = loc.name;
        validLocationIds.add(loc.id);
      });

      // Re-validate items server-side and derive rates from inventory (don't trust client)
      const processedItems: Array<{
        stockItemId: number;
        sourceLocationId: number;
        quantity: number;
        rate: number;
      }> = [];

      for (const item of items) {
        // Validate source location belongs to this company
        if (!validLocationIds.has(item.sourceLocationId)) {
          return res.status(400).json({
            message: `Source location ${item.sourceLocationId} not found or access denied`,
          });
        }

        // Validate stock item exists and belongs to this company
        const stockItem = await storage.getStockItemById(item.stockItemId);
        if (!stockItem || stockItem.companyId !== req.session.currentCompanyId) {
          return res.status(400).json({
            message: `Stock item ${item.stockItemId} not found or access denied`,
          });
        }

        // Validate source != destination
        if (item.sourceLocationId === destinationLocationId) {
          return res.status(400).json({
            message: "Source and destination locations cannot be the same",
          });
        }

        // Get inventory at source location to derive rate (don't trust client rate)
        const sourceInv = await db
          .select()
          .from(inventory)
          .where(
            and(
              eq(inventory.companyId, req.session.currentCompanyId!),
              eq(inventory.locationId, item.sourceLocationId),
              eq(inventory.stockItemId, item.stockItemId)
            )
          )
          .limit(1);

        // Use server-derived rate from inventory, or stock item's selling price as fallback
        const serverRate = sourceInv[0]
          ? parseFloat(sourceInv[0].averageRate || "0")
          : parseFloat(stockItem.sellingPrice || "0");
        const requestedQty = parseFloat(item.quantity);

        processedItems.push({
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: requestedQty,
          rate: serverRate,
        });
      }

      // Calculate total value using server-derived rates
      let totalValue = 0;
      for (const item of processedItems) {
        totalValue += item.rate * item.quantity;
      }

      // Create voucher and update inventory in a transaction
      let multiSourceVoucherNumber = "";
      await db.transaction(async (tx) => {
        // Get next voucher number
        const existingVouchers = await tx
          .select({ voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, req.session.currentCompanyId!), eq(vouchers.voucherType, "Stock Transfer")))
          .orderBy(desc(vouchers.id))
          .limit(1);

        let nextNumber = 1;
        if (existingVouchers.length > 0) {
          const lastNum = existingVouchers[0].voucherNumber;
          const numMatch = lastNum.match(/(\d+)$/);
          if (numMatch) {
            nextNumber = parseInt(numMatch[1]) + 1;
          }
        }
        multiSourceVoucherNumber = `STI-${String(nextNumber).padStart(4, "0")}`;
        const voucherNumber = multiSourceVoucherNumber;

        // Create the voucher
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            voucherType: "Stock Transfer",
            voucherNumber,
            voucherDate: transferDate || getClientDate(req),
            description: notes || `Multi-source Stock Transfer Import (${processedItems.length} items)`,
            totalAmount: totalValue.toString(),
            locationId: destinationLocationId,
            locationName: destLocation.name,
          })
          .returning();

        // Create stock transfer record (use first source location for the main record)
        const firstSourceId = processedItems[0]?.sourceLocationId || 0;
        const [transferRecord] = await tx
          .insert(stockTransferVouchers)
          .values({
            voucherId: voucher.id,
            sourceLocationId: firstSourceId,
            destinationLocationId,
          })
          .returning();

        // Process each item - re-fetch inventory inside transaction and update
        for (const item of processedItems) {
          const sourceLocationId = item.sourceLocationId;
          const qty = item.quantity;
          const rate = item.rate;
          const itemTotal = qty * rate;

          // Create stock transfer item with individual sourceLocationId
          const [transferItem] = await tx
            .insert(stockTransferItems)
            .values({
              transferId: transferRecord.id,
              stockItemId: item.stockItemId,
              sourceLocationId,
              quantity: qty.toString(),
              rate: rate.toString(),
              totalAmount: itemTotal.toString(),
            })
            .returning({ id: stockTransferItems.id });

          // Reduce source inventory
          await adjustInventory(tx, sourceLocationId, item.stockItemId, -qty, req.session.currentCompanyId!);

          // Add to destination inventory
          await adjustInventory(tx, destinationLocationId, item.stockItemId, qty, req.session.currentCompanyId!, rate);

          const movementDate = transferDate || getClientDate(req);
          await postStockMovementTx(
            tx,
            {
              companyId: req.session.currentCompanyId!,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: String(qty),
              unitCost: String(Math.max(rate || 0, 0)),
              fromLocationId: sourceLocationId,
              toLocationId: destinationLocationId,
              occurredAt: new Date(`${movementDate}T00:00:00.000Z`).toISOString(),
              source: {
                sourceType: "stock-transfer-import-multi-source",
                sourceId: String(voucher.id),
                idempotencyKey: `stock-transfer-import-multi:${voucher.id}:${transferItem.id}`,
              },
              actor: {
                userId: req.session.userId,
                username: req.session.username,
                reason: notes || `Multi-source stock transfer ${voucherNumber}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      });

      res.json({
        success: true,
        itemsCount: processedItems.length,
        totalValue: totalValue.toFixed(2),
      });

      // Fire-and-forget: send transfer image to destination WA group
      if (multiSourceVoucherNumber) {
        const waItemsMs = processedItems.map((i) => ({
          stockItemId: i.stockItemId,
          quantity: i.quantity,
        }));
        const waVoucherMs = multiSourceVoucherNumber;
        const waDstNameMs = destLocation.name;
        const waDstIdMs = destinationLocationId;
        const waDateMs = transferDate || getClientDate(req);
        setImmediate(async () => {
          try {
            await sendTransferWhatsApp({
              destinationLocationId: waDstIdMs,
              sourceLocationName: "Multiple Sources",
              destLocationName: waDstNameMs,
              items: waItemsMs,
              voucherNumber: waVoucherMs,
              voucherDate: waDateMs,
            });
          } catch (e: unknown) {
            logger.error("[TransferWA] Failed to send:", { error: getErrorMessage(e) });
          }
        });
      }
    } catch (error: unknown) {
      logger.error("Stock Transfer Import error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
