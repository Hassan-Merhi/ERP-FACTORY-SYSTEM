import Decimal from "decimal.js";
import type { VoucherWithItems } from "./types";
import { posDaybookEditMessages } from "@shared/posDaybookEditPolicy";

export interface PosDaybookDraftLine {
  id?: number;
  stockItemId: number;
  stockItemName: string;
  quantity: string;
  unitPrice: string;
}

export function createDaybookDraftLines(sale: VoucherWithItems): PosDaybookDraftLine[] {
  const exchangeRate = new Decimal(sale.exchangeRate || "1");
  return (sale.salesItems ?? []).map((item) => ({
    id: item.id,
    stockItemId: item.stockItemId,
    stockItemName: item.stockItemName || `Item ${item.stockItemId}`,
    quantity: String(item.quantity),
    unitPrice:
      sale.currency === "ZMW"
        ? new Decimal(item.sellingPrice).times(exchangeRate).toDecimalPlaces(2).toFixed(2)
        : String(item.sellingPrice),
  }));
}

/** Preserve original date, currency, payment and sale credit status. */
export function buildDaybookSaleEditPayload(
  sale: VoucherWithItems,
  lines: PosDaybookDraftLine[],
  description: string
) {
  if (!lines.length) throw new Error(posDaybookEditMessages.missingItems);
  const isZmw = sale.currency === "ZMW";
  const lockedRate = new Decimal(sale.exchangeRate || "0");
  if (isZmw && (!lockedRate.isFinite() || lockedRate.lte(0))) {
    throw new Error(posDaybookEditMessages.invalidRate);
  }

  return {
    voucherDate: sale.voucherDate,
    currency: sale.currency || "USD",
    locationId: sale.locationId,
    description,
    isCreditSale: Boolean(sale.isCreditSale),
    items: lines.map((line) => {
      const quantity = new Decimal(line.quantity);
      const nativeUnit = new Decimal(line.unitPrice);
      if (!quantity.isFinite() || quantity.lte(0) || !nativeUnit.isFinite() || nativeUnit.lte(0)) {
        throw new Error(posDaybookEditMessages.invalidLine);
      }
      if (isZmw && nativeUnit.decimalPlaces() > 2) {
        throw new Error(posDaybookEditMessages.invalidKwachaPrecision);
      }
      const usdUnit = isZmw ? nativeUnit.div(lockedRate).toDecimalPlaces(6).toFixed(6) : nativeUnit.toString();
      return {
        ...(line.id != null ? { id: line.id } : {}),
        stockItemId: line.stockItemId,
        quantity: quantity.toString(),
        sellingPrice: usdUnit,
        ...(isZmw ? { originalCurrencyRate: nativeUnit.toFixed(2) } : {}),
      };
    }),
  };
}

/** Preview the same per-line cent/ngwee rounding the posted sale will use. */
export function previewDaybookSaleTotals(
  lines: readonly PosDaybookDraftLine[]
): { lineTotals: string[]; total: string } | null {
  if (!lines.length) return null;
  try {
    const amounts = lines.map((line) => {
      const quantity = new Decimal(line.quantity);
      const price = new Decimal(line.unitPrice);
      if (!quantity.isFinite() || !price.isFinite() || quantity.lte(0) || price.lte(0)) {
        return null;
      }
      return quantity.times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    });
    if (amounts.some((amount) => amount === null)) return null;
    const lineTotals = amounts.map((amount) => amount!.toFixed(2));
    const total = amounts.reduce((sum, amount) => sum.plus(amount!), new Decimal(0)).toFixed(2);
    return { lineTotals, total };
  } catch {
    return null;
  }
}
