// Extracted from ./insuranceHistoricalRepairRoutes.ts

export type InsuranceRepairSkipReason =
  | "INSURANCE_LEDGER_PATTERN_NOT_PROVEN"
  | "UNEXPECTED_EXTRA_LEDGER_ENTRY"
  | "MIXED_OR_AMBIGUOUS_ENTRY_DIRECTION"
  | "UNBALANCED_REVERSED_JOURNAL"
  | "PERIOD_CLOSED";

export interface InsuranceRepairLine {
  entryId: number;
  ledgerAccountId: number | null;
  ledgerName: string | null;
  debit: string;
  credit: string;
  newDebit: string;
  newCredit: string;
}

export interface InsuranceRepairVoucher {
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  effectiveDate: string | null;
  total: string;
  lines: InsuranceRepairLine[];
}

export interface InsuranceRepairPlan {
  companyId: number;
  candidates: InsuranceRepairVoucher[];
  skipped: { voucherId: number; voucherNumber: string; reason: InsuranceRepairSkipReason }[];
  planHash: string;
}

export type EntryRow = {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
  period_closed: boolean;
  ledger_account_id: number | null;
  ledger_name: string | null;
  account_type: string | null;
  debit: string;
  credit: string;
  member_linked: boolean;
};
