// Extracted from ./unifiedReleaseReadinessTx.ts

export type ReviewKind = "TECHNICAL" | "SECURITY" | "FINANCE";

export type ReleaseMode = "READ_ONLY" | "METADATA_PILOT";

export interface ReleaseActor {
  userId: string;
  username: string;
}

export interface PolicyRow extends Record<string, unknown> {
  release_mode: ReleaseMode;
  release_sha: string | null;
  approved_by: string;
  approved_at: string;
  reason: string;
}

export interface ReviewRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  release_sha: string;
  review_kind: ReviewKind;
  evidence_reference: string;
  reviewer_id: string;
  reviewer_name: string;
  reviewed_at: string;
  notes: string;
  revoked_at: string | null;
}

export const UNIFIED_PHASES = [
  [1, "Unified accounting foundation", "/accounting/dashboard"],
  [2, "Double-entry posting and voucher lifecycle", "/vouchers"],
  [3, "Party open-item reconciliation", "/accounting/open-items"],
  [4, "Bank and cash reconciliation", "/accounting/cash-bank"],
  [5, "Historical multi-currency", "/accounting/monetary-fx"],
  [6, "ERP inventory and cost of goods sold", "/accounting/erp-inventory"],
  [7, "Factory production and containers", "/accounting/factory-production"],
  [8, "Rental accounting", "/accounting/rentals"],
  [9, "Intercompany and consolidation", "/accounting/consolidation"],
  [10, "Historical accounting", "/accounting/history"],
  [11, "Professional financial statements", "/accounting/statements"],
  [12, "Cost centers (main's Cost Centers module)", "/cost-centers"],
  [13, "Fiscal closing and audit review", "/accounting/fiscal-review"],
  [14, "Unified net position dashboard", "/accounting/dashboard"],
  [15, "Integration, permissions and rollout", "/accounting/rollout"],
] as const;

export const requiredTables = [
  "accounting_open_item_matches",
  "accounting_cash_bank_statements",
  "accounting_cash_bank_matches",
  "accounting_fx_realizations",
  "accounting_rental_expense_links",
  "accounting_fiscal_review_signoffs",
  "accounting_fiscal_reviewed_closures",
  "accounting_fiscal_review_policy",
  "accounting_unified_release_reviews",
  "accounting_unified_rollout_policy",
  "cost_centers",
  "cost_center_allocations",
  "cost_center_monthly_budgets",
] as const;

export const protectedTables = [
  "accounting_open_item_matches",
  "accounting_cash_bank_statements",
  "accounting_cash_bank_matches",
  "accounting_fx_realizations",
  "accounting_rental_expense_links",
  "accounting_fiscal_review_signoffs",
  "accounting_fiscal_reviewed_closures",
  "accounting_fiscal_review_policy",
  "accounting_unified_release_reviews",
  "accounting_unified_rollout_policy",
  "cost_centers",
  "cost_center_allocations",
  "cost_center_monthly_budgets",
] as const;

export const HEX40 = /^[a-f0-9]{40,64}$/;

export interface DbTable extends Record<string, unknown> {
  name: string;
  exists: boolean;
  rls: boolean;
  forced: boolean;
  // Existence of a real RLS policy is necessary but not sufficient proof of
  // company isolation. External penetration tests still own certification.
  hasPolicy: boolean;
}

/**
 * Open-item, cash/bank and cost-allocation rows reference voucher_entries(id)
 * ON DELETE RESTRICT, while existing voucher edit flows (sales update, journal
 * and payment edits, container voucher sync, POS edits) delete and re-insert a
 * voucher's lines. Once a metadata row exists, those established workflows
 * would fail. Keep the pilot blocked until they are made compatible without
 * changing any posted amount.
 */
export const METADATA_ENTRY_REFERENCES_COMPATIBLE = false;

export const METADATA_ENTRY_REFERENCES_BLOCKER =
  "Metadata matches/allocations reference voucher lines ON DELETE RESTRICT, but existing voucher edit flows replace voucher lines; certify compatibility before any metadata pilot";
