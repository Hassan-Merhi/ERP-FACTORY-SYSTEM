// Extracted from ./GroupConsolidationAccounting.tsx to keep that module under the source-size cap.

interface Company {
  id: number;
  code: string;
  name: string;
  companyType: string;
  baseCurrency: string;
  parentCompanyId: number | null;
}

export interface CompanyList {
  companies: Company[];
  scope: string;
}

type FinancialRow = {
  companyId: number;
  companyName: string;
  companyCode: string;
  accountKind: string;
  accountId: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  financialClass: string;
  openingSideAssumed: boolean;
  bookedUsd: string;
  periodMovementUsd: string;
  eliminationUsd: string;
  adjustedUsd: string;
};

interface Pair {
  companyIds: number[];
  companyNames: string[];
  status: string;
  receivables: string;
  payables: string;
  matchedUsd: string;
  differenceUsd: string;
  appliedUsd: string;
  reason: string | null;
}

interface Elimination {
  pairCompanyIds: number[];
  debitCompanyId: number;
  debitAccountId: number;
  creditCompanyId: number;
  creditAccountId: number;
  amountUsd: string;
  narrative: string;
  posted: false;
}

export interface Consolidation {
  asOfDate: string;
  fromDate: string;
  currency: "USD";
  mode: "PROVISIONAL_LEDGER_CONSOLIDATION";
  companies: Array<
    Company & {
      companyId: number;
      companyName: string;
      companyCode: string;
      balances: number;
      historicalFxReady: boolean;
      unresolvedCurrencyCount: number;
    }
  >;
  rows: FinancialRow[];
  pairs: Pair[];
  eliminations: Elimination[];
  totals: {
    grossDebitUsd: string;
    grossCreditUsd: string;
    grossUnbalancedUsd: string;
    eliminationDebitUsd: string;
    eliminationCreditUsd: string;
    adjustedDebitUsd: string;
    adjustedCreditUsd: string;
    adjustedUnbalancedUsd: string;
    assetsUsd: string;
    liabilitiesUsd: string;
    equityUsd: string;
    periodIncomeUsd: string;
    periodCostOfSalesUsd: string;
    periodOperatingExpensesUsd: string;
    periodResultBeforeInternalSalesEliminationUsd: string;
    unmatchedIntercompanyUsd: string;
  };
  certification: {
    historicalFxResolved: boolean;
    unknownBalanceRows: number;
    unknownAmountUsd: string;
    unpairedOrMismatchedPairs: number;
    blockedEliminationPairs: number;
    bookBalanced: boolean;
    certified: false;
    blockers: string[];
  };
  policy: Record<string, string>;
}

interface Transfer {
  transferId: number;
  type: string;
  fromCompanyId: number;
  toCompanyId: number;
  transferDate: string;
  amountSourceUsd: string;
  fromVoucherId: number | null;
  toVoucherId: number | null;
  fromVoucherNumber: string | null;
  toVoucherNumber: string | null;
  sourceSideUsd: string | null;
  destinationSideUsd: string | null;
  status: string;
  explanation: string;
}

export interface TransferReport {
  rows: Transfer[];
  summary: { total: number; matched: number; flagged: number; truncated: boolean };
  policy: string;
}

export async function read<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Accounting report could not be loaded");
  return data as T;
}

export const label = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
