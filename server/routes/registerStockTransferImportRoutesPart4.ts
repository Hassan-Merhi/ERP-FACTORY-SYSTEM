// Extracted from ./registerStockTransferImportRoutesPart2.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { sendTransferWhatsApp } from "../helpers/sendTransferWhatsApp";
import { inventory, stockTransferVouchers, vouchers } from "@shared/schema";
import { MoneyDecimal, toMoney } from "../lib/money";
import { formatStockTransferNarration } from "../services/inventory/stockTransferNarration";
import { resolveTransferLocations } from "./helpers/transferLocations";
import { type Decimal, requestQuantity } from "./stockTransferImportQuantity";
import {
  postImportedTransferLinesTx,
  type ProvisionalRateBasis,
  provisionalTransferImportRate,
} from "./stockTransferImportPosting";
import { isPhase9LanPrimary } from "../edge/phase9PosOutbox";
import { importStockTransferOnLan } from "../services/inventory/stockTransferImportOfflineCapture";
import { provisionalRatesOf, sendStockTransferImportRefusal } from "./registerStockTransferImportRoutesPart1";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const numberLike = z.union([z.number(), z.string()]);

// No client page posts here today; tests/wave15-stock-paths.test.ts and
// tests/stock-transfer-import-exact.test.ts send this shape.
const importTransferInput = {
  query: emptyQuery,
  body: z.strictObject({
    sourceLocationId: numberLike.nullable().optional(),
    destinationLocationId: numberLike.nullable().optional(),
    transferDate: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    items: z
      .array(
        z.strictObject({
          barcode: z.string(),
          quantity: numberLike.nullable().optional(),
          // Read by resolveTransferLocations to refuse another company's source.
          sourceLocationId: numberLike.nullable().optional(),
        })
      )
      .nullable()
      .optional(),
    // Read by the voucher-path boundary middleware (resolveVoucherPathCompanyId)
    // that runs before this route; the handler itself uses the session company.
    companyId: numberLike.nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerStockTransferImportRoutesPart4(app: Express) {
  // Stock Transfer Import - Create stock transfer
  app.post(
    "/api/stock-transfer-import/import",
    requireAuth,
    requireNonPOS,
    validateRequest(importTransferInput),
    async (req, res) => {
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
    }
  );
}
