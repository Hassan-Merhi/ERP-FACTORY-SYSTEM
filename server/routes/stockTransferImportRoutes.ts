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
import { getClientDate } from "../lib/dateUtils";
import { sendTransferWhatsApp } from "../helpers/sendTransferWhatsApp";
import { inventory, stockTransferVouchers, vouchers } from "@shared/schema";
import { MoneyDecimal, toMoney } from "../lib/money";
import { formatStockTransferNarration } from "../services/inventory/stockTransferNarration";
import { requestQuantity, type Decimal } from "./stockTransferImportQuantity";
import {
  postImportedTransferLinesTx,
  provisionalTransferImportRate,
  type ProvisionalRateBasis,
} from "./stockTransferImportPosting";
import { isPhase9LanPrimary } from "../edge/phase9PosOutbox";
import { importStockTransferOnLan } from "../services/inventory/stockTransferImportOfflineCapture";
import {
  provisionalRatesOf,
  registerStockTransferImportRoutesPart1,
  sendStockTransferImportRefusal,
} from "./registerStockTransferImportRoutesPart1";
import { registerStockTransferImportRoutesPart2 } from "./registerStockTransferImportRoutesPart2";
import { registerStockTransferImportRoutesPart3 } from "./registerStockTransferImportRoutesPart3";

export function registerStockTransferImportRoutes(app: Express) {
  registerStockTransferImportRoutesPart1(app);
  registerStockTransferImportRoutesPart2(app);
  registerStockTransferImportRoutesPart3(app);
  registerStockTransferImportRoutesPart4(app);
}

function registerStockTransferImportRoutesPart4(app: Express) {
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
        quantity: Decimal;
        rate: Decimal;
        provisional?: ProvisionalRateBasis;
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

        // Server-derived rate from the source's inventory; with no source row, the
        // item's latest cost as a provisional cost (selling price only when it has none).
        const provisional = sourceInv[0]
          ? null
          : await provisionalTransferImportRate(db, req.session.currentCompanyId!, stockItem);
        const serverRate = sourceInv[0] ? toMoney(sourceInv[0].averageRate) : provisional!.rate;
        const requestedQty = requestQuantity(item.quantity);

        processedItems.push({
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: requestedQty,
          rate: serverRate,
          ...(provisional ? { provisional: provisional.basis } : {}),
        });
      }

      // Calculate total value using server-derived rates
      let totalValue = new MoneyDecimal(0);
      for (const item of processedItems) {
        totalValue = totalValue.plus(item.rate.times(item.quantity));
      }

      // Factory LAN server: the import becomes an ordinary offline transfer (same code, recorded for the cloud).
      if (isPhase9LanPrimary()) {
        await importStockTransferOnLan(req, {
          companyId: req.session.currentCompanyId!,
          destinationLocationId,
          transferDate: transferDate || getClientDate(req),
          notes,
          lines: processedItems,
        });
        return res.json({
          success: true,
          itemsCount: processedItems.length,
          totalValue: totalValue.toFixed(2),
          provisionalRates: provisionalRatesOf(processedItems),
        });
      }

      // Create the voucher and move the stock in one transaction
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
            description:
              (typeof notes === "string" ? notes.trim() : "") ||
              formatStockTransferNarration(
                processedItems.map((item) => locationsById[item.sourceLocationId]),
                destLocation.name
              ),
            totalAmount: totalValue.toFixed(),
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
          date: transferDate || getClientDate(req),
          lines: processedItems,
          movementSourceType: "stock-transfer-import-multi-source",
          idempotencyPrefix: "stock-transfer-import-multi",
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            reason: notes || `Multi-source stock transfer ${voucherNumber}`,
          },
        });
      });

      res.json({
        success: true,
        itemsCount: processedItems.length,
        totalValue: totalValue.toFixed(2),
        provisionalRates: provisionalRatesOf(processedItems),
      });

      // Fire-and-forget: send transfer image to destination WA group
      if (multiSourceVoucherNumber) {
        const waItemsMs = processedItems.map((i) => ({
          stockItemId: i.stockItemId,
          quantity: i.quantity.toNumber(),
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
      if (sendStockTransferImportRefusal(res, error)) return;
      logger.error("Stock Transfer Import error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
