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
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import {
  getPosDaybookLocations,
  getPosTransferScope,
  getPosTransferScopes,
  posTransferVisibleItems,
} from "../../services/pos/posDaybookTransferAccess";

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
      const access = await getActiveCompanyPermissionContext(req);
      const isPosUserList = access.role === "POS";
      const assignedLocations = isPosUserList ? await getPosDaybookLocations(access) : new Map<number, string>();
      const transferScopes = isPosUserList
        ? await getPosTransferScopes(companyId, rows.map((row) => row.voucherId), assignedLocations)
        : new Map();
      for (const locationId of assignedLocations.keys()) locationIds.add(locationId);

      const locationRows =
        locationIds.size > 0
          ? await db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(and(eq(locations.companyId, companyId), inArray(locations.id, Array.from(locationIds))))
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
              .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.id, stockItemIds)))
              .execute()
          : [];
      const stockItemMap = new Map(stockItemRows.map((s) => [s.id, s.name]));

      // Group all items by transfer
      const itemsByTransfer = new Map<number, typeof itemRows>();
      for (const item of itemRows) {
        const arr = itemsByTransfer.get(item.transferId) || [];
        arr.push(item);
        itemsByTransfer.set(item.transferId, arr);
      }

      const allResult = rows.map((r) => {
        const allItems = itemsByTransfer.get(r.transferId) || [];
        const posScope = transferScopes.get(r.voucherId);
        const posLocationIdList = posScope?.displayLocationId ?? null;
        const isDestUser = posScope?.isDestination ?? false;
        const myItems = isPosUserList
          ? posScope
            ? posTransferVisibleItems(allItems, posScope)
            : []
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
          totalAmount: isPosUserList ? 0 : Number(moneyString(totalAmount)),
          stockItemNames,
          createdAt: r.createdAt,
        };
      });

      const result = isPosUserList
        ? allResult.filter((row) => transferScopes.has(row.voucherId))
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

      const access = await getActiveCompanyPermissionContext(req);
      const transfer = await storage.getStockTransferByVoucherId(voucherId);
      if (!transfer) return res.status(404).json({ message: "Transfer not found" });
      const [voucher] = await db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, access.companyId), isNull(vouchers.deletedAt)))
        .limit(1);
      if (!voucher) return res.status(404).json({ message: "Transfer not found" });
      if (access.role !== "POS") return res.json(transfer);
      const scope = await getPosTransferScope(access, voucherId);
      if (!scope) return res.status(404).json({ message: "Transfer not found" });
      return res.json({
        id: transfer.id,
        voucherId: transfer.voucherId,
        sourceLocationId: scope.isDestination ? transfer.sourceLocationId : scope.displayLocationId,
        destinationLocationId: transfer.destinationLocationId,
        notes: transfer.notes,
        inventoryApplied: transfer.inventoryApplied,
        items: posTransferVisibleItems(transfer.items, scope).map((item) => ({
          id: item.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: item.quantity,
        })),
      });
    } catch (error: unknown) {
      logger.error("[Stock Transfer GET] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
