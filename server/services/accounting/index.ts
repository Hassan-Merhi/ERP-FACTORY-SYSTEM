/*
 * Central Accounting Service
 *
 * Re-exports the low-level compatibility helpers and the strict Program 2
 * posting, lifecycle, reconciliation, period-lock, and controlled repair
 * boundaries. New or migrated posting flows should use postBalancedVoucherTx
 * inside the transaction that owns the source document and mandatory inventory
 * or secondary-ledger effects. Closed periods are enforced by the database
 * closed-period guard (closedPeriodGuard.ts: BEFORE triggers on vouchers, lines
 * and, since phase 23 DI3, the sub-ledgers) against the one close model,
 * fiscal_period_closures (storage/accounting/fiscal-periods.ts). Phase 23 G13
 * removed the unused second model (periodLockService / financialCloseService).
 */

export type { VoucherInsertFields, VoucherEntryInsertFields, VoucherWithEntries } from "./accountingTypes";

export { insertVoucherWithEntriesTx, insertVoucherWithEntries } from "./voucherPostingService";

export {
  postBalancedVoucherTx,
  validateCentralPostingRequest,
  populatedPostingTargets,
  hasSupportedPostingTargetShape,
  PostingValidationError,
} from "./centralPostingEngine";
export type {
  CentralPostingDependencies,
  CentralPostingRequest,
  CentralPostingResult,
  PostingActor,
  PostingAuditWriter,
  PostingIdempotencyStore,
  PostingOwnershipValidator,
  PostingSourceIdentity,
  ValidatedPostingTotals,
} from "./centralPostingEngine";

export { createDatabasePostingDependencies, collectPostingTargetIds } from "./databasePostingDependencies";
export type { PostingTargetIds } from "./databasePostingDependencies";

export { buildManualJournalPostingRequest, resolveManualJournalClientRequestId } from "./manualJournalPosting";
export type {
  BuildManualJournalPostingInput,
  BuiltManualJournalPosting,
  ManualJournalEntryInput,
} from "./manualJournalPosting";

export { buildGenericVoucherPostingRequest, supportsCentralGenericVoucher } from "./genericVoucherPosting";
export type { BuiltGenericVoucherPosting, GenericVoucherInput } from "./genericVoucherPosting";

export { buildPaymentReceiptPostingRequest } from "./paymentReceiptPosting";
export type {
  BuildPaymentReceiptPostingInput,
  BuiltPaymentReceiptPosting,
  PaymentReceiptLineInput,
  PaymentReceiptVoucherType,
} from "./paymentReceiptPosting";

export { buildCompanyTransferPostingRequest } from "./companyTransferPosting";
export type {
  BuildCompanyTransferPostingInput,
  BuiltCompanyTransferPosting,
  CompanyTransferSide,
  CompanyTransferVoucherType,
} from "./companyTransferPosting";

export { buildContainerSalePostingRequest } from "./containerSalePosting";
export type { BuildContainerSalePostingInput, BuiltContainerSalePosting } from "./containerSalePosting";

export { isPaymentReceiptVoucherType, shouldUseCentralPaymentReceiptDeletion } from "./paymentReceiptDeletionPolicy";
export type { PaymentReceiptDeletionPolicyInput } from "./paymentReceiptDeletionPolicy";

export {
  assertCustomerLinkedLedgerPairs,
  collectCustomerLedgerPairs,
  validateCustomerLedgerPairs,
} from "./customerLinkedLedgerValidation";
export type { CustomerLedgerOwnershipRow, CustomerLedgerPair } from "./customerLinkedLedgerValidation";

export { applyEmployeeBalanceDeltasTx, collectEmployeeBalanceDeltas } from "./employeeBalancePosting";
export type {
  EmployeeBalanceDelta,
  EmployeeBalanceDeltaCollection,
  EmployeeBalancePostingEntry,
} from "./employeeBalancePosting";

export { replaceVoucherTx, reverseVoucherTx, VoucherLifecycleError } from "./voucherLifecycleService";
export type {
  LifecycleResult,
  LifecycleVoucherSnapshot,
  ReplaceVoucherRequest,
  ReverseVoucherRequest,
  VoucherLifecycleAdapter,
  VoucherLifecycleState,
} from "./voucherLifecycleService";

export {
  reconcileTargetTx,
  reconcileTargetsTx,
  ReconciliationValidationError,
  validateReconciliationTarget,
} from "./partyReconciliationService";
export type {
  ReconciliationAdapter,
  ReconciliationBalance,
  ReconciliationBatchResult,
  ReconciliationDomain,
  ReconciliationResult,
  ReconciliationTarget,
} from "./partyReconciliationService";

export {
  CLOSED_PERIOD_GUARD_VERSION,
  closedPeriodErrorResponse,
  ensureClosedPeriodGuard,
  isClosedPeriodError,
} from "./closedPeriodGuard";

export {
  executeApprovedRepairsTx,
  generateReconciliationReportTx,
  ReconciliationRepairError,
} from "./reconciliationRepairService";
export type {
  ReconciliationRepairAdapter,
  ReconciliationReport,
  ReconciliationRunRequest,
  RepairActor,
  RepairDisposition,
  RepairExecutionRequest,
  RepairExecutionResult,
  RepairPlanItem,
} from "./reconciliationRepairService";
