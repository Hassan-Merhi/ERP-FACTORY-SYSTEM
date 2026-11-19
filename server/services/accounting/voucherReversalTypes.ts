// Extracted from ./voucherReversal.ts
import type { VoucherWithEntries } from "./accountingTypes";
import { type PostingActor } from "./centralPostingEngine";
import { type CompanyScopedTransaction } from "../security/transactionCompanyScope";

/**
 * The immutable original voucher row, as locked inside the caller's
 * transaction. Only the fields an exact reversal inherits are named; the
 * loader may return further columns.
 */
export interface LockedVoucherRow {
  id: number | string;
  companyId: number | string;
  voucherType: string;
  voucherNumber?: string | null;
  totalAmount: string | number;
  deletedAt?: Date | string | null;
  locationId?: number | null;
  optional?: boolean | null;
  currency?: string | null;
  exchangeRate?: string | number | null;
  sourceModule?: string | null;
}

/** The immutable original entry row whose debit/credit sides are swapped. */
export interface LockedVoucherEntryRow {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  customerId?: number | null;
  factorySupplierId?: number | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  narration?: string | null;
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | number | null;
  transactionCreditAmount?: string | number | null;
  baseDebitAmount?: string | number | null;
  baseCreditAmount?: string | number | null;
  historicalExchangeRate?: string | number | null;
  rateConvention?: string | null;
}

export interface LockedVoucherForReversal extends VoucherWithEntries<LockedVoucherRow, LockedVoucherEntryRow> {
  isReversal?: boolean;
}

/**
 * Generic over the transaction handle so the PostgreSQL loader can be written
 * against the concrete drizzle transaction — and keep drizzle's own row typing —
 * while the reversal entry point below only requires a tenant-scoped handle.
 */
export interface VoucherReversalLoader<TTransaction = CompanyScopedTransaction> {
  loadOriginalForUpdate(input: {
    tx: TTransaction;
    companyId: number;
    voucherId: number;
  }): Promise<LockedVoucherForReversal | null>;
}

export interface ExactVoucherReversalRequest {
  companyId: number;
  originalVoucherId: number;
  reversalVoucherNumber: string;
  reversalDate: string;
  description?: string | null;
  actor?: PostingActor;
}
