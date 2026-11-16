// Extracted from ./NetProfitDetails.tsx to keep that module under the source-size cap.
import type { NotInLedgerSectionData } from "@/components/netposition/NotInLedgerCard";
import type { AccountItem, BreakdownItem } from "./netprofitdetails/NetPositionSidePanel";

export interface NetProfitData {
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  spPosProfit?: number;
  spPosProfitBaselineDate?: string | null;
  spPosProfitPeriodStartDate?: string | null;
  spPosProfitAsOfDate?: string | null;
  forUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  onUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  equity?: { total: number; accounts: AccountItem[] };
  income: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  expenses: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  netPosition: number;
  netPositionLabel: string;
  forUsTotal: number;
  onUsTotal: number;
  incomeTotal: number;
  expensesTotal: number;
  /** Amounts not yet in the ledger: shown separately, never in the totals. */
  notInLedger?: NotInLedgerSectionData;
  currency?: {
    rateConvention: string;
    nativeDebitByCurrency: Record<string, string>;
    nativeCreditByCurrency: Record<string, string>;
    historicalBaseDebitTotal: string;
    historicalBaseCreditTotal: string;
    unresolvedLegacyEntryCount: number;
    unresolvedLegacyRawNet: string;
    totalsProvisional: boolean;
  };
}

export function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}
