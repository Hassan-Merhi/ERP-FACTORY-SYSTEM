/** POS Excel-import routes. */
import type { Express } from "express";
import { getErrorMessage, HttpError } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
  type InventoryNumericInput,
} from "../lib/inventoryMath";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { upload } from "./_helpers";
import { adjustInventory } from "../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { readExcel, sheetToJson, createWorkbook, jsonToSheet, writeWorkbook } from "../excelHelper";
import { getClientDate } from "../lib/dateUtils";
import { generateInvoicePdf } from "../helpers/generateInvoicePdf";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { getErpExportVisibility } from "../helpers/exportVisibility";
import { sendWhatsAppFileByUploadPos, sendWhatsAppFileToChatIdPos } from "../services/whatsappService";
import {
  vouchers,
  voucherEntries,
  salesItems,
  companies,
  inventory,
  stockItemLocationPrices,
  type Voucher,
} from "@shared/schema";

/**
 * One POS-import line: what the parse endpoint emits, and what the validate and
 * import endpoints read back off `req.body`.
 *
 * These were carried as `any[]`, so a spreadsheet column the parser stopped
 * recognising reached the sales voucher as `undefined` rather than as a row the
 * importer skipped.
 */
interface PosImportItem {
  rowNum: number;
  barcode: string;
  quantity: number;
  rate: number;
  value: number;
}

/** A POS-import line annotated by the validate endpoint. */
interface ValidatedPosImportItem extends PosImportItem {
  error?: string;
  warning?: string;
  stockItemId?: number;
  stockItemName?: string;
  stockItemUom?: string;
  costPrice?: number;
  currentStock?: number;
  remainingStock?: number;
}

/**
 * The first of the given columns the row actually carries. Spreadsheet headers
 * vary in case and wording, and cells arrive as text or numbers, so the value is
 * returned as the sheet parser yielded it — the callers below test it for
 * truthiness, where a numeric 0 and the string "0" differ.
 */
function firstPresent(row: Record<string, unknown>, ...columns: string[]): unknown {
  for (const column of columns) {
    const value = row[column];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** The same, narrowed to what the inventory math accepts; anything else reads as absent. */
function firstNumeric(row: Record<string, unknown>, ...columns: string[]): InventoryNumericInput {
  const value = firstPresent(row, ...columns);
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerPosImportRoutes(app: Express) {
  app.post("/api/pos-import/parse", requireAuth, upload.single("file"), async (req, res) => {
    try {
      if (!req.session.currentCompanyId) return res.status(400).json({ message: "No company selected" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const workbook = await readExcel(req.file.buffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = sheetToJson(worksheet);
      if (rows.length === 0) return res.status(400).json({ message: "Excel file is empty" });

      const items: PosImportItem[] = [];
      let totalValue = toInventoryDecimal(0);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const barcode = firstPresent(row, "Barcode", "barcode", "Code", "code");
        const quantity = toInventoryDecimal(firstNumeric(row, "Quantity", "quantity", "Qty", "qty"));
        const rate = toInventoryDecimal(firstNumeric(row, "Rate", "rate", "Price", "price"));
        if (!barcode || !quantity.isPositive() || !rate.isPositive()) continue;

        const itemValue = multiplyInventoryValues(quantity, rate);
        totalValue = addInventoryValues(totalValue, itemValue);
        items.push({
          rowNum: index + 2,
          barcode: String(barcode).trim(),
          quantity: quantity.toNumber(),
          rate: rate.toNumber(),
          value: itemValue.toNumber(),
        });
      }

      res.json({ items, totalValue: totalValue.toNumber(), fileName: req.file.originalname });
    } catch (error: unknown) {
      logger.error("POS Import parse error:", { error });
      res.status(400).json({ message: getErrorMessage(error) || "Failed to parse Excel file" });
    }
  });

  app.post("/api/pos-import/validate", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) return res.status(400).json({ message: "No company selected" });
      const { locationId, items } = req.body;
      if (!locationId || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      const validatedItems: ValidatedPosImportItem[] = [];
      const location = await storage.getLocationById(locationId);
      if (!location) {
        errors.push("Selected location not found");
        return res.json({ errors, warnings, validatedItems });
      }

      await storage.getAllStockItems(req.session.currentCompanyId!);
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
            const costPrice = toInventoryDecimal(inventoryItem[0].averageRate);
            const currentQty = toInventoryDecimal(inventoryItem[0].quantity);
            const saleQty = toInventoryDecimal(item.quantity);
            const remainingQty = subtractInventoryValues(currentQty, saleQty);
            validatedItem.costPrice = costPrice.toNumber();
            validatedItem.currentStock = currentQty.toNumber();
            validatedItem.remainingStock = remainingQty.toNumber();

            if (remainingQty.isNegative()) {
              validatedItem.warning = `Stock will go negative (${remainingQty.toFixed(2)} ${stockItem.uom})`;
              warnings.push(
                `${stockItem.name}: Stock will go negative (Current: ${currentQty.toFixed(2)}, Selling: ${saleQty.toFixed(2)}, Remaining: ${remainingQty.toFixed(2)} ${stockItem.uom})`
              );
            } else if (remainingQty.isZero()) {
              validatedItem.warning = "Stock will reach zero";
              warnings.push(
                `${stockItem.name}: Stock will reach zero (Current: ${currentQty.toFixed(2)}, Selling: ${saleQty.toFixed(2)} ${stockItem.uom})`
              );
            }
          } else {
            validatedItem.currentStock = 0;
            validatedItem.remainingStock = toInventoryDecimal(item.quantity).negated().toNumber();
            validatedItem.warning = "No stock at this location, will go negative";
            warnings.push(`${stockItem.name}: No stock at this location (Selling: ${item.quantity} ${stockItem.uom})`);
          }
        }
        validatedItems.push(validatedItem);
      }

      res.json({ errors, warnings, validatedItems });
    } catch (error: unknown) {
      logger.error("POS Import validation error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos-import/import", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) return res.status(400).json({ message: "No company selected" });
      const { locationId, saleDate, items, cashAccountId } = req.body;
      if (!locationId || !saleDate || !items || !Array.isArray(items) || !cashAccountId) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location) return res.status(400).json({ message: "Location not found" });

      const cashAccount = await storage.getLedgerAccountById(cashAccountId);
      if (!cashAccount || cashAccount.companyId !== req.session.currentCompanyId) {
        return res.status(400).json({ message: "Invalid cash account" });
      }

      const salesRevenueAccount = await storage.getOrCreateLedgerAccount({
        companyId: req.session.currentCompanyId!,
        code: "SALES_REV",
        name: "Sales Revenue",
        accountType: "Income",
        subType: "Direct Income",
        openingBalance: "0",
        openingBalanceSide: "Cr",
        active: true,
      });

      await storage.getOrCreateLedgerAccount({
        companyId: req.session.currentCompanyId!,
        code: "COGS",
        name: "Cost of Goods Sold",
        accountType: "Expense",
        subType: "Direct Expense",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      });

      let totalSales = toInventoryDecimal(0);

      // Taking the transaction's return value rather than assigning an outer
      // `let` keeps the voucher's type: TypeScript cannot see that a callback ran.
      const createdVoucher = await db.transaction(async (tx): Promise<Voucher> => {
        const voucherNumber = `SALES-${Date.now()}`;
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId: req.session.currentCompanyId!,
            locationId,
            locationName: location.name,
            voucherNumber,
            voucherType: "Sales",
            voucherDate: saleDate,
            description: `POS Import - ${items.length} items`,
            totalAmount: "0",
          })
          .returning();

        for (const item of items) {
          const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);
          if (!stockItem) {
            throw new HttpError(400, `Stock item not found for barcode: ${item.barcode}`);
          }

          const [inventoryRecord] = await tx
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, stockItem.id), eq(inventory.locationId, locationId)))
            .limit(1);

          const quantity = toInventoryDecimal(item.quantity);
          const sellingPrice = toInventoryDecimal(item.rate);
          const costPrice = toInventoryDecimal(inventoryRecord?.averageRate);
          const itemSales = multiplyInventoryValues(quantity, sellingPrice);
          const itemCost = multiplyInventoryValues(quantity, costPrice);
          const profit = subtractInventoryValues(itemSales, itemCost);
          totalSales = addInventoryValues(totalSales, itemSales);

          const [locationPrice] = await tx
            .select()
            .from(stockItemLocationPrices)
            .where(
              and(
                eq(stockItemLocationPrices.stockItemId, stockItem.id),
                eq(stockItemLocationPrices.locationId, locationId)
              )
            )
            .limit(1);
          const configuredPrice = toInventoryDecimal(locationPrice?.sellingPrice || stockItem.sellingPrice);

          const [saleItem] = await tx
            .insert(salesItems)
            .values({
              voucherId: voucher.id,
              stockItemId: stockItem.id,
              quantity: inventoryQuantity(quantity),
              sellingPrice: inventoryMoney(sellingPrice),
              costPrice: inventoryUnitCost(costPrice),
              totalSales: inventoryMoney(itemSales),
              totalCost: inventoryMoney(itemCost),
              profit: inventoryMoney(profit),
              configuredPrice: configuredPrice.isPositive() ? inventoryUnitCost(configuredPrice) : null,
            })
            .returning({ id: salesItems.id });

          await adjustInventory(
            tx,
            locationId,
            stockItem.id,
            quantity.negated().toNumber(),
            req.session.currentCompanyId!
          );
          await postStockMovementTx(
            tx,
            {
              companyId: req.session.currentCompanyId!,
              stockItemId: stockItem.id,
              kind: "issue",
              quantity: inventoryQuantity(quantity.abs()),
              unitCost: inventoryUnitCost(costPrice.abs()),
              fromLocationId: locationId,
              occurredAt: new Date(`${saleDate}T00:00:00.000Z`).toISOString(),
              source: {
                sourceType: "pos-import",
                sourceId: String(voucher.id),
                idempotencyKey: `pos-import:${voucher.id}:${saleItem.id}`,
              },
              actor: {
                userId: req.session.userId,
                username: req.session.username,
                reason: `POS import ${voucherNumber}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        const totalSalesAmount = inventoryMoney(totalSales);
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: cashAccountId,
          debitAmount: totalSalesAmount,
          creditAmount: "0",
          narration: `Cash from POS Sales - ${items.length} items`,
        });
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: salesRevenueAccount.id,
          debitAmount: "0",
          creditAmount: totalSalesAmount,
          narration: `Sales Revenue - ${items.length} items`,
        });
        await tx.update(vouchers).set({ totalAmount: totalSalesAmount }).where(eq(vouchers.id, voucher.id));
        return voucher;
      });

      res.json({
        success: true,
        voucher: createdVoucher,
        itemsCount: items.length,
        totalSales: inventoryMoney(totalSales),
      });

      if (location.whatsappGroupChatId) {
        const companyId = req.session.currentCompanyId!;
        const chatId = location.whatsappGroupChatId;
        const locationName = location.name;
        const importedLocationId = locationId;
        const importedSaleDate = saleDate;
        const voucherDate = createdVoucher.voucherDate;
        const voucherId = createdVoucher.id;
        const senderName = req.user?.username || "Import";
        const dateString = getClientDate(req);
        setImmediate(async () => {
          try {
            const visibility = await getErpExportVisibility(req);
            const hideProfitCols = visibility.hideSelling || visibility.hideCost;
            const pdfBuffer = await generateInvoicePdf(voucherId, companyId, senderName, { hideProfitCols });
            const safeDate = (voucherDate ?? importedSaleDate).replace(/[^0-9-]/g, "");
            const fileName =
              `${locationName} Invoice ${safeDate}`
                .replace(/[^\w\s.()-]/g, "_")
                .replace(/\s+/g, " ")
                .trim() + ".pdf";
            const invoiceResult = await sendWhatsAppFileByUploadPos(chatId, pdfBuffer, fileName, "");
            if (!invoiceResult.success) logger.error(`[POSImport-bg] Invoice send failed: ${invoiceResult.error}`);
            else logger.info(`[POSImport-bg] Invoice sent: ${fileName} → ${chatId}`);
          } catch (error: unknown) {
            logger.error("[POSImport-bg] Invoice send error:", { error: getErrorMessage(error) });
          }

          try {
            const [company] = await db
              .select({ name: companies.name })
              .from(companies)
              .where(eq(companies.id, companyId))
              .limit(1);
            const companyName = company?.name || "Company";
            const { buffer, pageCount, rowCount } = await generateStockPdf(
              companyId,
              companyName,
              importedLocationId,
              locationName
            );
            const maxAllowedPages = Math.ceil(rowCount / 20) + 5;
            if (pageCount > maxAllowedPages) {
              logger.error(`[POSImport-bg] Stock PDF safety guard: ${pageCount} pages for ${rowCount} rows — not sent`);
            } else {
              const stampString = new Date().toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              const stockName = `${locationName} STK ${companyName} ${dateString}`.replace(/[^\w\s.()-]/g, "_").trim();
              const stockResult = await sendWhatsAppFileToChatIdPos(
                chatId,
                buffer,
                `${stockName}.pdf`,
                `Stock Report — ${locationName}\n${stampString}`
              );
              if (!stockResult.success) logger.error(`[POSImport-bg] Stock send failed: ${stockResult.error}`);
              else logger.info(`[POSImport-bg] Stock report sent: ${stockName}.pdf → ${chatId}`);
            }
          } catch (error: unknown) {
            logger.error("[POSImport-bg] Stock send error:", { error: getErrorMessage(error) });
          }
        });
      }
    } catch (error: unknown) {
      if (error instanceof HttpError && error.statusCode === 400) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
      logger.error("POS Import error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos-import/template", async (_req, res) => {
    try {
      const sampleData = [
        { Barcode: "BC001", Quantity: 5, Rate: 25.0 },
        { Barcode: "BC002", Quantity: 3, Rate: 35.5 },
        { Barcode: "BC003", Quantity: 10, Rate: 15.75 },
      ];
      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "POS Import");
      const buffer = await writeWorkbook(workbook);
      res.setHeader("Content-Disposition", "attachment; filename=POS_Import_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Template generation error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
