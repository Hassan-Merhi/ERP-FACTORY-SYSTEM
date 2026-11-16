import Decimal from "decimal.js";

/**
 * Money in ERP supplier returns is USD, posted at two decimal places.
 * Authoritative inventory relief comes from the inventory helper's returned valueDelta,
 * never qty * a rounded display rate or historical container landed cost.
 */
export interface SupplierReturnFinancialInput {
  quantity: Decimal.Value;
  purchaseRate: Decimal.Value;
  inventoryValueDelta: Decimal.Value;
  previousQuantity: Decimal.Value;
  newQuantity: Decimal.Value;
  previousTotalValue: Decimal.Value;
  newTotalValue: Decimal.Value;
}

export interface SupplierReturnFinancials {
  supplierDebit: string;
  inventoryCredit: string;
  varianceDebit: string;
  varianceCredit: string;
  /** Positive means inventory relief exceeds the supplier credit. */
  signedVariance: string;
  effectiveInventoryCostPerBale: string;
}

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const money = (value: Decimal.Value) => new D(value).toDecimalPlaces(2).toFixed(2);
function finite(value: Decimal.Value, name: string): InstanceType<typeof D> {
  const parsed = new D(value);
  if (!parsed.isFinite()) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function calculateSupplierReturnFinancials(input: SupplierReturnFinancialInput): SupplierReturnFinancials {
  const quantity = finite(input.quantity, "return quantity");
  const purchaseRate = finite(input.purchaseRate, "purchase rate");
  const oldQty = finite(input.previousQuantity, "previous quantity");
  const newQty = finite(input.newQuantity, "new quantity");
  const oldValue = finite(input.previousTotalValue, "previous inventory value");
  const newValue = finite(input.newTotalValue, "new inventory value");
  const delta = finite(input.inventoryValueDelta, "inventory value delta");

  if (!quantity.gt(0) || !purchaseRate.gte(0)) throw new Error("Invalid return quantity or purchase cost");
  // Negative inventory is supported by adjustInventory's provisional cost layers.
  // Require the exact quantity reduction even when the result crosses below zero.
  if (!oldQty.minus(newQty).eq(quantity))
    throw new Error("Supplier return inventory quantity did not decrease by the allocated amount");
  // Stored values are two-decimal ledger values. Never tolerate unexplained rounding
  // gaps between the inventory subledger and the voucher's inventory credit.
  if (!new D(money(oldValue.minus(newValue))).eq(new D(money(delta.negated()))))
    throw new Error("Supplier return inventory value does not reconcile to its stored delta");
  const inventoryCredit = finite(money(delta.negated()), "inventory relief");
  if (inventoryCredit.lt(0)) throw new Error("Supplier return cannot increase inventory value");
  const supplierDebit = finite(money(quantity.times(purchaseRate)), "supplier credit");
  const variance = inventoryCredit.minus(supplierDebit);
  const varianceDebit = variance.gt(0) ? variance : new D(0);
  const varianceCredit = variance.lt(0) ? variance.abs() : new D(0);
  // DR supplier + DR variance == CR inventory + CR variance
  if (!supplierDebit.plus(varianceDebit).eq(inventoryCredit.plus(varianceCredit)))
    throw new Error("Supplier return voucher is unbalanced");
  return {
    supplierDebit: supplierDebit.toFixed(2),
    inventoryCredit: inventoryCredit.toFixed(2),
    signedVariance: variance.toFixed(2),
    varianceDebit: varianceDebit.toFixed(2),
    varianceCredit: varianceCredit.toFixed(2),
    effectiveInventoryCostPerBale: inventoryCredit.div(quantity).toFixed(7),
  };
}

export function reconcileSupplierReturnBatch(
  lines: ReadonlyArray<{ quantity: Decimal.Value; financials: SupplierReturnFinancials }>
) {
  const quantity = lines.reduce((sum, line) => sum.plus(line.quantity), new D(0));
  const supplierDebit = lines.reduce((sum, line) => sum.plus(line.financials.supplierDebit), new D(0));
  const inventoryCredit = lines.reduce((sum, line) => sum.plus(line.financials.inventoryCredit), new D(0));
  const varianceDebit = lines.reduce((sum, line) => sum.plus(line.financials.varianceDebit), new D(0));
  const varianceCredit = lines.reduce((sum, line) => sum.plus(line.financials.varianceCredit), new D(0));
  if (!supplierDebit.plus(varianceDebit).eq(inventoryCredit.plus(varianceCredit)))
    throw new Error("Supplier return batch does not balance");
  return {
    totalQuantity: quantity.toFixed(3),
    supplierDebit: supplierDebit.toFixed(2),
    inventoryCredit: inventoryCredit.toFixed(2),
    varianceDebit: varianceDebit.toFixed(2),
    varianceCredit: varianceCredit.toFixed(2),
  };
}
