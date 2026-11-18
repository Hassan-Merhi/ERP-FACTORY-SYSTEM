// Extracted from ./goldenCoastPhase3Cutover.ts

export type GoldenCoastPhase3MoneyInput = string | number;

export type GoldenCoastPhase3CashAccount =
  { kind: "ledger"; id: number; name?: string } | { kind: "bank"; id: number; name?: string };

export interface GoldenCoastPhase3RoleAccounts {
  freshStartEquityAccountId: number;
  hassanEquityAccountId: number;
  hassanSavingsAccountId: number;
  gcSalesCashAccountId: number;
  stockOtwAccountId: number;
  stockInHandAccountId: number;
  containerReserveAccountId: number;
}

export interface GoldenCoastPhase3CutoverInput {
  companyId: number;
  stockOtwUsd: GoldenCoastPhase3MoneyInput;
  stockInHandUsd: GoldenCoastPhase3MoneyInput;
  containerReserveUsd: GoldenCoastPhase3MoneyInput;
  /**
   * Portion of Stock OTW supplied in-kind by Fresh Start. It is part of Fresh
   * Start's opening contribution and therefore must not consume Hassan's
   * $100,000 funding balance.
   */
  freshStartContributedStockOtwUsd?: GoldenCoastPhase3MoneyInput;
  /** Same rule for Fresh Start-contributed inventory already offloaded at cutover. */
  freshStartContributedStockInHandUsd?: GoldenCoastPhase3MoneyInput;
  gcSalesCashUsd?: GoldenCoastPhase3MoneyInput;
  /**
   * Compatibility assertion only. Phase 13 derives Hassan Savings from the
   * funding allocation. Supplying a different amount is rejected rather than
   * letting a caller create an extra liability on top of Hassan's $100,000.
   */
  hassanSavingsUsd?: GoldenCoastPhase3MoneyInput;
  cashAccount: GoldenCoastPhase3CashAccount;
  accounts: GoldenCoastPhase3RoleAccounts;
}

export interface GoldenCoastPhase3VoucherEntry {
  [key: string]: unknown;
  ledgerAccountId?: number;
  bankAccountId?: number;
  debitAmount: string;
  creditAmount: string;
  narration: string;
}

export interface GoldenCoastPhase3CutoverPlan {
  cutoverDate: string;
  voucherNumber: string;
  voucherType: "Journal";
  description: string;
  totalAmount: string;
  partnerEquityPerPartnerUsd: string;
  totalPartnerEquityUsd: string;
  stockOtwUsd: string;
  stockInHandUsd: string;
  containerReserveUsd: string;
  freshStartContributedStockOtwUsd: string;
  freshStartContributedStockInHandUsd: string;
  freshStartContributedInventoryUsd: string;
  freshStartResidualFundingUsd: string;
  cashFundedInventoryUsd: string;
  hassanFundingUsesUsd: string;
  hassanOpeningEquityUsd: string;
  gcSalesCashUsd: string;
  hassanSavingsUsd: string;
  openingCashUsd: string;
  profitPendingDistributionUsd: "0.00";
  entries: GoldenCoastPhase3VoucherEntry[];
}
