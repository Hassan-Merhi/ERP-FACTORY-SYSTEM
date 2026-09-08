/**
 * Golden Coast operations — shared frontend contracts.
 *
 * Endpoints, confirmation phrases, and readiness payload shapes for the
 * already-approved Phase 7/9/10/11 flows. Accounting rules stay server-owned:
 * nothing here derives a total, a split percentage, or an account mapping.
 */
export const PHASE7_READINESS = "/api/sp/golden-coast/phase7/sales-cash-transfer/readiness";
export const PHASE7_TRANSFER = "/api/sp/golden-coast/phase7/sales-cash-transfer";
export const PHASE9_READINESS = "/api/sp/golden-coast/phase9/hassan-savings-withdrawal/readiness";
export const PHASE9_WITHDRAWAL = "/api/sp/golden-coast/phase9/hassan-savings-withdrawal";
export const PHASE10_READINESS = "/api/sp/golden-coast/phase10/sales-cash-settlement/readiness";
export const PHASE10_SETTLEMENT = "/api/sp/golden-coast/phase10/sales-cash-settlement";
export const EQUITY_SALES_CASH_READINESS = "/api/sp/golden-coast/equity-sales-cash-settlement/readiness";
export const EQUITY_SALES_CASH_SETTLEMENT = "/api/sp/golden-coast/equity-sales-cash-settlement";
export const PHASE11_READINESS = "/api/sp/golden-coast/phase11/profit-splits/monthly-close/readiness";
export const PHASE11_CLOSE = "/api/sp/golden-coast/phase11/profit-splits/monthly-close";

export const HASSAN_SAVINGS_CONFIRMATION = "WITHDRAW HASSAN SAVINGS";
export const MONTHLY_CLOSE_CONFIRMATION = "FINALIZE SP PROFIT SPLIT";
export const EQUITY_SALES_CASH_CONFIRMATION = "SETTLE SALES CASH FROM EQUITY";

export const GOLDEN_COAST_TABS = ["overview", "hadi", "savings", "sales-cash", "monthly-close"] as const;
export type GoldenCoastTab = (typeof GOLDEN_COAST_TABS)[number];

export type CashAccountKind = "ledger" | "bank";
export type Phase7Operation = "collect_via_hadi" | "remit_from_hadi";

/** Query-key discriminator so a company switch cannot reuse another company's readiness. */
export type CompanyKey = number | string;

export interface CashAccountOption {
  kind: CashAccountKind;
  id: number;
  name: string;
  type?: string;
}

export interface Phase7Readiness {
  pair: {
    goldenCoastCompanyId: number;
    goldenCoastCompanyName: string;
    hadiCompanyId: number;
    hadiCompanyName: string;
  } | null;
  accounts: {
    gcSalesCashAccountId: number;
    gcSalesCashAccountName: string;
    goldenCoastHadiIntercompanyAccountId: number;
    goldenCoastHadiIntercompanyAccountName: string;
    hadiGoldenCoastIntercompanyAccountId: number;
    hadiGoldenCoastIntercompanyAccountName: string;
  } | null;
  balances: {
    /** Outstanding credit-normal GC Sales Cash payable; a collection raises it. */
    gcSalesCashPayableBalanceUsd: string;
    outstandingHadiCollectionsUsd: string;
  } | null;
  hadiCashAccounts: CashAccountOption[];
  goldenCoastCashAccounts: CashAccountOption[];
  blockers: string[];
  canTransfer: boolean;
}

export interface Phase9Readiness {
  ready: boolean;
  companyId: number;
  hassanSavingsAccount: { id: number; name?: string };
  availableSavingsUsd: string;
  paymentAccounts: CashAccountOption[];
  sourceType: string;
}

export interface Phase10Readiness {
  ready: boolean;
  companyId: number;
  gcSalesCashAccount: { id: number; name?: string };
  /** GC Sales Cash is credit-normal: this is what may still be paid down. */
  settleableSalesCashUsd: string;
  /** Outstanding payable, negative when GC Sales Cash has been overpaid. */
  rawSalesCashPayableBalanceUsd: string;
  /** Expense account a transfer fee is booked to; null when not configured. */
  sharedChargesAccount: { id: number; name: string } | null;
  receiptAccounts: CashAccountOption[];
  sourceType: string;
}

export interface EquitySalesCashReadiness {
  ready: boolean;
  companyId: number;
  gcSalesCashAccount: { id: number; name?: string };
  hassanEquityAccount: { id: number; name?: string };
  freshStartEquityAccount: { id: number; name?: string };
  /** Credit-normal payable still owed to Fresh Start, floored at zero. */
  payableSalesCashUsd: string;
  /** Credit-normal Hassan Dakik Equity balance available to settle from. */
  availableHassanEquityUsd: string;
  freshStartEquityUsd: string;
  /** One input drives both debits, so this is the lower of the two above. */
  maxSettlementUsd: string;
  sourceType: string;
}

export interface Phase11Plan {
  periodMonth: string;
  periodStart: string;
  periodEnd: string;
  totalRevenueUsd: string;
  totalCogsUsd: string;
  totalSharedChargesUsd: string;
  netProfitLossUsd: string;
  freshStartShareUsd: string;
  hassanShareUsd: string;
}

export interface Phase11Readiness {
  ready: boolean;
  alreadyClosed: boolean;
  plan?: Phase11Plan;
  splitPct?: string;
  profitPendingDistributionBalanceUsd?: string;
  split?: {
    periodMonth?: string;
    ourShare?: string;
    supplierShare?: string;
    finalizedAt?: string;
  };
}

export interface MutationResult {
  replayed?: boolean;
  voucher?: { id?: number; voucherNumber?: string };
}
