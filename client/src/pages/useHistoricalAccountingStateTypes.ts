// Extracted from ./useHistoricalAccountingState.tsx

type Row = {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  deleted: boolean;
};

type Voucher = {
  id: number;
  voucher_number: string;
  voucher_type: string;
  booked_on: string;
  created_on: string;
  deleted_on: string | null;
  currency: string;
  source_module: string | null;
  debit_base: string;
  credit_base: string;
  posted_now: boolean;
  late_created: boolean;
  later_retired: boolean;
};

export type Workpaper = {
  companyId: number;
  asOfDate: string;
  fromDate: string;
  businessDate: string;
  basis: string;
  balance: {
    balanced: boolean;
    unexplainedDifferenceUsd: string;
    openingSidesAssumed: number;
    totals: {
      openingDebit: string;
      openingCredit: string;
      periodDebit: string;
      periodCredit: string;
      closingDebit: string;
      closingCredit: string;
    };
    differenceComponents: {
      openingBalances: string;
      singleSidedStockVouchers: string;
      otherUnbalancedVouchers: string;
    };
    rows: Row[];
  };
  pnl: {
    incomeUsd: string;
    costOfSalesUsd: string;
    otherExpensesUsd: string;
    profitBeforeOtherEliminationsUsd: string;
    excludesClosingJournals: boolean;
    historicalAccountClassificationVerified: boolean;
  };
  postingEvidence: {
    totals: {
      documents: number;
      currentlyLive: number;
      lateCreated: number;
      retiredAfterDate: number;
      retiredBeforeDate: number;
      lateCreatedDebitsUsd: string;
      lateCreatedCreditsUsd: string;
      currentlyLiveDebitsUsd: string;
      currentlyLiveCreditsUsd: string;
    };
    documents: Voucher[];
    sampleLimit: number;
    truncated: boolean;
  };
  reconciliationEvidence: {
    items: Array<{
      source: string;
      total: number;
      recordedAfterAsOf: number;
      voidedCurrently: number;
      voidedAfterAsOf: number;
    }>;
    isPostingLedger: false;
  };
  sourceAvailability: Record<string, string>;
  reliability: {
    financialTotals: string;
    historicalKnowledgeAtDate: string;
    certified: false;
    blockers: string[];
    warnings: string[];
  };
  historicalFx: {
    ready: boolean;
    legacyCompatibilityMode: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    unresolvedLedgerOpeningCount: number;
    unresolvedBankOpeningCount: number;
    unresolvedCustomerOpeningCount: number;
    unresolvedSupplierOpeningCount: number;
    note: string;
    certified: false;
  };
};

export type Stock = {
  asOfDate: string;
  mode: string;
  report: { total: string; subLedgerTotal: string; excluded?: Record<string, unknown> };
  certified: false;
  caveats: string[];
};
