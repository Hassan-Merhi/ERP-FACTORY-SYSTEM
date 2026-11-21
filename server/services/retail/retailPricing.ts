/**
 * Retail Wave 2 pricing engine (Track B + Track C money math).
 *
 * Every sale line is priced once, here, and the result is snapshotted onto the sale
 * row so receipts, returns, exchanges and reports never recompute history:
 *
 *   list (original) price
 *     − promotion (automatic, date-based)
 *     − manual line discount (percent or fixed per unit)
 *     − allocated share of the whole-sale discount (percent or fixed)
 *     = final net (pre-tax) unit price
 *   + tax (exclusive) / tax carved out of the charged price (inclusive)
 *     = what the customer actually pays (`grossUnitPrice` × quantity)
 *
 * Money is handled in integer cents with largest-remainder allocation for the
 * whole-sale discount, so:
 *   sum(line discounts) === discountTotal        (exactly, to the cent)
 *   subtotal + taxAmount === totalAmount         (exactly, to the cent)
 *   listSubtotal − discountTotal === subtotal
 *
 * When a line carries no promotion, discount, override or tax the original exact
 * values are used with no rounding at all, so an untouched retail checkout keeps
 * the pre-Wave-2 numbers byte for byte.
 */

import {
  priceRetailCartPart1,
  roundRetailMoney,
  type RetailLinePricingInput,
  type RetailOrderDiscountInput,
  type RetailTaxInput,
} from "./priceRetailCartPart1";
export {
  roundRetailMoney,
  type RetailLineDiscountInputType,
  type RetailPromotionDiscountType,
  type RetailOrderDiscountType,
  type RetailPromotionMatch,
  type RetailLinePricingInput,
  type RetailOrderDiscountInput,
  type RetailTaxInput,
} from "./priceRetailCartPart1";

export type RetailLineDiscountSnapshotType = "none" | "percent" | "fixed" | "override" | "promotion";

export interface RetailPricedLine {
  variantId: number;
  quantity: number;
  /** List price snapshot — the "original price" that must never be destroyed. */
  originalUnitPrice: number;
  /** Final pre-tax unit price actually charged. */
  unitPrice: number;
  /** What the customer paid per unit, tax included — the refund basis. */
  grossUnitPrice: number;
  /** Total discount for the line (promotion + manual + allocated order discount), pre-tax. */
  lineDiscountAmount: number;
  lineDiscountType: RetailLineDiscountSnapshotType;
  /** Raw entered value: percent points or per-unit fixed amount. */
  lineDiscountValue: number;
  discountReason: string | null;
  priceOverride: boolean;
  promotionId: number | null;
  promotionAmount: number;
  taxAmount: number;
  /** quantity × grossUnitPrice — what was paid for this line. */
  lineTotal: number;
  /** quantity × originalUnitPrice. */
  listLineTotal: number;
  /** quantity × unitPrice — pre-tax, after discount. */
  netLineTotal: number;
  /** Effective manual discount percent of the affected list value (0 when none). */
  effectiveDiscountPercent: number;
}

export interface RetailPricedCart {
  lines: RetailPricedLine[];
  /** Sum of line list pre-tax values. */
  listSubtotal: number;
  /** Sum of every line discount (pre-tax). */
  discountTotal: number;
  /** Net, pre-tax amount after discount: listSubtotal − discountTotal. */
  subtotal: number;
  taxAmount: number;
  /** What the customer pays: subtotal + taxAmount. */
  totalAmount: number;
  orderDiscountAmount: number;
}

const fromCents = (cents: number): number => cents / 100;

/**
 * Prices a whole retail cart. Throws on invalid input (bad quantity, negative price,
 * override combined with a line discount, discount above 100%, …) so the route can
 * return a 400 instead of persisting nonsense.
 */
export function priceRetailCart(
  inputLines: RetailLinePricingInput[],
  orderDiscount: RetailOrderDiscountInput | null | undefined,
  tax: RetailTaxInput
): RetailPricedCart {
  const { taxRate, taxDivisor, working, orderDiscountCents } = priceRetailCartPart1(inputLines, orderDiscount, tax);

  // ── Tax ────────────────────────────────────────────────────────────────────
  for (const line of working) {
    if (!tax.enabled) {
      line.taxCents = 0;
      line.grossCents = line.netCents;
      continue;
    }
    if (tax.inclusive) {
      const gross = line.netCents;
      const taxCents = Math.round((gross * taxRate) / taxDivisor);
      line.grossCents = gross;
      line.taxCents = taxCents;
      line.netCents = gross - taxCents;
    } else {
      line.taxCents = Math.round(line.netCents * taxRate);
      line.grossCents = line.netCents + line.taxCents;
    }
  }

  const lines: RetailPricedLine[] = working.map((line) => {
    if (line.untouched) {
      const unitPrice = line.input.listUnitPrice;
      return {
        variantId: line.input.variantId,
        quantity: line.quantity,
        originalUnitPrice: unitPrice,
        unitPrice,
        grossUnitPrice: unitPrice,
        lineDiscountAmount: 0,
        lineDiscountType: "none" as RetailLineDiscountSnapshotType,
        lineDiscountValue: 0,
        discountReason: null,
        priceOverride: false,
        promotionId: null,
        promotionAmount: 0,
        taxAmount: 0,
        lineTotal: unitPrice * line.quantity,
        listLineTotal: unitPrice * line.quantity,
        netLineTotal: unitPrice * line.quantity,
        effectiveDiscountPercent: 0,
      };
    }

    const listNetCents = line.listNetCents;
    const discountCents = Math.max(0, listNetCents - line.netCents);
    const listNet = fromCents(listNetCents);
    const discountAmount = fromCents(discountCents);
    const effectiveDiscountPercent = listNet > 0 ? (discountAmount / listNet) * 100 : 0;
    const promotionUsed = line.promotion;
    const lineDiscountType: RetailLineDiscountSnapshotType =
      line.priceOverride !== null
        ? "override"
        : line.discount.type !== "none"
          ? line.discount.type
          : promotionUsed
            ? "promotion"
            : "none";

    return {
      variantId: line.input.variantId,
      quantity: line.quantity,
      originalUnitPrice: line.input.listUnitPrice,
      unitPrice: fromCents(line.netCents) / line.quantity,
      grossUnitPrice: fromCents(line.grossCents) / line.quantity,
      lineDiscountAmount: discountAmount,
      lineDiscountType,
      lineDiscountValue: line.priceOverride !== null ? line.priceOverride : line.discount.value,
      discountReason: line.input.discountReason?.trim() ? line.input.discountReason.trim() : null,
      priceOverride: line.priceOverride !== null,
      promotionId: promotionUsed?.id ?? null,
      promotionAmount: Math.min(discountAmount, fromCents(line.promotionAmountCents)),
      taxAmount: fromCents(line.taxCents),
      lineTotal: fromCents(line.grossCents),
      listLineTotal: line.listLineTotal,
      netLineTotal: fromCents(line.netCents),
      effectiveDiscountPercent,
    };
  });

  // Untouched lines contribute their exact (unrounded) values so a plain retail
  // checkout keeps the Wave 1 totals byte for byte.
  let listSubtotal = 0;
  let subtotal = 0;
  let taxAmount = 0;
  let totalAmount = 0;
  for (const line of working) {
    if (line.untouched) {
      const exact = line.input.listUnitPrice * line.quantity;
      listSubtotal += exact;
      subtotal += exact;
      totalAmount += exact;
      continue;
    }
    listSubtotal += fromCents(line.listNetCents);
    subtotal += fromCents(line.netCents);
    taxAmount += fromCents(line.taxCents);
    totalAmount += fromCents(line.grossCents);
  }

  return {
    lines,
    listSubtotal,
    discountTotal: Math.max(0, roundRetailMoney(listSubtotal - subtotal, 6)),
    subtotal,
    taxAmount,
    totalAmount,
    orderDiscountAmount: fromCents(orderDiscountCents),
  };
}

/**
 * Effective manual discount percent used by the approval policy: how much of the
 * affected list value the entered discounts removed, ignoring tax.
 */
export function effectiveManualDiscountPercent(priced: RetailPricedCart): number {
  const listNet = priced.listSubtotal;
  if (listNet <= 0) return 0;
  const manualDiscount = Math.max(
    0,
    priced.discountTotal - priced.lines.reduce((sum, line) => sum + (line.promotionAmount ?? 0), 0)
  );
  return Math.min(100, (manualDiscount / listNet) * 100);
}

export function hasManualAdjustment(
  priced: RetailPricedCart,
  orderDiscount: RetailOrderDiscountInput | null | undefined
) {
  const hasLine = priced.lines.some(
    (line, index) =>
      line.priceOverride ||
      (priced.lines[index].lineDiscountType !== "none" && priced.lines[index].lineDiscountType !== "promotion")
  );
  const hasOrder = (orderDiscount?.type ?? "none") !== "none" && Number(orderDiscount?.value ?? 0) > 0;
  return { hasLine, hasOrder, any: hasLine || hasOrder };
}
