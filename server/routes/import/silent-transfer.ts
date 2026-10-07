/**
 * importRoutes: SilentTransfer endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { inventoryQuantity, subtractInventoryValues, toInventoryDecimal } from "../../lib/inventoryMath";
import { parseMoneyInput } from "../../lib/money";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { upload } from "../_helpers";
import { inventory, locations, stockItems } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { readExcel, sheetToJson, createWorkbook, jsonToSheet, writeWorkbook } from "../../excelHelper";
import { adjustInventory } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/** The ids among `locationIds` that are locations of `companyId`. */
async function ownLocationIds(companyId: number, locationIds: number[]): Promise<Set<number>> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds)));
  return new Set(rows.map((row) => row.id));
}

export function registerSilentTransferRoutes(app: Express) {
  // Template download
  app.get("/api/inventory/silent-transfer/template", requireAuth, requireNonPOS, async (_req, res) => {
    try {
      const sampleData = [
        { Barcode: "BC001", Quantity: 10 },
        { Barcode: "BC002", Quantity: 5 },
        { Barcode: "BC003", Quantity: 20 },
      ];
      const workbook = createWorkbook();
      jsonToSheet(workbook, sampleData, "Transfer");
      const buffer = await writeWorkbook(workbook);
      res.setHeader("Content-Disposition", "attachment; filename=Silent_Transfer_Template.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(buffer);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // Parse + validate uploaded Excel — returns structured validation results
  app.post(
    "/api/inventory/silent-transfer/parse",
    requireAuth,
    requireNonPOS,
    upload.single("file"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const { sourceLocationId, destinationLocationId } = req.body;
        if (!sourceLocationId || !destinationLocationId) {
          return res.status(400).json({ message: "Source and destination locations are required" });
        }

        const srcId = parseInt(sourceLocationId);
        const dstId = parseInt(destinationLocationId);
        if (srcId === dstId) return res.status(400).json({ message: "Source and destination must be different" });

        // The ids come from the request body, which the path-based company
        // scope does not see: a location of another company reads as missing.
        const owned = await ownLocationIds(companyId, [srcId, dstId]);
        const sourceLocation = owned.has(srcId) ? await storage.getLocationById(srcId) : undefined;
        const destLocation = owned.has(dstId) ? await storage.getLocationById(dstId) : undefined;
        if (!sourceLocation) return res.status(400).json({ message: "Source location not found" });
        if (!destLocation) return res.status(400).json({ message: "Destination location not found" });

        const workbook = await readExcel(req.file.buffer);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawData = sheetToJson(worksheet);

        if (rawData.length === 0) return res.status(400).json({ message: "Excel file is empty" });

        // Three output buckets
        const errorLines: Array<{ rowNum: number; barcode: string; reason: string }> = [];
        const validItems = [];
        const warnItems = []; // insufficient stock but can still be applied

        // Track barcodes already seen to detect duplicates in the file
        const seenBarcodes = new Map<string, number>(); // barcode → first rowNum

        for (let i = 0; i < rawData.length; i++) {
          const row = rawData[i];
          const rowNum = i + 2;
          const barcode = String(row.Barcode || row.barcode || row.Code || row.code || "").trim();
          const quantityRaw = row.Quantity ?? row.quantity ?? row.Qty ?? row.qty;
          const parsedQuantity = parseMoneyInput(String(quantityRaw ?? "0"));

          if (!barcode) continue; // blank row — silently skip

          // Duplicate barcode in same file
          if (seenBarcodes.has(barcode)) {
            errorLines.push({
              rowNum,
              barcode,
              reason: `Duplicate — already listed at row ${seenBarcodes.get(barcode)}`,
            });
            continue;
          }
          seenBarcodes.set(barcode, rowNum);

          // Invalid quantity
          if (!parsedQuantity || parsedQuantity.lte(0)) {
            errorLines.push({ rowNum, barcode, reason: "Quantity must be a positive number" });
            continue;
          }
          const quantity = Number(inventoryQuantity(parsedQuantity));

          // Look up stock item
          const stockItem = await storage.getStockItemByCodeOrAlias(barcode, companyId);
          if (!stockItem) {
            errorLines.push({ rowNum, barcode, reason: "Barcode / code not found in stock items" });
            continue;
          }

          // Check inventory at source
          const [srcInv] = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, stockItem.id), eq(inventory.locationId, srcId)))
            .limit(1);

          const currentStock = Number(inventoryQuantity(toInventoryDecimal(srcInv?.quantity)));
          const averageRate = toInventoryDecimal(srcInv?.averageRate).toNumber();
          const afterTransfer = Number(inventoryQuantity(subtractInventoryValues(srcInv?.quantity, quantity)));

          const item = {
            rowNum,
            barcode,
            stockItemId: stockItem.id,
            stockItemName: stockItem.name,
            uom: stockItem.uom || "",
            quantity,
            currentStock,
            averageRate,
            afterTransfer,
          };

          if (currentStock <= 0 && quantity > 0) {
            // No stock at all at this source
            warnItems.push({ ...item, warnReason: `No stock at source (available: 0)` });
          } else if (afterTransfer < 0) {
            // Partial stock — will go negative
            warnItems.push({
              ...item,
              warnReason: `Insufficient stock (available: ${currentStock.toFixed(2)}, short by: ${Math.abs(afterTransfer).toFixed(2)})`,
            });
          } else {
            validItems.push(item);
          }
        }

        res.json({
          validItems,
          warnItems,
          errorLines,
          sourceLocation: sourceLocation.name,
          destLocation: destLocation.name,
          totalRows: rawData.filter((r) => (r.Barcode || r.barcode || r.Code || r.code || "").toString().trim()).length,
        });
      } catch (err: unknown) {
        logger.error("Silent transfer parse error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // Apply the silent transfer — directly updates inventory, no voucher created
  app.post("/api/inventory/silent-transfer/apply", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { sourceLocationId, destinationLocationId, items } = req.body;
      if (!sourceLocationId || !destinationLocationId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const srcId = parseInt(sourceLocationId);
      const dstId = parseInt(destinationLocationId);
      if (srcId === dstId) return res.status(400).json({ message: "Source and destination must be different" });

      const owned = await ownLocationIds(companyId, [srcId, dstId]);
      if (!owned.has(srcId)) return res.status(400).json({ message: "Source location not found" });
      if (!owned.has(dstId)) return res.status(400).json({ message: "Destination location not found" });

      // Every stock item must belong to the company before anything moves.
      const requestedItemIds = [
        ...new Set(
          items
            .map((item: { stockItemId?: unknown }) => Number(item?.stockItemId))
            .filter((id: number) => Number.isInteger(id) && id > 0)
        ),
      ] as number[];
      if (requestedItemIds.length > 0) {
        const ownedItems = await db
          .select({ id: stockItems.id })
          .from(stockItems)
          .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.id, requestedItemIds)));
        if (ownedItems.length !== requestedItemIds.length) {
          return res.status(400).json({ message: "Stock item not found" });
        }
      }

      const operationId = randomUUID();
      const occurredAt = new Date().toISOString();
      let applied = 0;

      await db.transaction(async (tx) => {
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const parsedQty = parseMoneyInput(item.quantity);
          if (!parsedQty) continue;
          const qty = Number(inventoryQuantity(parsedQty));
          if (qty <= 0) continue;

          const stockItemId = parseInt(item.stockItemId);
          if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;

          const [sourceInventory] = await tx
            .select({ averageRate: inventory.averageRate })
            .from(inventory)
            .where(and(eq(inventory.stockItemId, stockItemId), eq(inventory.locationId, srcId)))
            .limit(1);
          // The source's own average rate; the client's figure only when the source has none.
          const parsedFallbackRate = parseMoneyInput(item.averageRate || "0");
          const fallbackRate = parsedFallbackRate && parsedFallbackRate.gte(0) ? parsedFallbackRate.toNumber() : 0;
          const rate = sourceInventory?.averageRate
            ? Math.max(toInventoryDecimal(sourceInventory.averageRate).toNumber(), 0)
            : fallbackRate;

          await adjustInventory(tx, srcId, stockItemId, -qty, companyId);
          await adjustInventory(tx, dstId, stockItemId, qty, companyId, rate);
          await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(qty),
              unitCost: String(rate),
              fromLocationId: srcId,
              toLocationId: dstId,
              occurredAt,
              source: {
                sourceType: "silent_transfer_import",
                sourceId: operationId,
                idempotencyKey: `silent-transfer:${companyId}:${operationId}:${index}:${stockItemId}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
          applied++;
        }
      });

      res.json({ success: true, itemsTransferred: applied });
    } catch (err: unknown) {
      logger.error("Silent transfer apply error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
