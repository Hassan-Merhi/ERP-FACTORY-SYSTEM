/**
 * stockSummaryLocationRoutes: LocationMonthlyDetail endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { requireAuth } from "../../auth";
import {
  vouchers,
  salesItems,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  creditNoteItems,
} from "@shared/schema";

export function registerLocationMonthlyDetailRoutes(app: Express) {
  // Per-month drill-down: individual transactions for a stock item at a location
  // Returns inTransactions and outTransactions arrays for the given year+month.
  // Inventory valuation remains in rate/value; sale rows also expose the recorded
  // selling rate/value so sales-oriented stock-out UIs can show the actual sale price.
  app.get("/api/locations/:locationId/stock-items/:stockItemId/monthly-detail", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      const stockItemId = parseInt(req.params.stockItemId);
      const year = parseInt(req.query.year as string);
      const month = parseInt(req.query.month as string);
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!year || !month || month < 1 || month > 12) return res.status(400).json({ message: "Invalid year/month" });

      const inTx = [];
      const outTx = [];

      // ── Sales (Outward) ──────────────────────────────────────────────────────
      const saleRows = await db
        .select({
          date: vouchers.voucherDate,
          ref: vouchers.voucherNumber,
          qty: salesItems.quantity,
          sellingPrice: salesItems.sellingPrice,
          totalSales: salesItems.totalSales,
          costPrice: salesItems.costPrice,
          totalCost: salesItems.totalCost,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(
          and(
            eq(salesItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            eq(vouchers.locationId, locationId),
            sql`EXTRACT(YEAR  FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        );
      for (const r of saleRows) {
        const qty = toMoney(r.qty);
        const totalCost = toMoney(r.totalCost);
        const costPrice = toMoney(r.costPrice);
        const sellingPrice = toMoney(r.sellingPrice);
        const totalSales = toMoney(r.totalSales);
        const ZERO = new MoneyDecimal(0);

        // Preserve the inventory-valuation contract used by other consumers.
        // Legacy rows may not have cost fields, so retain the existing sale-value fallback.
        const inventoryValue = totalCost.greaterThan(0)
          ? totalCost
          : costPrice.greaterThan(0)
            ? costPrice.times(qty)
            : totalSales.greaterThan(0)
              ? totalSales
              : sellingPrice.times(qty);
        const inventoryRate = qty.greaterThan(0) ? inventoryValue.dividedBy(qty) : ZERO;

        // Stock-out sale detail should display what the item actually sold for,
        // not its inventory cost. Prefer the recorded unit selling price, with
        // totalSales as the legacy fallback when a unit price is missing.
        const sellingRate = sellingPrice.greaterThan(0)
          ? sellingPrice
          : qty.greaterThan(0) && totalSales.greaterThan(0)
            ? totalSales.dividedBy(qty)
            : ZERO;
        const sellingValue = totalSales.greaterThan(0) ? totalSales : sellingRate.times(qty);

        outTx.push({
          type: "Sale",
          date: r.date,
          reference: r.ref,
          qty: qty.toNumber(),
          rate: inventoryRate.toNumber(),
          value: inventoryValue.toNumber(),
          sellingRate: sellingRate.toNumber(),
          sellingValue: sellingValue.toNumber(),
        });
      }

      // ── Stock Transfers (In and Out) ─────────────────────────────────────────
      const transferRows = await db
        .select({
          date: vouchers.voucherDate,
          ref: vouchers.voucherNumber,
          qty: stockTransferItems.quantity,
          totalAmount: stockTransferItems.totalAmount,
          srcLoc: stockTransferItems.sourceLocationId,
          dstLoc: stockTransferVouchers.destinationLocationId,
        })
        .from(stockTransferItems)
        .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
        .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
        .where(
          and(
            eq(stockTransferItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            sql`EXTRACT(YEAR  FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`,
            or(
              eq(stockTransferItems.sourceLocationId, locationId),
              eq(stockTransferVouchers.destinationLocationId, locationId)
            )
          )
        );
      for (const r of transferRows) {
        const qty = toMoney(r.qty);
        const val = toMoney(r.totalAmount);
        const entry = {
          date: r.date,
          reference: r.ref,
          qty: qty.toNumber(),
          rate: qty.greaterThan(0) ? val.dividedBy(qty).toNumber() : 0,
          value: val.toNumber(),
        };
        if (r.srcLoc === locationId) outTx.push({ ...entry, type: "Transfer Out" });
        if (r.dstLoc === locationId) inTx.push({ ...entry, type: "Transfer In" });
      }

      // ── Stock Adjustments ────────────────────────────────────────────────────
      const adjRows = await db
        .select({
          date: vouchers.voucherDate,
          ref: vouchers.voucherNumber,
          qty: stockAdjustmentItems.quantity,
          totalAmount: stockAdjustmentItems.totalAmount,
          adjustmentType: stockAdjustmentVouchers.adjustmentType,
        })
        .from(stockAdjustmentItems)
        .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
        .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
        .where(
          and(
            eq(stockAdjustmentItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            eq(stockAdjustmentVouchers.locationId, locationId),
            sql`EXTRACT(YEAR  FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        );
      for (const r of adjRows) {
        const signedQty = toMoney(r.qty);
        const qty = signedQty.abs();
        const val = toMoney(r.totalAmount).abs();
        const entry = {
          date: r.date,
          reference: r.ref,
          qty: qty.toNumber(),
          rate: qty.greaterThan(0) ? val.dividedBy(qty).toNumber() : 0,
          value: val.toNumber(),
        };
        if (r.adjustmentType === "Production" || signedQty.greaterThan(0))
          inTx.push({ ...entry, type: `Adjustment (${r.adjustmentType})` });
        else outTx.push({ ...entry, type: `Adjustment (${r.adjustmentType})` });
      }

      // ── Credit / Debit Notes ─────────────────────────────────────────────────
      const noteRows = await db
        .select({
          date: vouchers.voucherDate,
          ref: vouchers.voucherNumber,
          qty: creditNoteItems.quantity,
          inventoryCost: creditNoteItems.inventoryCost,
          noteType: vouchers.voucherType,
        })
        .from(creditNoteItems)
        .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
        .where(
          and(
            eq(creditNoteItems.stockItemId, stockItemId),
            eq(creditNoteItems.locationId, locationId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`EXTRACT(YEAR  FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        );
      for (const r of noteRows) {
        const qty = toMoney(r.qty);
        const rate = toMoney(r.inventoryCost);
        const entry = {
          date: r.date,
          reference: r.ref,
          qty: qty.toNumber(),
          rate: rate.toNumber(),
          value: rate.times(qty).toNumber(),
        };
        if (r.noteType === "Credit Note") inTx.push({ ...entry, type: "Credit Note" });
        else outTx.push({ ...entry, type: "Debit Note" });
      }

      const byDate = (
        a: { type: string; date: string; reference: string; qty: number; rate: number; value: number },
        b: { type: string; date: string; reference: string; qty: number; rate: number; value: number }
      ) => new Date(a.date).getTime() - new Date(b.date).getTime();
      res.json({ inTransactions: inTx.sort(byDate), outTransactions: outTx.sort(byDate) });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
