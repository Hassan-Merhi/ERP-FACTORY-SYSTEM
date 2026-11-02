/**
 * One-time historical freight corrections ran on 2026-10-14. Some journals
 * were later retired. Re-running the legacy batch would silently recreate
 * deliberately retired offsets or rewrite creditor/supplier positions.
 * Keep the original source and transaction history for audit. Any further
 * change must use a new, separately reviewed source-specific correction.
 */
export function assertHistoricalFreightBatchNotReapplied(apply: boolean): void {
  if (apply) {
    throw new Error(
      "HISTORICAL_FREIGHT_BATCH_REPLAY_DISABLED: The 2026-10-14 one-time " +
      "corrections were posted; correction FACTORY-CORRECTION-20261014-83 " +
      "was subsequently retired. Do not run --apply or revive a deleted " +
      "journal. Reconcile creditor WALMDACLE and create a new reviewed " +
      "source-specific adjustment only after approval."
    );
  }
}

export interface PostOffloadDuplicateSourceReview {
  companyId: number;
  containerId: number;
  chargeId: number;
  activeVoucherCount: number;
  activeVouchers: Array<{
    voucherId: number;
    voucherNumber: string;
    voucherDate: string;
    amountNative: string;
  }>;
  priorCorrection: {
    voucherId: number;
    voucherNumber: string;
    deletedAt: string | null;
    amountNative: string;
  } | null;
}

export function assessPostOffloadDuplicateSource(row: PostOffloadDuplicateSourceReview) {
  const issues: string[] = [];
  if (row.activeVoucherCount > 1) issues.push("MULTIPLE_ACTIVE_POC_VOUCHERS_FOR_ONE_CHARGE");
  if (row.priorCorrection?.deletedAt != null) issues.push("HISTORICAL_CORRECTION_WAS_RETIRED");
  if (row.activeVouchers.length !== row.activeVoucherCount) issues.push("VOUCHER_ROW_COUNT_MISMATCH");
  if (new Set(row.activeVouchers.map(v => v.voucherDate)).size > 1) {
    issues.push("SOURCE_DOCUMENT_PERIODS_DIFFER");
  }
  if (row.activeVoucherCount > 1) issues.push("CREDITOR_AND_EXPENSE_OR_CLEARING_ENTRIES_REQUIRE_REVIEW");
  return {
    ...row,
    reviewFlags: issues,
    needsFinancialReview: issues.length > 0,
    verifiedDuplicateSourceIdentity: row.activeVoucherCount > 1,
    candidateCorrectionUsd: null,
    proposedJournal: null,
    approvedForPosting: false,
    safeToReplayLegacyBatch: false,
    changesToSupplierAccounts: null,
  };
}
