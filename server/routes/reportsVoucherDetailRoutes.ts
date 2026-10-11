import type { Express } from "express";

import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  ledgerAccounts,
  poLineItems,
  posShifts,
  purchaseOrders,
  salesItems,
  stockItems,
  suppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { toMoney } from "../lib/money";

export function registerReportsVoucherDetailRoutes(app: Express) {
  app.get("/api/voucher-detail/:voucherId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const voucherId = parseInt(req.params.voucherId);
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid voucher ID" });

      const voucher = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .execute()
        .then((rows) => rows[0]);
      if (!voucher) return res.status(404).json({ message: "Voucher not found" });

      if (req.user?.role === "POS" && voucher.voucherType === "Sales") {
        const [ownedShift] = voucher.shiftId
          ? await db
              .select({ id: posShifts.id })
              .from(posShifts)
              .where(and(eq(posShifts.id, voucher.shiftId), eq(posShifts.userId, req.user.id)))
              .limit(1)
          : [];
        if (!ownedShift) return res.status(403).json({ message: "Access denied" });
      }

      // All detail reads below depend only on the already-authorized voucher ID.
      // Run them in parallel and resolve display names with joins so this endpoint
      // has a fixed query count instead of one query per item/account row.
      const [supplierEntry, purchaseEntry, salesItemsData, poItemsData, entriesData] = await Promise.all([
        db
          .select({ supplierName: suppliers.legalName })
          .from(voucherEntries)
          .leftJoin(suppliers, eq(voucherEntries.supplierId, suppliers.id))
          .where(and(eq(voucherEntries.voucherId, voucherId), isNotNull(voucherEntries.supplierId)))
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select({ name: ledgerAccounts.name })
          .from(voucherEntries)
          .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
          .where(
            and(
              eq(voucherEntries.voucherId, voucherId),
              or(eq(ledgerAccounts.code, "PURCHASES"), sql`${ledgerAccounts.code} LIKE 'PURCHASES-%'`)
            )
          )
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select({
            id: salesItems.id,
            stockItemId: salesItems.stockItemId,
            stockItemName: stockItems.name,
            stockItemCode: stockItems.code,
            stockItemUom: stockItems.uom,
            quantity: salesItems.quantity,
            rate: salesItems.sellingPrice,
            total: salesItems.totalSales,
          })
          .from(salesItems)
          .leftJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
          .where(eq(salesItems.voucherId, voucherId)),
        db
          .select({
            id: poLineItems.id,
            stockItemId: poLineItems.stockItemId,
            stockItemName: stockItems.name,
            stockItemCode: stockItems.code,
            stockItemUom: stockItems.uom,
            quantity: poLineItems.quantity,
            rate: poLineItems.rate,
            total: poLineItems.lineTotal,
          })
          .from(poLineItems)
          .innerJoin(purchaseOrders, eq(poLineItems.poId, purchaseOrders.id))
          .leftJoin(stockItems, eq(poLineItems.stockItemId, stockItems.id))
          .where(eq(purchaseOrders.voucherId, voucherId)),
        db
          .select({
            id: voucherEntries.id,
            ledgerAccountId: voucherEntries.ledgerAccountId,
            ledgerAccountName: ledgerAccounts.name,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
            narration: voucherEntries.narration,
          })
          .from(voucherEntries)
          .leftJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
          .where(eq(voucherEntries.voucherId, voucherId)),
      ]);

      const items = [...salesItemsData, ...poItemsData].map((item) => ({
        id: item.id,
        stockItemId: item.stockItemId,
        stockItemName: item.stockItemName || "Unknown Item",
        stockItemCode: item.stockItemCode || "",
        quantity: toMoney(item.quantity).toNumber(),
        unit: item.stockItemUom || "BL",
        rate: toMoney(item.rate).toNumber(),
        amount: toMoney(item.total).toNumber(),
      }));

      const entries = entriesData.map((entry) => ({
        id: entry.id,
        ledgerAccountId: entry.ledgerAccountId || 0,
        ledgerAccountName: entry.ledgerAccountName || "Unknown Account",
        debitAmount: toMoney(entry.debitAmount).toNumber(),
        creditAmount: toMoney(entry.creditAmount).toNumber(),
        narration: entry.narration,
      }));

      res.json({
        id: voucher.id,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        date: voucher.voucherDate,
        partyName: supplierEntry?.supplierName || null,
        purchaseLedger: purchaseEntry?.name || null,
        locationName: voucher.locationName || null,
        narration: voucher.description,
        supplierInvoiceNo: null,
        items,
        entries,
        totals: {
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
          amount: items.reduce((sum, item) => sum + item.amount, 0),
          debit: entries.reduce((sum, entry) => sum + entry.debitAmount, 0),
          credit: entries.reduce((sum, entry) => sum + entry.creditAmount, 0),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
