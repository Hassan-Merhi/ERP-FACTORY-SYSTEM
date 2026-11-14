/**
 * Phase 13 fiscal period close readiness, immutable-source checks and review.
 *
 * Technical close remains the existing fiscal-periods writer. This service
 * creates no financial transactions, opens no periods, and never uses a
 * fiscal-lock bypass. A reviewed close verifies evidence under the writer's
 * exclusive per-company advisory lock to avoid time-of-check/time-of-use races.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { OPENING_BALANCE_LOCK_TABLES, openingBalanceLockTriggerName } from "./openingBalanceLock";

export type ReviewKind = "ACCOUNTING" | "OWNER";
export interface Reviewer {
  userId: string;
  username: string;
}
export class FiscalReviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "FiscalReviewError";
  }
}
export type Row = Record<string, unknown>;
export type EvidenceRow = Row & {
  posted_vouchers: string;
  posted_lines: string;
  lines_digest: string;
  missing_ledger_targets: string;
  unbalanced_balanced_type: string;
  non_usd_untranslated: string;
  pnl_base_mismatch: string;
  optional_vouchers: string;
  latest_entry_id: string | null;
  postings_without_actor: string;
};
export type ClosureRow = Row & {
  id: number;
  period_start_date: string;
  period_end_date: string;
  closing_voucher_id: number;
  status: string;
  net_income: string;
};
export type Signoff = Row & {
  id: number;
  company_id: number;
  period_start_date: string;
  period_end_date: string;
  retained_earnings_account_id: number;
  evidence_hash: string;
  review_kind: ReviewKind;
  reviewer_id: string;
  reviewer_name: string;
  reviewed_at: string;
  note: string;
  revoked_at: string | null;
};
export interface FiscalReadiness {
  companyId: number;
  periodStartDate: string;
  periodEndDate: string;
  retainedEarningsAccountId: number;
  businessDate: string;
  evidenceHash: string;
  reviewedCloseReady: boolean;
  eligibleForSignoff: boolean;
  trialBalance: {
    balanced: boolean;
    differenceUsd: string;
    openingDifferenceUsd: string;
    singleSidedStockDifferenceUsd: string;
    otherDifferenceUsd: string;
    assumedOpeningSides: number;
  };
  source: {
    postedVouchers: number;
    postedVoucherLines: number;
    sourceDigest: string;
    balancedVoucherErrors: number;
    missingLedgerTargets: number;
    nonUsdUntranslatedLines: number;
    pnlBaseAmountMismatchLines: number;
    optionalVouchers: number;
    postingsWithoutActor: number;
  };
  history: {
    latestClosedEnd: string | null;
    expectedNextStart: string | null;
    closedPeriods: Array<{ id: number; from: string; to: string; voucherId: number; netIncomeUsd: string }>;
    historicalScope: "live_source_as_of";
  };
  protections: {
    voucherDateGuardInstalled: boolean;
    entryDateGuardInstalled: boolean;
    auditChainInstalled: boolean;
    openingBalanceGuardInstalled: boolean;
    reviewMetadataCompanyRlsInstalled: boolean;
  };
  signoffs: Array<{
    id: number;
    kind: ReviewKind;
    reviewerId: string;
    reviewerName: string;
    reviewedAt: string;
    note: string;
    current: boolean;
  }>;
  blockers: string[];
  warnings: string[];
  certified: false;
}
export function day(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new FiscalReviewError("FISCAL_DATE_INVALID", "Invalid ISO fiscal period date", 400);
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new FiscalReviewError("FISCAL_DATE_INVALID", "Invalid calendar date", 400);
  return value;
}
export function num(v: unknown) {
  return Number(String(v ?? "0"));
}
export function positive(v: number, name: string) {
  if (!Number.isSafeInteger(v) || v < 1)
    throw new FiscalReviewError("FISCAL_ID_INVALID", name + " must be a positive integer", 400);
  return v;
}
export function hashes(evidence: unknown) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
export async function signoffRowsTx(tx: DbTransaction, companyId: number, start: string, end: string, accountId: number) {
  return resultRows<Signoff>(
    await tx.execute(sql`
 SELECT id,company_id,period_start_date::text,period_end_date::text,
 retained_earnings_account_id,evidence_hash,review_kind,reviewer_id,reviewer_name,
 reviewed_at::text,note,revoked_at::text
 FROM accounting_fiscal_review_signoffs
 WHERE company_id=${companyId} AND period_start_date=${start}::date
   AND period_end_date=${end}::date AND retained_earnings_account_id=${accountId}
 ORDER BY reviewed_at DESC,id DESC LIMIT 100
 `)
  );
}
type RequiredTrigger = { table_name: string; trigger_name: string };
export const CLOSED_VOUCHER_GUARD: RequiredTrigger[] = [
  { table_name: "vouchers", trigger_name: "vouchers_closed_period_guard" },
];
export const CLOSED_ENTRY_GUARD: RequiredTrigger[] = [
  { table_name: "voucher_entries", trigger_name: "voucher_entries_closed_period_guard" },
];
export const AUDIT_CHAIN_TRIGGERS: RequiredTrigger[] = [
  ["vouchers", "vouchers_audit_actor_columns"],
  ["vouchers", "vouchers_audit_row_insert"],
  ["vouchers", "vouchers_audit_row_update"],
  ["vouchers", "vouchers_audit_row_delete"],
  ["voucher_entries", "voucher_entries_audit_row_insert"],
  ["voucher_entries", "voucher_entries_audit_row_update"],
  ["voucher_entries", "voucher_entries_audit_row_delete"],
  ["audit_log", "audit_log_before_insert_chain"],
  ["audit_log", "audit_log_append_only"],
  ["audit_log", "audit_log_no_truncate"],
].map(([table_name, trigger_name]) => ({ table_name, trigger_name }));
export const OPENING_BALANCE_TRIGGERS: RequiredTrigger[] = OPENING_BALANCE_LOCK_TABLES.map((table) => ({
  table_name: table,
  trigger_name: openingBalanceLockTriggerName(table),
}));
/**
 * True when every named trigger is enabled on its own table in the current
 * schema; a same-named trigger on another table does not count. The names
 * are bound as one JSON parameter: this reads pg_catalog only, never rows.
 */
export function triggersEnabledSql(required: RequiredTrigger[]) {
  return sql`NOT EXISTS(
   SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(required)}::jsonb) AS required(table_name text, trigger_name text)
   WHERE NOT EXISTS(
     SELECT 1 FROM pg_trigger t
     JOIN pg_class target ON target.oid=t.tgrelid
     JOIN pg_namespace ns ON ns.oid=target.relnamespace
     WHERE ns.nspname=current_schema()
       AND target.relname=required.table_name
       AND t.tgname=required.trigger_name
       AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
   )
 )`;
}
