// Extracted from ./convergenceReconciliation.ts
import type { VoucherLedgerExpectation } from "./voucherLedgerExpectation";
import { type CompanyScopedReadTransaction } from "../security/transactionCompanyScope";

export interface AccountingConvergenceSnapshot {
  voucherId: number;
  companyId: number;
  voucherBaseDebit: string;
  voucherBaseCredit: string;
  ledgerBaseDebit: string;
  ledgerBaseCredit: string;
  daybookBaseAmount?: string | null;
  expectsDaybook: boolean;
  ledgerExpectation?: VoucherLedgerExpectation;
  voucherCancelled?: boolean;
}

export interface StockConvergenceSnapshot {
  sourceType: string;
  sourceId: string;
  companyId: number;
  documentQuantity: string;
  movementQuantity: string;
  documentValue: string;
  movementValue: string;
  /** Present for transfers: a stale false flag is a reportable discrepancy. */
  inventoryApplied?: boolean | null;
}

export interface ConvergenceReconciliationAdapter<TTransaction = CompanyScopedReadTransaction> {
  loadAccountingSnapshots(input: { tx: TTransaction; companyId: number }): Promise<AccountingConvergenceSnapshot[]>;
  loadStockSnapshots(input: { tx: TTransaction; companyId: number }): Promise<StockConvergenceSnapshot[]>;
}

export interface ConvergenceDiscrepancy {
  domain: "accounting" | "inventory";
  identity: string;
  code: string;
  expected: string;
  actual: string;
}

export interface ConvergenceReconciliationResult {
  companyId: number;
  accountingSnapshots: number;
  stockSnapshots: number;
  discrepancies: ConvergenceDiscrepancy[];
  clean: boolean;
}
