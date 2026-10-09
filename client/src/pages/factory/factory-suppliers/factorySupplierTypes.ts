import type { FactorySupplier } from "@shared/schema";
export type { BulkFxPreviewResult as BulkFxPreview } from "@/lib/bulkFxOffline";

export interface CurrencyBalance {
  currencyCode: string;
  balance: number;
  fxRateToUsd?: number;
}

export interface CurrencyGroup {
  currencyCode: string;
  containers: StatementEntry[];
  totalKg: string;
  totalValue: string;
  totalCommission: string;
  remainingCommission: string;
  totalDirectCommission: string;
  totalPaid: string;
  netPayable: string;
  totalOwed: string;
  totalFreight?: string;
  totalOtherCharges?: string;
  autoSettledFreight?: string;
}

/** Ledger view of a factory supplier (balance engine, wave 13): Cr positive = we owe. */
export interface FactorySupplierLedgerViewDto {
  supplierId: number;
  balanceBasis: "ledger";
  ledgerBalanceUsd: string;
  ledgerBalanceSide: "Cr" | "Dr";
  openingBalanceUsd: string;
  nativeBalances: Array<{
    currencyCode: string;
    debit: string;
    credit: string;
    balance: string;
    usdBalance: string;
    effectiveFxRateToUsd: string | null;
    legacyUnconvertedLines: number;
  }>;
  ledgerFxUnresolved: boolean;
  notInLedger: {
    label: string;
    total: string;
    unresolved: boolean;
    lines: Array<{
      source: string;
      sourceLabel: string;
      reference: string | null;
      sourceId: number;
      date: string;
      amount: string | null;
      nativeAmount: string;
      currency: string;
      label: string;
    }>;
  };
}

export interface SupplierWithBalance extends FactorySupplier {
  totalContainers: number;
  totalKg: string;
  /** Ledger balance (USD base, Cr positive) since wave 13; the operational figure is in operationalMemo. */
  totalValue: string;
  balanceBasis?: "ledger";
  notInLedgerTotal?: string;
  operationalMemo?: { label: string; totalValue: string; currencyBalances?: CurrencyBalance[]; fxUnresolved?: boolean };
  brokerPoolUsd?: string;
  pendingContainers: number;
  receivedContainers: number;
  lastContainerDate: string | null;
  currencyBalances?: CurrencyBalance[];
  totalCommissionUsd?: string;
  approxFxRate?: string | null;
  linkedSupplierExposure?: Array<{
    supplierId: number;
    supplierName: string;
    currencyBalances: CurrencyBalance[];
  }>;
  exposureCurrencyBalances?: CurrencyBalance[];
  otwByCurrency?: Record<string, number>;
}

export interface StatementEntry {
  id: number;
  containerNumber: string;
  date: string;
  origin: string | null;
  status: string;
  declaredKg: string | null;
  actualReceivedKg: string | null;
  totalKg: string | null;
  ratePerKg: string | null;
  differenceKg: string | null;
  value: string;
  finalPayableAmount: string | null;
  commissions: unknown[];
  totalCommission: string;
  notes: string | null;
}

export interface ObCommission {
  rawStockId: number;
  containerId: number;
  containerNumber: string;
  date: string;
  personName: string;
  amount: string;
  currencyCode: string;
  fxRateToUsd: string;
  amountUsd: string;
  ledgerAccountId: number | null;
}

export interface SupplierPayment {
  id: number;
  supplierId: number;
  date: string;
  amount: string;
  currencyCode: string;
  fxRateToUsd: string;
  amountUsd: string;
  paidFromAccountId: number | null;
  notes: string | null;
}

export interface FxTransfer {
  id: number;
  fromSupplierId: number;
  toSupplierId: number;
  fromSupplierName?: string;
  toSupplierName?: string;
  date: string;
  fromCurrencyCode: string;
  fromAmount: string;
  fxRateToUsd: string;
  toAmountUsd: string;
  notes: string | null;
  sourceType: string | null;
  containerRefs?: Array<{ containerNumber: string; allocatedAmount: string }>;
}

export interface StatementDisplayRow {
  key: string;
  date: string;
  type: "purchase" | "payment" | "fx" | "commission" | "freight";
  ref: string;
  detail?: string;
  amount: string;
  amountVal: number;
  rowCc: string;
  status?: string;
  optional?: boolean;
  amountIsNeg?: boolean;
  onMove?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}

export interface StatementResponse {
  supplier: FactorySupplier;
  statement: StatementEntry[];
  currencyGroups: CurrencyGroup[];
  obCommissions: ObCommission[];
  payments: SupplierPayment[];
  /** Not currently returned by the backend statement endpoint — kept optional so callers can safely no-op until it exists server-side. */
  voucherPayments?: unknown[];
  fxTransfers: FxTransfer[];
  linkedSupplierGroups: Array<{
    supplierId: number;
    supplierName: string;
    containerCount: number;
    lastActivity: string | null;
    currencyGroups: Array<{
      currencyCode: string;
      containers: unknown[];
      totalValue: string;
      totalCommission: string;
      totalPaid: string;
      netPayable: string;
      containerCount: number;
    }>;
  }>;
  summary: {
    totalContainers: number;
    totalKg: string;
    totalValue: string;
    totalCommissions: string;
    totalDirectCommissions: string;
    totalObCommissions: string;
    totalPayments: string;
    netPayable: string;
    totalOwed: string;
    ledgerBalance?: string;
    notInLedgerTotal?: string;
    operationalNetPayable?: string;
  };
  balanceBasis?: "ledger";
  ledgerView?: FactorySupplierLedgerViewDto & { lines?: unknown[] };
  operationalMemoLabel?: string;
}
