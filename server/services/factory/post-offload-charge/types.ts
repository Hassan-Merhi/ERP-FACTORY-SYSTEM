import type { CascadeResult } from "../rawStockCostCascade";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AccountingContext {
  /** The company that owns the voucher (may differ from factory company). */
  voucherCompanyId: number;
  /** ID of the "Factory Charges Payable" ledger account — 0 if no accounting. */
  chargesPayableAcctId: number;
}

export interface PostOffloadChargeData {
  description: string;
  amount: number;
  currencyCode: string;
  fxRateToUsd: number;
  fxRateConfirmed: boolean;
  fxRateDate: string;
  ledgerAccountId: number | null;
  supplierId: number | null;
}

export interface PostOffloadMutationParams {
  action: "CREATE" | "EDIT" | "UNDO" | "LEGACY_REBUILD";
  companyId: number;
  containerId: number;
  txDate: string;
  userId?: string;
  // Required for EDIT / UNDO / LEGACY_REBUILD:
  chargeId?: number;
  expectedVersion?: number;
  // Required for CREATE / EDIT:
  chargeData?: PostOffloadChargeData;
  // Required for LEGACY_REBUILD / UNDO when supplierLockedRateBefore IS NULL:
  legacyBaselineRate?: number;
  // Pre-computed accounting context (must be set for CREATE / EDIT with accounting):
  accountingCtx?: AccountingContext;
}

export interface PostOffloadMutationResult {
  chargeId: number;
  action: string;
  alreadyUndone?: boolean;
  oldContainerCostPerKgUsd: number;
  newContainerCostPerKgUsd: number;
  supplierLockedRateBefore: string | null;
  supplierLockedRateAfter: string | null;
  supplierRemainingKg: number;
  containerReceivedKg: number;
  containerRemainingKg: number;
  remainingFraction: string;
  fullContainerValueDeltaUsd: string;
  supplierInventoryValueDeltaUsd: string;
  supplierValueBeforeUsd: string | null;
  supplierValueAfterUsd: string | null;
  cascadeResult: CascadeResult | null;
  reversalDaybookEntryId?: number | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Load commission + other-charge rows for canonical cost computation. */
