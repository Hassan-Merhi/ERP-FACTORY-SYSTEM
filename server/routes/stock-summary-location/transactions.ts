/**
 * stockSummaryLocationRoutes: LocationStockTransaction endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import {
  containers,
  containerOffloads,
  purchaseOrders,
  poLineItems,
  vouchers,
  salesItems,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  creditNoteItems,
} from "@shared/schema";

function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function finite(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function registerLocationStockTransactionRoutes(app: Express) {
  // Location transactions for a date range (used by "Show all months" feature)
  app.get("/api/locations/:locationId/stock-items/:stockItemId/transactions", requireAuth, async (req, res) => {
    try {
      const locationId = Number.parseInt(req.params.locationId, 10);
      const stockItemId = Number.parseInt(req.params.stockItemId, 10);
      const companyId = req.session.currentCompanyId;
      const startDate = (req.query.startDate as string) || "";
      const endDate = (req.query.endDate as string) || "";

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });

      const stockItem = await storage.getStockItemById(stockItemId);
      if (!stockItem) return res.status(404).json({ message: "Stock item not found" });

      const location = await storage.getLocationById(locationId);
      if (!location) return res.status(404).json({ message: "Location not found" });

      // Inventory is the source of truth for valuation. Reconstruct the opening
      // from the live inventory ledger instead of re-deriving it from an incomplete
      // subset of vouchers. The old voucher-only opening could become negative even
      // while Location Inventory held a valid positive quantity/value.
      const historicalOpening = await calculateHistoricalLocationInventory(locationId, companyId, dayBefore(startDate));
      const openingRow = historicalOpening.find((row) => row.stockItemId === stockItemId);
      const openingQty = finite(openingRow?.quantity);
      const openingValue = Math.max(finite(openingRow?.totalValue), 0);
      const storedOpeningRate = Math.max(finite(openingRow?.averageRate), 0);
      const openingRate = openingQty > 0 && openingValue > 0 ? openingValue / openingQty : storedOpeningRate;

      type TxRaw = {
        date: string;
        particulars: string;
        vchType: string;
        voucherId: number;
        poId?: number;
        inwardQty: number;
        inwardRate: number;
        inwardValue: number;
        outwardQty: number;
        outwardRate: number;
        outwardValue: number;
        isPOS?: boolean;
        posSellingRate?: number;
        posSellingValue?: number;
      };
      const txns: TxRaw[] = [];

      // Stock Transfers
      const rangeTransfers = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherId: vouchers.id,
          quantity: stockTransferItems.quantity,
          rate: stockTransferItems.rate,
          totalAmount: stockTransferItems.totalAmount,
          sourceLocationId: stockTransferItems.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
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
            sql`${vouchers.voucherDate}::date >= ${startDate}::date`,
            sql`${vouchers.voucherDate}::date <= ${endDate}::date`,
            or(
              eq(stockTransferItems.sourceLocationId, locationId),
              eq(stockTransferVouchers.destinationLocationId, locationId)
            )
          )
        )
        .orderBy(vouchers.voucherDate);

      const locIds = new Set<number>();
      for (const t of rangeTransfers) {
        if (t.sourceLocationId) locIds.add(t.sourceLocationId);
        if (t.destinationLocationId) locIds.add(t.destinationLocationId);
      }
      const locMap: Record<number, string> = {};
      for (const lid of Array.from(locIds)) {
        const l = await storage.getLocationById(lid);
        if (l) locMap[lid] = l.name;
      }
      for (const t of rangeTransfers) {
        const q = finite(t.quantity);
        const rate = Math.max(finite(t.rate), 0);
        const value = Math.max(finite(t.totalAmount), 0);
        const srcName = t.sourceLocationId ? locMap[t.sourceLocationId] || "Unknown" : "Unknown";
        const dstName = locMap[t.destinationLocationId] || "Unknown";
        if (t.sourceLocationId === locationId) {
          txns.push({
            date: t.voucherDate,
            particulars: `To ${dstName}`,
            vchType: "Stock Transfer",
            voucherId: t.voucherId,
            inwardQty: 0,
            inwardRate: 0,
            inwardValue: 0,
            outwardQty: q,
            outwardRate: rate,
            outwardValue: value,
          });
        }
        if (t.destinationLocationId === locationId) {
          txns.push({
            date: t.voucherDate,
            particulars: `From ${srcName}`,
            vchType: "Stock Transfer",
            voucherId: t.voucherId,
            inwardQty: q,
            inwardRate: rate,
            inwardValue: value,
            outwardQty: 0,
            outwardRate: 0,
            outwardValue: 0,
          });
        }
      }

      // Stock Adjustments
      const rangeAdj = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherId: vouchers.id,
          quantity: stockAdjustmentItems.quantity,
          rate: stockAdjustmentItems.rate,
          totalAmount: stockAdjustmentItems.totalAmount,
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
            sql`${vouchers.voucherDate}::date >= ${startDate}::date`,
            sql`${vouchers.voucherDate}::date <= ${endDate}::date`
          )
        )
        .orderBy(vouchers.voucherDate);

      for (const a of rangeAdj) {
        const rawQty = finite(a.quantity);
        const rawValue = finite(a.totalAmount);
        const qty = Math.abs(rawQty);
        const rate = Math.max(finite(a.rate), 0);
        const value = Math.abs(rawValue);
        const isIn = rawQty > 0;
        txns.push({
          date: a.voucherDate,
          particulars: isIn ? "Production" : "Consumption",
          vchType: isIn ? "Production" : "Consumption",
          voucherId: a.voucherId,
          inwardQty: isIn ? qty : 0,
          inwardRate: isIn ? rate : 0,
          inwardValue: isIn ? value : 0,
          outwardQty: isIn ? 0 : qty,
          outwardRate: isIn ? 0 : rate,
          outwardValue: isIn ? 0 : value,
        });
      }

      // Sales
      const rangeSales = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherId: vouchers.id,
          quantity: salesItems.quantity,
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
            sql`${vouchers.voucherDate}::date >= ${startDate}::date`,
            sql`${vouchers.voucherDate}::date <= ${endDate}::date`
          )
        )
        .orderBy(vouchers.voucherDate);

      for (const s of rangeSales) {
        txns.push({
          date: s.voucherDate,
          particulars: "Cash",
          vchType: "POS",
          voucherId: s.voucherId,
          inwardQty: 0,
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: Math.abs(finite(s.quantity)),
          outwardRate: Math.max(finite(s.costPrice), 0),
          outwardValue: Math.max(finite(s.totalCost), 0),
          isPOS: true,
          posSellingRate: Math.max(finite(s.sellingPrice), 0),
          posSellingValue: Math.max(finite(s.totalSales), 0),
        });
      }

      // Credit / Debit Notes
      const rangeNotes = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherId: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          noteType: vouchers.voucherType,
          quantity: creditNoteItems.quantity,
          inventoryCost: creditNoteItems.inventoryCost,
        })
        .from(creditNoteItems)
        .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
        .where(
          and(
            eq(creditNoteItems.stockItemId, stockItemId),
            eq(creditNoteItems.locationId, locationId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`${vouchers.voucherDate}::date >= ${startDate}::date`,
            sql`${vouchers.voucherDate}::date <= ${endDate}::date`
          )
        )
        .orderBy(vouchers.voucherDate);

      for (const n of rangeNotes) {
        const qty = Math.abs(finite(n.quantity));
        const rate = Math.max(finite(n.inventoryCost), 0);
        const value = qty * rate;
        const isCredit = n.noteType === "Credit Note";
        txns.push({
          date: n.voucherDate,
          particulars: n.voucherNumber || n.noteType || "Credit/Debit Note",
          vchType: isCredit ? "Credit Note" : "Debit Note",
          voucherId: n.voucherId,
          inwardQty: isCredit ? qty : 0,
          inwardRate: isCredit ? rate : 0,
          inwardValue: isCredit ? value : 0,
          outwardQty: isCredit ? 0 : qty,
          outwardRate: isCredit ? 0 : rate,
          outwardValue: isCredit ? 0 : value,
        });
      }

      // Container Offloads
      const rangeOffloads = await db
        .select({
          offloadedAt: containerOffloads.offloadedAt,
          poId: purchaseOrders.id,
          containerCode: containers.containerNumber,
          poNumber: purchaseOrders.poNumber,
          quantity: poLineItems.quantity,
          rate: poLineItems.rate,
          lineTotal: poLineItems.lineTotal,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .innerJoin(purchaseOrders, eq(purchaseOrders.containerId, containers.id))
        .innerJoin(poLineItems, eq(poLineItems.poId, purchaseOrders.id))
        .where(
          and(
            eq(poLineItems.stockItemId, stockItemId),
            eq(containers.companyId, companyId),
            eq(containerOffloads.locationId, locationId),
            sql`${containerOffloads.offloadedAt}::date >= ${startDate}::date`,
            sql`${containerOffloads.offloadedAt}::date <= ${endDate}::date`
          )
        )
        .orderBy(containerOffloads.offloadedAt);

      for (const o of rangeOffloads) {
        const qty = Math.abs(finite(o.quantity));
        const baseValue = Math.max(finite(o.lineTotal), 0);
        const additionalCost = Math.max(finite(o.additionalCostPerBale), 0) * qty;
        const landedValue = baseValue + additionalCost;
        const dateStr =
          o.offloadedAt instanceof Date
            ? o.offloadedAt.toISOString().split("T")[0]
            : String(o.offloadedAt).split("T")[0];
        txns.push({
          date: dateStr,
          particulars: `Container: ${o.containerCode} / PO: ${o.poNumber}`,
          vchType: "PO Offload",
          voucherId: 0,
          poId: o.poId,
          inwardQty: qty,
          inwardRate: qty > 0 ? landedValue / qty : 0,
          inwardValue: landedValue,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
        });
      }

      // Sort by date (inward before outward on same date)
      txns.sort((a, b) => {
        const d = new Date(a.date).getTime() - new Date(b.date).getTime();
        if (d !== 0) return d;
        if (a.inwardQty > 0 && b.outwardQty > 0) return -1;
        if (a.outwardQty > 0 && b.inwardQty > 0) return 1;
        return 0;
      });

      type TxOut = TxRaw & {
        closingQty: number;
        closingRate: number;
        closingValue: number;
        isOpeningBalance?: boolean;
      };

      let runQty = openingQty;
      let runValue = openingQty > 0 ? openingValue : 0;
      let rateMemory = openingRate;
      const out: TxOut[] = [];

      if (runQty !== 0 || runValue > 0 || rateMemory > 0) {
        out.push({
          date: startDate,
          particulars: "Opening Balance",
          vchType: "",
          voucherId: 0,
          inwardQty: runQty,
          inwardRate: rateMemory,
          inwardValue: runValue,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
          closingQty: runQty,
          closingRate: rateMemory,
          closingValue: runValue,
          isOpeningBalance: true,
        });
      }

      // Follow the same asset-value boundary as Inventory: total value is never
      // allowed to become negative. average rate is non-negative cost memory.
      for (const t of txns) {
        const currentRate = runQty > 0 && runValue > 0 ? runValue / runQty : rateMemory;
        const storedOutwardValue = Math.max(t.outwardValue, 0);
        const calculatedOutwardValue = t.outwardQty > 0 ? t.outwardQty * Math.max(currentRate, 0) : 0;
        const outwardValue = storedOutwardValue > 0 ? storedOutwardValue : calculatedOutwardValue;
        const outwardRate = t.outwardQty > 0 ? outwardValue / t.outwardQty : 0;

        const nextQty = runQty + t.inwardQty - t.outwardQty;
        const unboundedValue = runValue + Math.max(t.inwardValue, 0) - outwardValue;
        const nextValue = nextQty > 0 ? Math.max(unboundedValue, 0) : 0;

        runQty = nextQty;
        runValue = nextValue;
        if (runQty > 0 && runValue > 0) rateMemory = runValue / runQty;
        else if (t.inwardRate > 0) rateMemory = Math.max(t.inwardRate, 0);
        else if (outwardRate > 0) rateMemory = Math.max(outwardRate, 0);

        const closingRate = runQty > 0 && runValue > 0 ? runValue / runQty : Math.max(rateMemory, 0);
        out.push({
          ...t,
          outwardRate,
          outwardValue,
          closingQty: runQty,
          closingRate,
          closingValue: runValue,
        });
      }

      // Re-anchor the period close to the exact Inventory snapshot. This is what
      // the Inventory page uses, so both the Closing KPI and the last Closing
      // columns now agree with Inventory instead of exposing voucher drift.
      const historicalClosing = await calculateHistoricalLocationInventory(locationId, companyId, endDate);
      const closingRow = historicalClosing.find((row) => row.stockItemId === stockItemId);
      const authoritativeClosingQty = finite(closingRow?.quantity);
      const authoritativeClosingValue = Math.max(finite(closingRow?.totalValue), 0);
      const storedClosingRate = Math.max(finite(closingRow?.averageRate), 0);
      const authoritativeClosingRate =
        authoritativeClosingQty > 0 && authoritativeClosingValue > 0
          ? authoritativeClosingValue / authoritativeClosingQty
          : storedClosingRate;

      if (out.length > 0) {
        const lastTx = out[out.length - 1];
        lastTx.closingQty = authoritativeClosingQty;
        lastTx.closingValue = authoritativeClosingValue;
        lastTx.closingRate = authoritativeClosingRate;
      }

      const nonOpening = out.filter((t) => !t.isOpeningBalance);
      const totals = {
        inwardQty: nonOpening.reduce((s, t) => s + t.inwardQty, 0),
        inwardValue: nonOpening.reduce((s, t) => s + t.inwardValue, 0),
        outwardQty: nonOpening.reduce((s, t) => s + t.outwardQty, 0),
        outwardValue: nonOpening.reduce((s, t) => s + t.outwardValue, 0),
        closingQty: authoritativeClosingQty,
        closingRate: authoritativeClosingRate,
        closingValue: authoritativeClosingValue,
        inwardRate: 0,
        outwardRate: 0,
      };
      totals.inwardRate = totals.inwardQty > 0 ? totals.inwardValue / totals.inwardQty : 0;
      totals.outwardRate = totals.outwardQty > 0 ? totals.outwardValue / totals.outwardQty : 0;

      res.json({ stockItem, location, startDate, endDate, transactions: out, totals });
    } catch (error: unknown) {
      logger.error("Location stock item transactions range error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
