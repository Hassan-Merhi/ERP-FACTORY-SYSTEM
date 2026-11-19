// Extracted from ./retailCashJournal.ts
import type Decimal from "decimal.js";
import type { DbTransaction } from "../../db";
import { ensureRetailAccountingSettingsTx } from "./retailFinancialService";
import { retailSystemAccountIdTx } from "./retailLedgerPosting";

export type RetailCashDirection = "cash_in" | "cash_out";

/** Built-in reasons: direction allowed, and the default counter-account. */
export const RETAIL_CASH_REASONS = {
  bank_withdrawal: { direction: "cash_in", label: "Cash in from the bank", defaultTarget: "bank" },
  owner_funding: { direction: "cash_in", label: "Cash in from the owner", defaultTarget: "RETAIL-OWNER-FUNDS" },
  expense: { direction: "cash_out", label: "Expense paid from the drawer", defaultTarget: "RETAIL-CASH-EXPENSE" },
  cash_drop: { direction: "cash_out", label: "Cash drop to the safe or bank", defaultTarget: "bank" },
  owner_drawing: { direction: "cash_out", label: "Cash taken by the owner", defaultTarget: "RETAIL-OWNER-FUNDS" },
  other: { direction: "either", label: "Other (map an account first)", defaultTarget: null },
} as const satisfies Record<
  string,
  { direction: RetailCashDirection | "either"; label: string; defaultTarget: string | null }
>;

export type RetailBuiltInCashReason = keyof typeof RETAIL_CASH_REASONS;

export const RETAIL_CASH_REASON_CODE = /^[a-z0-9_]{2,40}$/;

export const RETAIL_OVER_SHORT_ACCOUNT = "RETAIL-CASH-OVER-SHORT";

export const RETAIL_CASH_REASON_UNMAPPED = "RETAIL_CASH_REASON_UNMAPPED" as const;

export const RETAIL_CASH_REASON_UNMAPPED_MESSAGE =
  "This cash movement reason has no account mapped. Map the reason to an account in the Retail accounting settings first.";

export const RETAIL_CASH_REASON_DIRECTION_MESSAGE = "This reason cannot be used for this cash movement direction.";

export const RETAIL_CASH_AMOUNT_CENTS_MESSAGE = "A cash movement amount can have at most two decimals.";

export interface RetailCashReasonTarget {
  reasonCode: string;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  /** "mapping": a stored row; "default": the built-in default; "none": unmapped. */
  source: "mapping" | "default" | "none";
  direction: RetailCashDirection | "either";
  label: string | null;
}

export function builtIn(reasonCode: string) {
  return Object.prototype.hasOwnProperty.call(RETAIL_CASH_REASONS, reasonCode)
    ? RETAIL_CASH_REASONS[reasonCode as RetailBuiltInCashReason]
    : null;
}

export async function defaultTargetTx(
  tx: DbTransaction,
  companyId: number,
  target: string | null
): Promise<{ ledgerAccountId: number | null; bankAccountId: number | null }> {
  if (!target) return { ledgerAccountId: null, bankAccountId: null };
  if (target === "bank") {
    const settings = await ensureRetailAccountingSettingsTx(tx, companyId, null);
    return settings.bankAccountId
      ? { ledgerAccountId: null, bankAccountId: settings.bankAccountId }
      : { ledgerAccountId: settings.bankLedgerAccountId, bankAccountId: null };
  }
  return { ledgerAccountId: await retailSystemAccountIdTx(tx, companyId, target), bankAccountId: null };
}

export interface RetailCashReasonPatch {
  reasonCode: string;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
}

/** True when a cash amount has at most two decimals. */
export function isCashAmountInCents(amount: Decimal): boolean {
  return amount.eq(amount.toDecimalPlaces(2));
}

/** The shift's cash account: the one it was opened with, else the Retail cash account of its register. */
export async function shiftCashAccountTx(
  tx: DbTransaction,
  companyId: number,
  shift: { locationId: number; cashAccountId: number | null }
): Promise<number> {
  if (shift.cashAccountId) return shift.cashAccountId;
  return (await ensureRetailAccountingSettingsTx(tx, companyId, shift.locationId)).cashLedgerAccountId;
}
