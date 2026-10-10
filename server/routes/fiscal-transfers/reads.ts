/**
 * fiscalTransferRoutes: StockTransferRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import { stockItems, stockTransferVouchers, stockTransferItems, vouchers, locations } from "@shared/schema";
import { eq, and, desc, inArray, isNull, gte, lte } from "drizzle-orm";
import { registerFinancialSalesRoutes } from "../financialSalesRoutes";
import { moneyString, sumMoney } from "../../lib/money";

export function registerStockTransferReadRoutes(app: Express) {
  registerFinancialSalesRoutes(app);

  app.get("/api/stock-transfers/list", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const startDate = req.query.startDate ? String(req.query.startDate) : null;
      const endDate = req.query.endDate ? String(req.query.endDate) : null;

      // Fetch all stock transfer vouchers for this company via vouchers join
      const voucherConditions = [
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherType, "Stock Transfer"),
        isNull(vouchers.deletedAt),
      ];
      if (startDate) voucherConditions.push(gte(vouchers.voucherDate, startDate));
      if (endDate) voucherConditions.push(lte(vouchers.voucherDate, endDate));

      const rows = await db
        .select({
          transferId: stockTransferVouchers.id,
          voucherId: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          notes: stockTransferVouchers.notes,
          inventoryApplied: stockTransferVouchers.inventoryApplied,
          sourceLocationId: stockTransferVouchers.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
          createdAt: stockTransferVouchers.createdAt,
        })
        .from(stockTransferVouchers)
        .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
        .where(and(...voucherConditions))
        .orderBy(desc(vouchers.voucherDate), desc(vouchers.id))
        .execute();

      if (rows.length === 0) return res.json([]);

      // Batch-fetch location names
      const locationIds = new Set<number>();
      for (const r of rows) {
        if (r.sourceLocationId) locationIds.add(r.sourceLocationId);
        if (r.destinationLocationId) locationIds.add(r.destinationLocationId);
      }
      // Determine if this is a POS user and their assigned location
      const isPosUserList = req.user?.role === "POS";
      const posLocationIdList = isPosUserList
        ? (req.user?.assignedLocationId ?? req.session?.currentLocationId ?? null)
        : null;

      if (posLocationIdList) locationIds.add(posLocationIdList);

      const locationRows =
        locationIds.size > 0
          ? await db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(inArray(locations.id, Array.from(locationIds)))
              .execute()
          : [];
      const locationMap = new Map(locationRows.map((l) => [l.id, l.name]));

      // Batch-fetch item counts and totals per transfer
      const transferIds = rows.map((r) => r.transferId);
      const itemRows = await db
        .select({
          transferId: stockTransferItems.transferId,
          totalAmount: stockTransferItems.totalAmount,
          stockItemId: stockTransferItems.stockItemId,
          quantity: stockTransferItems.quantity,
          sourceLocationId: stockTransferItems.sourceLocationId,
        })
        .from(stockTransferItems)
        .where(inArray(stockTransferItems.transferId, transferIds))
        .execute();

      // Batch-fetch stock item names
      const stockItemIds = [...new Set(itemRows.map((i) => i.stockItemId).filter(Boolean))] as number[];
      const stockItemRows =
        stockItemIds.length > 0
          ? await db
              .select({ id: stockItems.id, name: stockItems.name })
              .from(stockItems)
              .where(inArray(stockItems.id, stockItemIds))
              .execute()
          : [];
      const stockItemMap = new Map(stockItemRows.map((s) => [s.id, s.name]));

      // Group all items by transfer
      const itemsByTransfer = new Map<number, typeof itemRows>();
      // Track which transfers have at least one item sourced from the POS user's location
      const transfersWithMySourceItem = new Set<number>();
      for (const item of itemRows) {
        const arr = itemsByTransfer.get(item.transferId) || [];
        arr.push(item);
        itemsByTransfer.set(item.transferId, arr);
        if (posLocationIdList !== null && item.sourceLocationId === posLocationIdList) {
          transfersWithMySourceItem.add(item.transferId);
        }
      }

      const allResult = rows.map((r) => {
        const allItems = itemsByTransfer.get(r.transferId) || [];
        // Destination-side POS users see all items; source-side see only their items:
        //   - Items with item-level sourceLocationId matching their location
        //   - Items with no item-level sourceLocationId AND voucher-level source matches
        const isDestUser = posLocationIdList !== null && r.destinationLocationId === posLocationIdList;
        const myItems =
          posLocationIdList !== null
            ? isDestUser
              ? allItems
              : allItems.filter(
                  (i) =>
                    i.sourceLocationId === posLocationIdList ||
                    (i.sourceLocationId === null && r.sourceLocationId === posLocationIdList)
                )
            : allItems;
        const totalAmount = sumMoney(myItems.map((i) => i.totalAmount));
        const stockItemNames = [...new Set(myItems.map((i) => stockItemMap.get(i.stockItemId) ?? "").filter(Boolean))];
        return {
          transferId: r.transferId,
          voucherId: r.voucherId,
          voucherNumber: r.voucherNumber,
          voucherDate: r.voucherDate,
          notes: r.notes,
          inventoryApplied: r.inventoryApplied,
          sourceLocationId: isDestUser ? r.sourceLocationId : (posLocationIdList ?? r.sourceLocationId),
          sourceLocationName: isDestUser
            ? r.sourceLocationId
              ? (locationMap.get(r.sourceLocationId) ?? "Multi-source")
              : "Multi-source"
            : posLocationIdList
              ? (locationMap.get(posLocationIdList) ?? "Unknown")
              : r.sourceLocationId
                ? (locationMap.get(r.sourceLocationId) ?? "Multi-source")
                : "Multi-source",
          destinationLocationId: r.destinationLocationId,
          destinationLocationName: locationMap.get(r.destinationLocationId) ?? "Unknown",
          itemCount: myItems.length,
          totalAmount: Number(moneyString(totalAmount)),
          stockItemNames,
          createdAt: r.createdAt,
        };
      });

      // For POS users: show transfers where their location is destination OR source
      // (Kolwezi/Kolwezi 2 are destinations; Hadi 1/2/3/4 are sources)
      const result =
        posLocationIdList !== null
          ? allResult.filter(
              (r) =>
                r.destinationLocationId === posLocationIdList ||
                r.sourceLocationId === posLocationIdList ||
                transfersWithMySourceItem.has(r.transferId)
            )
          : allResult;

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Stock Transfers - GET endpoint
  app.get("/api/stock-transfers", requireAuth, async (req, res) => {
    try {
      const voucherId = req.query.voucherId ? parseInt(req.query.voucherId as string) : null;

      if (!voucherId) {
        return res.status(400).json({ message: "voucherId query parameter is required" });
      }

      const transfer = await storage.getStockTransferByVoucherId(voucherId);
      res.json(transfer);
    } catch (error: unknown) {
      logger.error("[Stock Transfer GET] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
