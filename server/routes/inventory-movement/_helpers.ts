/**
 * Shared state and helpers for the inventoryMovementRoutes routes.
 *
 * Extracted verbatim from the former single-file inventoryMovementRoutes.ts.
 */
import { eq, and, or, isNull, isNotNull, gte, lte, lt } from "drizzle-orm";
import { db } from "../../db";
import {
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

/**
 * Inventory movement, reconciliation & import routes.
 *
 * Monthly stock-movement summary + drill-down, inventory reconciliation, the
 * per-location "vouchers today" feed, and the cost-price / inventory import
 * endpoints. Extracted from inventoryRoutes.ts as a sub-registrar; the
 * movement-only MONTH_NAMES_INV constant and the dayBefore / fetchStockMovements
 * closures move with it. Behaviour is unchanged.
 */

/**
 * Month labels and the shared stock-movement query used by the movement,
 * drill and reconcile endpoints.
 *
 * Declared at module scope so those handlers can live in separate modules;
 * they previously relied on closing over the register function's body.
 */
export const MONTH_NAMES_INV = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Returns the calendar day immediately before the given YYYY-MM-DD date string.
export function dayBefore(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface StockMovementTx {
  date: string;
  particulars: string;
  vchType: string;
  voucherId: number | null;
  poId: number | null;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  isPOS: boolean;
  posSellingRate: number;
  posSellingValue: number;
}

export async function fetchStockMovements(
  companyId: number,
  stockItemId: number,
  locationId: number | null,
  fromDate: string | null,
  toDate: string | null,
  toDateExclusive = false
): Promise<StockMovementTx[]> {
  const results: StockMovementTx[] = [];

  const dateConds = (dateCol: typeof vouchers.voucherDate) => {
    const parts = [];
    if (fromDate) parts.push(gte(dateCol, fromDate));
    if (toDate) parts.push(toDateExclusive ? lt(dateCol, toDate) : lte(dateCol, toDate));
    return parts;
  };

  // 1. Sales (outward)
  const salesRows = await db
    .select({
      date: vouchers.voucherDate,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherId: vouchers.id,
      qty: salesItems.quantity,
      costPrice: salesItems.costPrice,
      totalCost: salesItems.totalCost,
      sellingPrice: salesItems.sellingPrice,
      totalSales: salesItems.totalSales,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(salesItems.stockItemId, stockItemId),
        ...(locationId !== null ? [eq(vouchers.locationId, locationId)] : []),
        ...dateConds(vouchers.voucherDate)
      )
    );

  for (const r of salesRows) {
    const qty = parseFloat(r.qty || "0");
    const value = parseFloat(r.totalCost || "0");
    const vt = r.voucherType || "Sales";
    const isPOS = vt.toLowerCase().includes("pos");
    results.push({
      date: r.date,
      particulars: isPOS ? "Cash" : r.voucherNumber,
      vchType: vt,
      voucherId: r.voucherId,
      poId: null,
      inwardQty: 0,
      inwardRate: 0,
      inwardValue: 0,
      outwardQty: qty,
      outwardRate: qty > 0 ? value / qty : 0,
      outwardValue: value,
      isPOS: vt.toLowerCase().includes("pos"),
      posSellingRate: parseFloat(r.sellingPrice || "0"),
      posSellingValue: parseFloat(r.totalSales || "0"),
    });
  }

  // 2. Credit Notes (inward = returns)
  const cnRows = await db
    .select({
      date: vouchers.voucherDate,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherId: vouchers.id,
      qty: creditNoteItems.quantity,
      totalValue: creditNoteItems.totalValue,
      inventoryCost: creditNoteItems.inventoryCost,
    })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(creditNoteItems.stockItemId, stockItemId),
        ...(locationId !== null ? [eq(creditNoteItems.locationId, locationId)] : []),
        ...dateConds(vouchers.voucherDate)
      )
    );

  for (const r of cnRows) {
    const qty = parseFloat(r.qty || "0");
    const value = parseFloat(r.totalValue || "0");
    results.push({
      date: r.date,
      particulars: r.voucherNumber,
      vchType: r.voucherType || "Credit Note",
      voucherId: r.voucherId,
      poId: null,
      inwardQty: qty,
      inwardRate: qty > 0 ? value / qty : 0,
      inwardValue: value,
      outwardQty: 0,
      outwardRate: 0,
      outwardValue: 0,
      isPOS: false,
      posSellingRate: 0,
      posSellingValue: 0,
    });
  }

  // 3. Stock Adjustments (positive qty = inward, negative = outward)
  const adjRows = await db
    .select({
      date: vouchers.voucherDate,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherId: vouchers.id,
      adjustmentType: stockAdjustmentVouchers.adjustmentType,
      qty: stockAdjustmentItems.quantity,
      rate: stockAdjustmentItems.rate,
    })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(stockAdjustmentItems.stockItemId, stockItemId),
        ...(locationId !== null ? [eq(stockAdjustmentVouchers.locationId, locationId)] : []),
        ...dateConds(vouchers.voucherDate)
      )
    );

  for (const r of adjRows) {
    const qty = parseFloat(r.qty || "0");
    const rate = parseFloat(r.rate || "0");
    if (qty > 0) {
      results.push({
        date: r.date,
        particulars: r.voucherNumber,
        vchType: r.voucherType || r.adjustmentType || "Production",
        voucherId: r.voucherId,
        poId: null,
        inwardQty: qty,
        inwardRate: rate,
        inwardValue: qty * rate,
        outwardQty: 0,
        outwardRate: 0,
        outwardValue: 0,
        isPOS: false,
        posSellingRate: 0,
        posSellingValue: 0,
      });
    } else if (qty < 0) {
      const absQty = Math.abs(qty);
      results.push({
        date: r.date,
        particulars: r.voucherNumber,
        vchType: r.voucherType || r.adjustmentType || "Consumption",
        voucherId: r.voucherId,
        poId: null,
        inwardQty: 0,
        inwardRate: 0,
        inwardValue: 0,
        outwardQty: absQty,
        outwardRate: rate,
        outwardValue: absQty * rate,
        isPOS: false,
        posSellingRate: 0,
        posSellingValue: 0,
      });
    }
  }

  // 4. Stock Transfers (only when a specific location is requested)
  if (locationId !== null) {
    const tfRows = await db
      .select({
        date: vouchers.voucherDate,
        voucherNumber: vouchers.voucherNumber,
        voucherType: vouchers.voucherType,
        voucherId: vouchers.id,
        sourceLocId: stockTransferItems.sourceLocationId,
        destLocId: stockTransferVouchers.destinationLocationId,
        qty: stockTransferItems.quantity,
        rate: stockTransferItems.rate,
        totalAmount: stockTransferItems.totalAmount,
      })
      .from(stockTransferItems)
      .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(stockTransferItems.stockItemId, stockItemId),
          or(
            eq(stockTransferItems.sourceLocationId, locationId),
            eq(stockTransferVouchers.destinationLocationId, locationId)
          ),
          ...dateConds(vouchers.voucherDate)
        )
      );

    for (const r of tfRows) {
      const qty = parseFloat(r.qty || "0");
      const rate = parseFloat(r.rate || "0");
      const amount = parseFloat(r.totalAmount || "0");
      if (r.sourceLocId === locationId) {
        results.push({
          date: r.date,
          particulars: r.voucherNumber,
          vchType: "Stock Transfer Out",
          voucherId: r.voucherId,
          poId: null,
          inwardQty: 0,
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: qty,
          outwardRate: rate,
          outwardValue: amount,
          isPOS: false,
          posSellingRate: 0,
          posSellingValue: 0,
        });
      } else {
        results.push({
          date: r.date,
          particulars: r.voucherNumber,
          vchType: "Stock Transfer In",
          voucherId: r.voucherId,
          poId: null,
          inwardQty: qty,
          inwardRate: rate,
          inwardValue: amount,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
          isPOS: false,
          posSellingRate: 0,
          posSellingValue: 0,
        });
      }
    }
  }

  // 5. PO Line Items (inward = container imports)
  const poRows = await db
    .select({
      date: vouchers.voucherDate,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherId: vouchers.id,
      poId: purchaseOrders.id,
      qty: poLineItems.quantity,
      rate: poLineItems.rate,
      lineTotal: poLineItems.lineTotal,
    })
    .from(poLineItems)
    .innerJoin(purchaseOrders, eq(poLineItems.poId, purchaseOrders.id))
    .innerJoin(vouchers, eq(purchaseOrders.voucherId, vouchers.id))
    .where(
      and(
        eq(purchaseOrders.companyId, companyId),
        isNull(vouchers.deletedAt),
        isNotNull(purchaseOrders.voucherId),
        eq(poLineItems.stockItemId, stockItemId),
        ...(locationId !== null ? [eq(vouchers.locationId, locationId)] : []),
        ...dateConds(vouchers.voucherDate)
      )
    );

  for (const r of poRows) {
    const qty = parseFloat(r.qty || "0");
    const rate = parseFloat(r.rate || "0");
    const lineTotal = parseFloat(r.lineTotal || "0");
    results.push({
      date: r.date,
      particulars: r.voucherNumber,
      vchType: r.voucherType || "Purchase Import",
      voucherId: r.voucherId,
      poId: r.poId,
      inwardQty: qty,
      inwardRate: rate,
      inwardValue: lineTotal,
      outwardQty: 0,
      outwardRate: 0,
      outwardValue: 0,
      isPOS: false,
      posSellingRate: 0,
      posSellingValue: 0,
    });
  }

  return results;
}
