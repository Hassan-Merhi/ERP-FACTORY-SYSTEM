/**
 * Stock adjustment voucher types and the generic-route refusal (wave 12, owner
 * decision 1).
 *
 * Stock Adjustment, Production, Consumption and Mixed vouchers are one-sided
 * under periodic inventory; the database balance guard exempts one only when a
 * stock document (stock_adjustment_items) backs it. They are created and edited
 * only by the stock adjustment writers (storage/stock-ops/transfers-create.ts and
 * transfers-update.ts, behind POST/PUT /api/stock-adjustments and the waste
 * dispatch). The generic voucher routes refuse them, so a client can no longer
 * label an arbitrary voucher "Production" to escape the balance rule.
 */

const STOCK_ADJUSTMENT_TYPES = ["stock adjustment", "production", "consumption", "mixed"];

/** True for the stock adjustment voucher types, compared trimmed and case-insensitively. */
export function isStockAdjustmentVoucherType(voucherType: unknown): boolean {
  if (typeof voucherType !== "string") return false;
  return STOCK_ADJUSTMENT_TYPES.includes(voucherType.trim().toLowerCase());
}

export const STOCK_VOUCHER_GENERIC_ROUTE_CODE = "STOCK_VOUCHER_TYPE_NOT_ALLOWED";
export const STOCK_VOUCHER_GENERIC_ROUTE_MESSAGE =
  "Production, consumption, mixed and stock adjustment vouchers can only be created and edited from the stock adjustment form.";

export interface StockVoucherTypeRefusal {
  status: 400;
  body: { message: string; code: typeof STOCK_VOUCHER_GENERIC_ROUTE_CODE };
}

/**
 * The 400 a generic voucher route returns when any of the given voucher types
 * (the stored type, the requested one) is a stock adjustment type; null otherwise.
 */
export function stockVoucherTypeRefusal(...voucherTypes: unknown[]): StockVoucherTypeRefusal | null {
  if (!voucherTypes.some(isStockAdjustmentVoucherType)) return null;
  return {
    status: 400,
    body: { message: STOCK_VOUCHER_GENERIC_ROUTE_MESSAGE, code: STOCK_VOUCHER_GENERIC_ROUTE_CODE },
  };
}
