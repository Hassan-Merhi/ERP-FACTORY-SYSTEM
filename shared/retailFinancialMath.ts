import Decimal from "decimal.js";
import type { RetailPaymentMethod } from "@shared/schema";

export type RetailDecimalInput = Decimal.Value | null | undefined;

export function retailDecimal(value: RetailDecimalInput, field = "amount"): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value == null || value === "" ? 0 : value);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if (!parsed.isFinite()) throw new Error(`Invalid ${field}`);
  return parsed;
}

/** Retail and the shared voucher engine use currency cents; quantities remain six-decimal snapshots. */
export function retailMoney(value: RetailDecimalInput, field = "amount"): string {
  return retailDecimal(value, field).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function sumRetailMoney(values: RetailDecimalInput[]): string {
  return values
    .reduce<Decimal>((sum, value) => sum.plus(retailDecimal(value)), new Decimal(0))
    .toDecimalPlaces(2)
    .toFixed(2);
}

function allocateAmount(amount: Decimal, weights: Decimal[]): Decimal[] {
  if (!weights.length) return [];
  if (amount.isZero()) return weights.map(() => new Decimal(0));
  const weightTotal = weights.reduce((sum, weight) => sum.plus(weight), new Decimal(0));
  if (weightTotal.lte(0)) throw new Error("Cannot allocate money without a positive amount basis");

  let allocated = new Decimal(0);
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return amount.minus(allocated).toDecimalPlaces(2);
    // Round down every proportional slice; the final line receives the exact
    // residual so allocations can never exceed the amount being distributed.
    const share = amount.mul(weight).div(weightTotal).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    allocated = allocated.plus(share);
    return share;
  });
}

export interface RetailSaleAmountLineInput {
  variantId: number;
  quantity: RetailDecimalInput;
  unitPrice: RetailDecimalInput;
  unitCost: RetailDecimalInput;
}

export interface RetailSaleAmountLine extends RetailSaleAmountLineInput {
  grossAmount: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
}

export interface RetailSaleAmounts {
  subtotalAmount: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  lines: RetailSaleAmountLine[];
}

/**
 * Finalizes the shared checkout amount snapshot. Discounts and tax are allocated
 * once across sale lines and all later returns use those exact snapshots.
 */
export function calculateRetailSaleAmounts(
  inputLines: RetailSaleAmountLineInput[],
  discountInput: RetailDecimalInput = 0,
  taxInput: RetailDecimalInput = 0
): RetailSaleAmounts {
  if (!inputLines.length) throw new Error("A Retail sale needs at least one item");
  const prepared = inputLines.map((line) => {
    const quantity = retailDecimal(line.quantity, "quantity");
    const unitPrice = retailDecimal(line.unitPrice, "unit price");
    const unitCost = retailDecimal(line.unitCost, "unit cost");
    if (quantity.lte(0) || unitPrice.lt(0) || unitCost.lt(0)) throw new Error("Retail sale line is invalid");
    return {
      ...line,
      quantity,
      unitPrice,
      unitCost,
      gross: unitPrice.mul(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    };
  });
  const subtotal = prepared.reduce((sum, line) => sum.plus(line.gross), new Decimal(0)).toDecimalPlaces(2);
  if (subtotal.lte(0)) throw new Error("Retail sale subtotal must be greater than zero");

  const discount = retailDecimal(discountInput, "discount amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const tax = retailDecimal(taxInput, "tax amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (discount.lt(0) || discount.gt(subtotal)) throw new Error("Discount must be between zero and the Retail subtotal");
  if (tax.lt(0)) throw new Error("Tax cannot be negative");

  const discounts = allocateAmount(
    discount,
    prepared.map((line) => line.gross)
  );
  const taxableBases = prepared.map((line, index) => line.gross.minus(discounts[index]));
  const taxes = allocateAmount(tax, taxableBases);
  const lines = prepared.map((line, index) => {
    const lineDiscount = discounts[index];
    const lineTax = taxes[index];
    return {
      variantId: line.variantId,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      unitCost: line.unitCost.toString(),
      grossAmount: line.gross.toFixed(2),
      discountAmount: lineDiscount.toFixed(2),
      taxAmount: lineTax.toFixed(2),
      totalAmount: line.gross.minus(lineDiscount).plus(lineTax).toFixed(2),
    };
  });
  const total = subtotal.minus(discount).plus(tax).toDecimalPlaces(2);
  if (total.lte(0)) throw new Error("Retail checkout total must be greater than zero");

  return {
    subtotalAmount: subtotal.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxAmount: tax.toFixed(2),
    totalAmount: total.toFixed(2),
    lines,
  };
}

function proportionalSnapshot(snapshot: RetailDecimalInput, sold: Decimal, returned: Decimal): Decimal {
  const total = retailDecimal(snapshot).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (returned.lte(0)) return new Decimal(0);
  if (returned.gte(sold)) return total;
  return total.mul(returned).div(sold).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export interface RetailReturnAmounts {
  grossAmount: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  cogsAmount: string;
}

/** Calculate a partial return as the difference between cumulative snapshots. */
export function calculateRetailReturnAmounts(input: {
  soldQuantity: RetailDecimalInput;
  returnedBefore: RetailDecimalInput;
  returnQuantity: RetailDecimalInput;
  grossAmount: RetailDecimalInput;
  discountAmount: RetailDecimalInput;
  taxAmount: RetailDecimalInput;
  unitCost: RetailDecimalInput;
}): RetailReturnAmounts {
  const sold = retailDecimal(input.soldQuantity, "sold quantity");
  const previous = retailDecimal(input.returnedBefore, "previously returned quantity");
  const quantity = retailDecimal(input.returnQuantity, "return quantity");
  if (sold.lte(0) || previous.lt(0) || quantity.lte(0) || previous.plus(quantity).gt(sold)) {
    throw new Error("Return quantity exceeds the remaining sold quantity");
  }
  const next = previous.plus(quantity);
  const amountDelta = (snapshot: RetailDecimalInput) =>
    proportionalSnapshot(snapshot, sold, next)
      .minus(proportionalSnapshot(snapshot, sold, previous))
      .toDecimalPlaces(2);
  const gross = amountDelta(input.grossAmount);
  const discount = amountDelta(input.discountAmount);
  const tax = amountDelta(input.taxAmount);
  const lineCost = retailDecimal(input.unitCost, "unit cost").mul(sold).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const cogs = proportionalSnapshot(lineCost, sold, next)
    .minus(proportionalSnapshot(lineCost, sold, previous))
    .toDecimalPlaces(2);
  return {
    grossAmount: gross.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxAmount: tax.toFixed(2),
    totalAmount: gross.minus(discount).plus(tax).toFixed(2),
    cogsAmount: cogs.toFixed(2),
  };
}

export interface RetailTenderInput {
  method: RetailPaymentMethod;
  amount: RetailDecimalInput;
  amountTendered?: RetailDecimalInput;
  reference?: string | null;
}

export interface RetailTenderSnapshot {
  method: RetailPaymentMethod;
  amount: string;
  amountTendered: string | null;
  changeDue: string;
  reference: string | null;
}

/** Validate and finalize payment lines so tender always reconciles to checkout total exactly. */
export function finalizeRetailTender(
  totalInput: RetailDecimalInput,
  lines: RetailTenderInput[]
): RetailTenderSnapshot[] {
  const total = retailDecimal(totalInput, "Retail total").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!lines.length) throw new Error("At least one payment method is required");
  const normalized = lines.map((line) => {
    const amount = retailDecimal(line.amount, "payment amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (amount.lte(0)) throw new Error("Payment amounts must be greater than zero");
    const tendered =
      line.method === "cash"
        ? retailDecimal(line.amountTendered ?? amount, "cash amount tendered").toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : null;
    if (tendered && tendered.lt(amount)) throw new Error("Cash tendered must cover the cash payment amount");
    return {
      method: line.method,
      amount: amount.toFixed(2),
      amountTendered: tendered?.toFixed(2) ?? null,
      changeDue: tendered ? tendered.minus(amount).toFixed(2) : "0.00",
      reference: line.reference?.trim() || null,
    };
  });
  const paid = normalized.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)).toDecimalPlaces(2);
  if (!paid.equals(total)) throw new Error(`Payments must equal the sale total (${total.toFixed(2)})`);
  return normalized;
}

export interface RefundRail {
  method: RetailPaymentMethod;
  availableAmount: RetailDecimalInput;
  reference?: string | null;
}

/** Allocate refund cents over remaining original tender, preserving exact totals. */
export function allocateRetailRefund(
  refundInput: RetailDecimalInput,
  availableRails: RefundRail[],
  explicitMethod?: RetailPaymentMethod
): Array<{ method: RetailPaymentMethod; amount: string; reference: string | null }> {
  const refund = retailDecimal(refundInput, "refund amount").toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (refund.lt(0)) throw new Error("Refund amount cannot be negative");
  if (refund.isZero()) return [];
  if (explicitMethod) return [{ method: explicitMethod, amount: refund.negated().toFixed(2), reference: null }];

  const rails = availableRails
    .map((rail) => ({
      method: rail.method,
      reference: rail.reference?.trim() || null,
      available: retailDecimal(rail.availableAmount, "available refund amount").toDecimalPlaces(2),
    }))
    .filter((rail) => rail.available.gt(0));
  const available = rails.reduce((sum, rail) => sum.plus(rail.available), new Decimal(0));
  if (available.lt(refund)) throw new Error("Refund exceeds the remaining amount paid on this sale");
  if (!rails.length) throw new Error("No original payment is available for this refund");
  const allocated = allocateAmount(
    refund,
    rails.map((rail) => rail.available)
  );
  return rails
    .map((rail, index) => ({
      method: rail.method,
      amount: allocated[index].negated().toFixed(2),
      reference: rail.reference,
    }))
    .filter((line) => !new Decimal(line.amount).isZero());
}
