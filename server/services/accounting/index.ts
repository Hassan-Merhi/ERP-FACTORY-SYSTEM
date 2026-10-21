/*
 * Central Accounting Service
 *
 * Re-exports the low-level compatibility helpers and the strict Program 2
 * posting, lifecycle, reconciliation, period-lock, and controlled repair
 * boundaries. New or migrated posting flows should use postBalancedVoucherTx
 * inside the transaction that owns the source document and mandatory inventory
 * or secondary-ledger effects. Every dated business write must call
 * assertPeriodOpenTx before its first write in that same transaction.
 */

export type { VoucherInsertFields, VoucherEntryInsertFields, VoucherWithEntries } from "./accountingTypes";

// Unified semantic accounting foundation (non-mutating, all three modules).
export {
  RENTAL_MODULE_ACCOUNTS,
  RENTAL_ACCOUNT_PREFIXES_BY_ROLE,
  RENTAL_POSTING_ACCOUNT_PREFIXES,
  ACCOUNTING_CONTROL_ACCOUNTS,
  financialStatementCategory,
  isRentalPostingAccountCode,
  describeAccountingPosting,
} from "./unifiedAccountingFoundation";
export type {
  AccountingDomain,
  RentalOriginModule,
  FinancialStatementCategory,
  AccountingPostingProvenance,
} from "./unifiedAccountingFoundation";

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

export { assertPeriodOpenTx, lockThroughTx, PeriodLockError } from "./periodLockService";
export type {
  ClosedPeriodOverride,
  PeriodLockActor,
  PeriodLockAdapter,
  PeriodLockRecord,
  PeriodLockScope,
  ProtectedDomain,
} from "./periodLockService";

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
