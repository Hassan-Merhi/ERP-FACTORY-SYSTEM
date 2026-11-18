/** POS sale-edit eligibility. All dates are YYYY-MM-DD company-local business days. */
export type PosDaybookEditDecision = {
  allowed: boolean;
  reason: "enabled" | "disabled" | "view-only" | "outside-window" | "invalid-date" | "future-date";
};

function utcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

export function posDaybookEditEligibility(input: {
  originalDate: string;
  businessDate: string;
  editDays: number;
  viewOnly?: boolean;
}): PosDaybookEditDecision {
  if (input.viewOnly) return { allowed: false, reason: "view-only" };
  if (!Number.isInteger(input.editDays) || input.editDays <= 0) {
    return { allowed: false, reason: "disabled" };
  }
  const original = utcDay(input.originalDate);
  const today = utcDay(input.businessDate);
  if (original === null || today === null) return { allowed: false, reason: "invalid-date" };
  const elapsed = Math.round((today - original) / 86_400_000);
  if (elapsed < 0) return { allowed: false, reason: "future-date" };
  if (elapsed > input.editDays) return { allowed: false, reason: "outside-window" };
  return { allowed: true, reason: "enabled" };
}

export const posDaybookEditMessages = {
  disabled: "Daybook sale editing is disabled for this POS account.",
  date: "This sale is outside your configured Daybook editing window.",
  noRedate: "POS cashiers cannot change the original sale date. Reverse and rebook instead.",
  noPaymentChange: "POS cashiers cannot change an existing sale's payment account or credit status.",
  viewOnly: "This POS account is view-only and cannot edit sales.",
  missingItems: "At least one sale item is required.",
  invalidRate: "This sale has no valid historical Kwacha exchange rate.",
  invalidLine: "Quantity and selling price must both be positive.",
  invalidKwachaPrecision: "Kwacha prices cannot have more than two decimals.",
  accessCheckFailed: "Unable to check Daybook edit permissions",
  chooseStockItem: "Choose a stock item...",
  cancelEditing: "Cancel editing",
  savedReceipt: (voucherNumber: string | number) => `Receipt ${voucherNumber} was saved.`,
  updateFailed: "Unable to update sale",
  invalidSaleId: "Invalid sale ID",
  optionalSale: "Optional sales cannot be edited from Daybook.",
  locationNotAssigned: "Sale location is not assigned to this cashier.",
  locationLocked: "POS cashiers cannot change the sale location.",
} as const;
