// Extracted from ./FiscalCloseReview.tsx to keep that module under the source-size cap.

export type ReviewKind = "ACCOUNTING" | "OWNER";

export interface Readiness {
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

export interface EquityAccounts {
  companyId: number;
  accounts: Array<{ id: number; code: string; name: string }>;
  limit: number;
}

export interface ReviewPolicy {
  companyId: number;
  enforceReviewedClose: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
  explicitlyConfigured: boolean;
}

export interface CloseHistory {
  reviewedClosures: Array<{
    id: number;
    fiscal_closure_id: number | null;
    closing_voucher_id: number;
    evidence_hash: string;
    certified_at: string;
    reviewed_by: string;
    accounting_reviewer: string;
    owner_reviewer: string;
    currently_closed: boolean;
  }>;
}

export interface AuditHistory {
  events: Array<{
    id: number;
    action: string;
    table_name: string;
    record_identifier: string | null;
    user_id: string;
    username: string;
    recorded_at: string;
    changes: unknown;
  }>;
}

export const root = "/api/accounting/fiscal-review";

export async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Fiscal review unavailable");
  return body as T;
}

const isoNow = () => new Date().toISOString().slice(0, 10);

export const defaultStart = () => isoNow().slice(0, 4) + "-01-01";
