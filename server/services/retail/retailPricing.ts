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
import { RETAIL_DEFAULT_DISCOUNT_LIMIT_PERCENT } from "@shared/schema";

export const RETAIL_MONEY_EPSILON = 0.000001;

export type RetailLineDiscountInputType = "none" | "percent" | "fixed";
export type RetailPromotionDiscountType = "percent" | "fixed";
export type RetailOrderDiscountType = "none" | "percent" | "fixed";
export type RetailLineDiscountSnapshotType = "none" | "percent" | "fixed" | "override" | "promotion";

export interface RetailPromotionMatch {
  id: number;
  discountType: RetailPromotionDiscountType;
  value: number;
}

export interface RetailLinePricingInput {
  variantId: number;
  quantity: number;
  /** The variant's configured selling price at sale time (never mutated). */
  listUnitPrice: number;
  /** Manual price override; replaces the list price and cannot be combined with a line discount. */
  priceOverride?: number | null;
  discountType?: RetailLineDiscountInputType | null;
  /** Percent points for `percent`; per-unit amount for `fixed`. */
  discountValue?: number | null;
  discountReason?: string | null;
  promotion?: RetailPromotionMatch | null;
}

export interface RetailOrderDiscountInput {
  type: RetailOrderDiscountType;
  value: number;
  reason?: string | null;
}

export interface RetailTaxInput {
  enabled: boolean;
  /** Fraction, e.g. 0.18 for 18%. */
  rate: number;
  inclusive: boolean;
  label?: string | null;
}

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

export function roundRetailMoney(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) throw new Error("Retail amount must be a finite number");
  const factor = 10 ** decimals;
  const scaled = Math.abs(value) * factor;
  // 1e-9 guards binary floating point noise (e.g. 1.005 → 1.00 instead of 1.01).
  const rounded = Math.round(scaled + 1e-9) / factor;
  return value < 0 ? -rounded : rounded;
}

const toCents = (value: number): number => Math.round(roundRetailMoney(value, 2) * 100);
const fromCents = (cents: number): number => cents / 100;

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function normalizeQuantity(quantity: number): number {
  const value = requireFinite(Number(quantity), "Quantity");
  if (value <= 0) throw new Error("Quantity must be greater than zero");
  return value;
}

function normalizeLineDiscount(line: RetailLinePricingInput): { type: RetailLineDiscountInputType; value: number } {
  const type = line.discountType ?? "none";
  const rawValue = Number(line.discountValue ?? 0);
  if (type === "none") return { type, value: 0 };
  requireFinite(rawValue, "Discount value");
  if (rawValue <= 0) throw new Error("Discount value must be greater than zero");
  if (type === "percent" && rawValue > 100) throw new Error("Discount percent cannot exceed 100");
  return { type, value: rawValue };
}

function normalizePromotion(promotion: RetailPromotionMatch | null | undefined): RetailPromotionMatch | null {
  if (!promotion) return null;
  const value = requireFinite(Number(promotion.value), "Promotion value");
  if (value <= 0) return null;
  if (promotion.discountType === "percent" && value > 100) throw new Error("Promotion percent cannot exceed 100");
  return { id: promotion.id, discountType: promotion.discountType, value };
}

/** Per-unit discount produced by a promotion on the list price. */
function promotionPerUnit(base: number, promotion: RetailPromotionMatch | null): number {
  if (!promotion) return 0;
  const raw = promotion.discountType === "percent" ? (base * promotion.value) / 100 : promotion.value;
  return Math.min(Math.max(raw, 0), base);
}

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
  if (!inputLines.length) throw new Error("At least one line is required");
  const taxRate = tax.enabled ? requireFinite(Number(tax.rate), "Tax rate") : 0;
  if (tax.enabled && (taxRate < 0 || taxRate >= 1)) throw new Error("Tax rate must be between 0 and 1 (exclusive)");
  const taxDivisor = 1 + taxRate;

  const orderType: RetailOrderDiscountType = orderDiscount?.type ?? "none";
  const orderValue = requireFinite(Number(orderDiscount?.value ?? 0), "Sale discount value");
  if (orderType !== "none" && orderValue <= 0) throw new Error("Sale discount value must be greater than zero");
  if (orderType === "percent" && orderValue > 100) throw new Error("Sale discount percent cannot exceed 100");
  // A whole-sale discount touches every line, so it disables the exact no-rounding path.
  const orderRequested = orderType !== "none" && orderValue > 0;

  interface WorkingLine {
    input: RetailLinePricingInput;
    quantity: number;
    promotion: RetailPromotionMatch | null;
    discount: { type: RetailLineDiscountInputType; value: number };
    priceOverride: number | null;
    /** Exact (unrounded) list value when the line needs no adjustments. */
    untouched: boolean;
    listNetCents: number;
    netCents: number;
    taxCents: number;
    grossCents: number;
    listLineTotal: number;
    manualDiscountPercent: number;
    /** Net (pre-tax) value of the automatic promotion applied to this line. */
    promotionAmountCents: number;
    promotionGrossCents: number;
  }

  const working: WorkingLine[] = inputLines.map((line) => {
    const quantity = normalizeQuantity(Number(line.quantity));
    const listUnitPrice = requireFinite(Number(line.listUnitPrice), "List unit price");
    if (listUnitPrice < 0) throw new Error("List unit price cannot be negative");

    const hasOverride = line.priceOverride !== null && line.priceOverride !== undefined;
    const priceOverride = hasOverride ? requireFinite(Number(line.priceOverride), "Price override") : null;
    if (priceOverride !== null && priceOverride <= 0) throw new Error("Price override must be greater than zero");

    const discount = normalizeLineDiscount(line);
    if (priceOverride !== null && discount.type !== "none") {
      throw new Error("A price override cannot be combined with a line discount");
    }
    const promotion = normalizePromotion(line.promotion);
    const untouched =
      priceOverride === null && discount.type === "none" && promotion === null && !tax.enabled && !orderRequested;

    const base = priceOverride ?? listUnitPrice;
    const promotionAmountPerUnit = priceOverride === null ? promotionPerUnit(base, promotion) : 0;
    const baseCents = toCents(base);
    const listGrossCents = toCents(listUnitPrice) * quantity;
    const listNetCents = tax.enabled && tax.inclusive ? Math.round(listGrossCents / taxDivisor) : listGrossCents;
    const promotionGrossCents = Math.round(promotionAmountPerUnit * quantity * 100);
    const promotionNetCents =
      tax.enabled && tax.inclusive ? Math.round(promotionGrossCents / taxDivisor) : promotionGrossCents;

    if (untouched) {
      return {
        input: line,
        quantity,
        promotion,
        discount,
        priceOverride,
        untouched,
        listNetCents,
        netCents: listGrossCents,
        taxCents: 0,
        grossCents: listGrossCents,
        listLineTotal: listUnitPrice * quantity,
        manualDiscountPercent: 0,
        promotionAmountCents: 0,
        promotionGrossCents: 0,
      };
    }

    const promotionOffCents = toCents(promotionAmountPerUnit);
    const afterPromotionCents = Math.max(0, baseCents - promotionOffCents);
    let manualOffCents = 0;
    let manualDiscountPercent = 0;
    if (discount.type === "percent") {
      manualOffCents = Math.round((afterPromotionCents * discount.value) / 100);
      manualDiscountPercent = discount.value;
    } else if (discount.type === "fixed") {
      manualOffCents = toCents(discount.value);
      manualDiscountPercent = afterPromotionCents > 0 ? (manualOffCents / afterPromotionCents) * 100 : 0;
    }
    const netUnitCents = Math.max(0, afterPromotionCents - manualOffCents);
    const netCents = Math.round(netUnitCents * quantity);

    return {
      input: line,
      quantity,
      promotion,
      discount,
      priceOverride,
      untouched,
      listNetCents,
      netCents,
      taxCents: 0,
      grossCents: netCents,
      listLineTotal: listUnitPrice * quantity,
      manualDiscountPercent,
      promotionAmountCents: promotionNetCents,
      promotionGrossCents,
    };
  });

  // ── Whole-sale discount: allocate in cents by largest remainder ─────────────
  const netTotalCents = working.reduce((sum, line) => sum + line.netCents, 0);
  let orderDiscountCents = 0;
  if (orderType === "percent" && netTotalCents > 0) orderDiscountCents = Math.round((netTotalCents * orderValue) / 100);
  else if (orderType === "fixed") orderDiscountCents = toCents(orderValue);
  orderDiscountCents = Math.min(Math.max(orderDiscountCents, 0), netTotalCents);

  if (orderDiscountCents > 0) {
    const weights = working.map((line) => line.netCents);
    const exactShares = weights.map((weight) =>
      netTotalCents > 0 ? (orderDiscountCents * weight) / netTotalCents : 0
    );
    const shares = exactShares.map((share) => Math.floor(share));
    let allocated = shares.reduce((sum, share) => sum + share, 0);
    const order = exactShares
      .map((share, index) => ({ index, remainder: share - Math.floor(share), weight: weights[index] }))
      .sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.index - b.index);
    let cursor = 0;
    while (allocated < orderDiscountCents && order.length) {
      const target = order[cursor % order.length];
      shares[target.index] += 1;
      allocated += 1;
      cursor += 1;
      if (cursor > order.length * (orderDiscountCents + 1)) break;
    }
    working.forEach((line, index) => {
      line.netCents = Math.max(0, line.netCents - shares[index]);
    });
  }

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

export function defaultDiscountLimitPercent(): number {
  return RETAIL_DEFAULT_DISCOUNT_LIMIT_PERCENT;
}
