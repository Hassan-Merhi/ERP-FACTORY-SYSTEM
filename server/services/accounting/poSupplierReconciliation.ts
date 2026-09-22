import Decimal from "decimal.js";

export type PoSupplierReconciliationStatus = "matched" | "missing" | "amount_mismatch" | "duplicate";

export interface PoSupplierExpectationInput {
  itemsTotal?: string | number | null;
  freight?: string | number | null;
  surcharge?: string | number | null;
  fumigation?: string | number | null;
  documentCharges?: string | number | null;
  discount?: string | number | null;
  otherCharges?: string | number | null;
  freightPaidBy?: string | null;
}

const money = (value: string | number | null | undefined) => new Decimal(String(value ?? "0"));

/** Supplier share of an imported PO. Parent-paid freight belongs to its own
 * creditor; all other imported charges remain part of the supplier payable. */
export function expectedPoSupplierPayable(input: PoSupplierExpectationInput): Decimal {
  const freight = money(input.freight);
  const gross = money(input.itemsTotal)
    .plus(freight)
    .plus(money(input.surcharge))
    .plus(money(input.fumigation))
    .plus(money(input.documentCharges))
    .minus(money(input.discount))
    .plus(money(input.otherCharges));

  return input.freightPaidBy === "parent" && freight.gt(0) ? gross.minus(freight) : gross;
}

export function classifyPoSupplierPosting(expected: Decimal, actualCredits: Array<string | number>) {
  const actual = actualCredits.reduce((sum, value) => sum.plus(money(value)), new Decimal(0));
  let status: PoSupplierReconciliationStatus;
  if (actualCredits.length === 0) status = "missing";
  else if (actualCredits.length > 1) status = "duplicate";
  else if (!actual.eq(expected)) status = "amount_mismatch";
  else status = "matched";

  return {
    status,
    expected: expected.toFixed(2),
    actual: actual.toFixed(2),
    difference: actual.minus(expected).toFixed(2),
  };
}

export function parentImportVoucherNumberPattern(childCompanyId: number, poNumber: string): string {
  return `IC-${childCompanyId}-${poNumber}-%`;
}
