// Extracted from ./write.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../lib/httpHandlers";

export const VALID_LEDGER_SUBTYPES: Record<string, string[]> = {
  Expense: ["Direct Expense", "Indirect Expense"],
  Liability: [
    "Current Liability",
    "Long-term Liability",
    "Loans Payable",
    "Output Tax",
    "Tax Payable",
    "sp_otw_clearing",
    "sp_cost_clearing",
    "sp_pay_deduction_clearing",
    "sp_payable",
  ],
  Asset: [
    "Current Asset",
    "Fixed Asset",
    "Input Tax",
    "Tax Receivable",
    "sp_goods_otw",
    "sp_prepaid",
    "sp_stock",
    "sp_prepaid_expenses",
  ],
  "Direct Expense": ["sp_cogs", "sp_shared_charges"],
  Income: ["Direct Income", "Indirect Income", "sp_sales"],
  Equity: ["sp_opnbal", "gc_partner_capital", "gc_owner_capital", "gc_profit_pending_distribution"],
  Loans: ["gc_hassan_savings"],
  Intercompany: ["sp_hadi_intercompany", "hadi_sp_intercompany"],
};

export const LEDGER_ACCOUNT_DELETE_VIA_EDIT_CODE = "LEDGER_ACCOUNT_DELETE_VIA_EDIT_REFUSED" as const;

export const LEDGER_ACCOUNT_DELETE_VIA_EDIT_MESSAGE =
  "An account is deleted with the delete action, not by editing it.";

export const LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_CODE = "LEDGER_ACCOUNT_CODE_ACTIVE_CHANGE_FORBIDDEN" as const;

export const LEDGER_ACCOUNT_CODE_ACTIVE_FORBIDDEN_MESSAGE =
  "Only an Admin or Owner can change an account's code or active status.";

export const SYSTEM_ACCOUNT_CODE_RESERVED_CODE = "SYSTEM_ACCOUNT_CODE_RESERVED" as const;

export const SYSTEM_ACCOUNT_CODE_RESERVED_MESSAGE =
  "The system finds an account by this code, so an account cannot be re-coded to it or away from it.";

// System account names are editable by privileged users; their identity is the
// immutable code, so posting and historical ledger references remain stable.
export const SYSTEM_ACCOUNT_RENAME_FORBIDDEN_CODE = "SYSTEM_ACCOUNT_RENAME_FORBIDDEN" as const;

export const SYSTEM_ACCOUNT_RENAME_FORBIDDEN_MESSAGE = "Only an Admin, Owner or Developer can rename a system account.";

// Phase 19 (B), C5: the tree guard (ledgerIntegrityGuard.ts) refuses the link.
export const LEDGER_ACCOUNT_PARENT_INVALID_CODE = "LEDGER_ACCOUNT_PARENT_INVALID" as const;

export const LEDGER_ACCOUNT_PARENT_INVALID_MESSAGE =
  "The parent must be another live account of this company and of the same class, and not one of its sub-accounts.";

/** The tree guard's refusal as a 409 body, or null for any other error. */
export function ledgerParentErrorResponse(
  error: unknown
): { status: 409; body: { message: string; code: string; detail: string } } | null {
  // A database error may arrive wrapped (drizzle's query error keeps it as the cause).
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = [getErrorMessage(error), cause ? getErrorMessage(cause) : ""].find((message) =>
    message.includes(LEDGER_ACCOUNT_PARENT_INVALID_CODE)
  );
  if (!detail) return null;
  return {
    status: 409,
    body: { message: LEDGER_ACCOUNT_PARENT_INVALID_MESSAGE, code: LEDGER_ACCOUNT_PARENT_INVALID_CODE, detail },
  };
}
