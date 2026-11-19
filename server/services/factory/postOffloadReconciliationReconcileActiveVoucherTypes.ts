// Extracted from ./postOffloadReconciliationReconcileActiveVoucher.ts

export type PostOffloadReconciliationStatus = "reconciled" | "repair_required" | "failed";

export interface PostOffloadReconciliationResult {
  status: PostOffloadReconciliationStatus;
  companyId: number;
  containerId: number;
  chargeId: number | null;
  accounting: {
    chargesChecked: number;
    activeVouchersChecked: number;
    voucherEntriesNormalized: number;
    daybookEntriesChecked: number;
    reversalsChecked: number;
    issues: string[];
  };
  inventory: {
    rawStockRowsChecked: number;
    containerCostPerKgUsd: string | null;
    issues: string[];
  };
  reports: {
    serverReadCacheInvalidated: boolean;
    derivedFromLiveCostTables: boolean;
    queryKeys: readonly string[];
  };
  undo: {
    required: boolean;
    available: boolean;
    undoLogId: number | null;
    fingerprint: string | null;
    alreadyUndone: boolean;
    issues: string[];
  };
  issues: string[];
}

export interface ChargeRow {
  id: number;
  amount: string;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  ledger_account_id: number | null;
  supplier_id: number | null;
  voucher_id: number | null;
  daybook_entry_id: number | null;
  reversal_daybook_entry_id: number | null;
  deleted_at: Date | null;
}

export interface VoucherRow {
  id: number;
  company_id: number;
  total_amount: string;
  currency: string;
  exchange_rate: string | null;
  source_module: string | null;
  deleted_at: Date | null;
}

export interface VoucherEntryRow {
  id: number;
  ledger_account_id: number | null;
  factory_supplier_id: number | null;
  debit_amount: string | null;
  credit_amount: string | null;
  transaction_debit_amount: string | null;
  transaction_credit_amount: string | null;
}

export interface DaybookRow {
  id: number;
  company_id: number;
  tx_type: string;
  reference_id: number | null;
  amount_currency: string | null;
  fx_rate_to_usd: string | null;
  amount_usd: string | null;
  meta_json: unknown;
}

export interface ReconciliationQueryClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
