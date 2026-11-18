// Extracted from ./stockTransferImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { spreadsheetUpload } from "./_helpers";
import { createWorkbook, jsonToSheet, readExcel, sheetToJson, writeWorkbook } from "../excelHelper";
import { sendTransferWhatsApp } from "../helpers/sendTransferWhatsApp";
import { inventory, stockTransferVouchers, vouchers } from "@shared/schema";
import { MoneyDecimal, toMoney } from "../lib/money";
import { formatStockTransferNarration } from "../services/inventory/stockTransferNarration";
import { resolveTransferLocations } from "./helpers/transferLocations";
import type { ParsedStockTransferItem, SpreadsheetRow } from "./stockTransferImportTypes";
import { type Decimal, requestQuantity, rowQuantity } from "./stockTransferImportQuantity";
import {
  postImportedTransferLinesTx,
  type ProvisionalRateBasis,
  provisionalTransferImportRate,
} from "./stockTransferImportPosting";
import { isPhase9LanPrimary } from "../edge/phase9PosOutbox";
import { importStockTransferOnLan } from "../services/inventory/stockTransferImportOfflineCapture";
import { provisionalRatesOf, sendStockTransferImportRefusal } from "./registerStockTransferImportRoutesPart1";

export function registerStockTransferImportRoutesPart2(app: Express) {
  // Stock Transfer Import - Create stock transfer
  app.post("/api/stock-transfer-import/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { sourceLocationId, destinationLocationId, transferDate, items, notes } = req.body;

      if (!sourceLocationId || !destinationLocationId || !transferDate || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Validate locations in this company (body ids are outside the path-based scope).
      const { sourceLocation, destLocation, foreignItemSource } = await resolveTransferLocations(
        req.session.currentCompanyId,
        sourceLocationId,
        destinationLocationId,
        items
      );
      if (foreignItemSource) {
        return res.status(400).json({ message: "Source location not found" });
      }

      if (!sourceLocation) {
        return res.status(400).json({ message: "Source location not found" });
      }

      if (!destLocation) {
        return res.status(400).json({ message: "Destination location not found" });
      }

      let totalValue = new MoneyDecimal(0);
      const transferItems: Array<{
        stockItemId: number;
        quantity: Decimal;
        rate: Decimal;
        provisional?: ProvisionalRateBasis;
      }> = [];

      // Prepare items with rates from inventory
      for (const item of items) {
        const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);

        if (!stockItem) {
          return res.status(400).json({ message: `Stock item not found: ${item.barcode}` });
        }

        // Get rate from source inventory (the header source, where the line is moved from)
        const [inventoryItem] = await db
          .select()
          .from(inventory)
          .where(
            and(
              eq(inventory.companyId, req.session.currentCompanyId!),
              eq(inventory.stockItemId, stockItem.id),
              eq(inventory.locationId, sourceLocationId)
            )
          )
          .limit(1);

        // The source's average rate; with no source row, the item's latest cost as a
        // provisional cost (selling price only when it has none; wave 17 B).
        const provisional = inventoryItem
          ? null
          : await provisionalTransferImportRate(db, req.session.currentCompanyId!, stockItem);
        const rate = inventoryItem ? toMoney(inventoryItem.averageRate) : provisional!.rate;
        const quantity = requestQuantity(item.quantity);

        totalValue = totalValue.plus(rate.times(quantity));

        transferItems.push({
          stockItemId: stockItem.id,
          quantity,
          rate,
          ...(provisional ? { provisional: provisional.basis } : {}),
        });
      }

      // Factory LAN server: the import becomes an ordinary offline transfer (same code, recorded for the cloud).
      if (isPhase9LanPrimary()) {
        await importStockTransferOnLan(req, {
          companyId: req.session.currentCompanyId!,
          destinationLocationId,
          transferDate,
          notes,
          lines: transferItems.map((item) => ({ ...item, sourceLocationId })),
        });
        return res.json({
          success: true,
          itemsCount: items.length,
          totalValue: totalValue.toFixed(2),
          provisionalRates: provisionalRatesOf(transferItems),
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
              (typeof notes === "string" ? notes.trim() : "") ||
              formatStockTransferNarration([sourceLocation.name], destLocation.name),
            totalAmount: totalValue.toFixed(),
          })
          .returning();

        // Create stock transfer record
        const [transferRecord] = await tx
          .insert(stockTransferVouchers)
          .values({
            voucherId: voucher.id,
            sourceLocationId: sourceLocationId,
            destinationLocationId,
            notes: notes || null,
            inventoryApplied: true,
          })
          .returning();

        // Wave 15: lines move value conserved (stockTransferImportPosting).
        await postImportedTransferLinesTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherId: voucher.id,
          transferId: transferRecord.id,
          destinationLocationId,
          date: transferDate,
          lines: transferItems.map((item) => ({ ...item, sourceLocationId })),
          movementSourceType: "stock-transfer-import",
          idempotencyPrefix: "stock-transfer-import",
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            reason: notes || `Excel stock transfer ${voucherNumber}`,
          },
        });
      });

      res.json({
        success: true,
        itemsCount: items.length,
        totalValue: totalValue.toFixed(2),
        provisionalRates: provisionalRatesOf(transferItems),
      });

      // Fire-and-forget: send transfer image to destination WA group
      const waItems = transferItems.map((i) => ({
        stockItemId: i.stockItemId,
        quantity: i.quantity.toNumber(),
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
      if (sendStockTransferImportRefusal(res, error)) return;
      logger.error("Stock Transfer Import error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Download sample Stock Transfer import template
  app.get("/api/stock-transfer-import/template", requireAuth, async (_req, res) => {
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
  app.get("/api/stock-transfer-import/template-multi-source", requireAuth, async (_req, res) => {
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
    spreadsheetUpload.single("file"),
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
          const quantity = rowQuantity(row);

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
}
